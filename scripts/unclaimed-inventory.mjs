#!/usr/bin/env node

/**
 * unclaimed-inventory.mjs — re-verify qualifiers that aged off every surface, and list the
 * ones that are STILL OPEN and were never applied to. Zero LLM, zero browser.
 *
 * THE GAP THIS FILLS. Qualifiers age off the time-windowed surfaces (the dashboard board is
 * pipeline.window_hours by rule, daily-quota.mjs's fallback stops at 7 days), yet many are still
 * open and were never acted on. Re-verifying is a handful of JSON GETs against URLs already in
 * scored-jobs.tsv — far cheaper than finding the same number of NEW qualifiers.
 *
 * THIS IS NOT THE FOUND BOARD. Found answers "what appeared in the last window"; this answers
 * "what did we already pay to find, that is still open, that nobody acted on".
 *
 * Age is NOT a reason to skip a row here: an old ATS date means the req
 * was CREATED a while ago, not that they stopped hiring. The only disqualifier is the posting
 * being GONE, which is exactly what this script checks against the primary source.
 *
 * Usage:
 *   node scripts/unclaimed-inventory.mjs                 # primary role first, then other targets
 *   node scripts/unclaimed-inventory.mjs --primary-only
 *   node scripts/unclaimed-inventory.mjs --min-age-days 7 --min-score <pipeline.qualify_score>
 *   node scripts/unclaimed-inventory.mjs --json
 */

import { readFileSync, existsSync } from 'fs';
import { requireTargets, isPrimaryRole } from './targets.mjs';
import { tracked as trackedFetch } from './request-ledger.mjs'; // every outbound request is counted

const profile = requireTargets();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const PRIMARY_ONLY = has('--primary-only');
const JSON_OUT = has('--json');
const MIN_AGE = Number(val('--min-age-days', '7'));
const MIN_SCORE = Number(val('--min-score', String(profile.pipeline.qualify_score)));
const CONCURRENCY = Number(val('--concurrency', '8'));

// Same primary-role test daily-quota.mjs uses, so the two surfaces never disagree.
const archetype = (role = '') => (isPrimaryRole(role) ? 'primary' : 'other');

// ── statuses that mean "already handled"; those rows are not unclaimed ──
const handled = new Map();
if (existsSync('data/applications.md')) {
  for (const line of readFileSync('data/applications.md', 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map((s) => s.trim());
    if (p.length < 8) continue;
    const [, , , company, role, , status] = p;
    if (!company || company === 'Company') continue;
    handled.set(`${company}|${role}`.toLowerCase(), status);
  }
}
const DONE = new Set(['applied', 'interview', 'offer', 'rejected', 'responded', 'discarded', 'skip']);

const noise = existsSync('data/_never-apply.txt')
  ? new Set(readFileSync('data/_never-apply.txt', 'utf-8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean))
  : new Set();

// ── candidate set: >=MIN_SCORE, older than MIN_AGE, deduped by url ──
const cutoff = Date.now() - MIN_AGE * 864e5;
const seen = new Set();
const cands = [];
for (const line of (existsSync('data/scored-jobs.tsv') ? readFileSync('data/scored-jobs.tsv', 'utf-8') : '').split('\n').slice(1)) {
  if (!line.trim()) continue;
  const f = line.split('\t');
  if (f.length < 7) continue;
  const score = parseFloat(f[3]);
  if (!(score >= MIN_SCORE)) continue;
  const [date, company, role, , , why, url] = f;
  const foundAt = Date.parse(f[7] || date);
  if (!foundAt || foundAt >= cutoff) continue;           // still inside a live window; other surfaces own it
  if (!url || seen.has(url)) continue;
  seen.add(url);
  if (noise.has((company || '').trim().toLowerCase())) continue;
  const st = (handled.get(`${company}|${role}`.toLowerCase()) || '').toLowerCase();
  if (DONE.has(st)) continue;                            // already acted on
  const a = archetype(role);
  if (PRIMARY_ONLY && a !== 'primary') continue;
  cands.push({ company, role, score, url, why, archetype: a, foundAt,
               ageDays: Math.round((Date.now() - foundAt) / 864e5), status: st || 'untracked' });
}

// ── liveness against the employer's own ATS: the only thing that disqualifies a row ──
const apiFor = (url) => {
  let m;
  if ((m = url.match(/ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i)))
    return { kind: 'ashby', api: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, id: m[2] };
  if ((m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs\/(\d+)/i)))
    return { kind: 'greenhouse', api: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}` };
  if ((m = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)/i)))
    return { kind: 'greenhouse', api: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}` };
  if ((m = url.match(/lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i)))
    return { kind: 'lever', api: `https://api.lever.co/v0/postings/${m[1]}/${m[2]}` };
  return null;
};

async function liveness(c) {
  const t = apiFor(c.url);
  if (!t) return { ...c, live: 'unknown', reason: 'no ATS API for this url; verify by hand' };
  try {
    const r = await trackedFetch(t.api, { signal: AbortSignal.timeout(15000),
                                   headers: { 'user-agent': 'career-finder/unclaimed-inventory' } });
    if (!r.ok) return { ...c, live: 'closed', reason: `HTTP ${r.status}` };
    const j = await r.json();
    if (t.kind === 'ashby') {
      const hit = (j.jobs || []).some((x) => x.jobId === t.id || x.id === t.id);
      return { ...c, live: hit ? 'live' : 'closed', reason: hit ? 'on board' : 'delisted from board' };
    }
    if (j && j.error) return { ...c, live: 'closed', reason: String(j.error).slice(0, 40) };
    return { ...c, live: 'live', reason: 'posting resolves' };
  } catch (e) {
    return { ...c, live: 'unknown', reason: e.name };   // a timeout is NOT evidence of closure
  }
}

const results = [];
for (let i = 0; i < cands.length; i += CONCURRENCY) {
  results.push(...await Promise.all(cands.slice(i, i + CONCURRENCY).map(liveness)));
}

const RANK = { primary: 0, other: 1 };
const live = results.filter((r) => r.live === 'live')
  .sort((a, b) => RANK[a.archetype] - RANK[b.archetype] || b.score - a.score || a.ageDays - b.ageDays);
const unknown = results.filter((r) => r.live === 'unknown');
const closed = results.filter((r) => r.live === 'closed');

if (JSON_OUT) {
  console.log(JSON.stringify({ live, unknown, closed_count: closed.length }, null, 2));
} else {
  console.log(`\nUNCLAIMED INVENTORY — scored >=${MIN_SCORE}, older than ${MIN_AGE}d, never applied to,`);
  console.log(`re-verified against the employer's own ATS just now. NOT the 24h Found board.\n`);
  let last = null;
  for (const r of live) {
    if (r.archetype !== last) { console.log(`  ${r.archetype === 'primary' ? `${profile.targets.primary_role} (PRIMARY)` : 'Other target roles'}`); last = r.archetype; }
    console.log(`    ${r.score.toFixed(1)}  ${String(r.ageDays).padStart(3)}d  ${r.company} | ${r.role}`);
    console.log(`          ${r.url}`);
  }
  if (unknown.length) {
    console.log(`\n  UNVERIFIABLE (${unknown.length}) — no ATS API or the check errored. A timeout is NOT a closure; check by hand:`);
    for (const r of unknown.slice(0, 15)) console.log(`    ${r.score.toFixed(1)}  ${r.company} | ${r.role}  (${r.reason})`);
  }
  console.log(`\n  ${live.length} still open (${live.filter((r) => r.archetype === 'primary').length} primary), ${closed.length} closed, ${unknown.length} unverifiable, of ${cands.length} checked.`);
}
