#!/usr/bin/env node

/**
 * web-roles-learn.mjs — Closes the web-search learning loop.
 *
 * Joins every archived web find (data/_web-roles-history.tsv) to its scoring verdict
 * (data/scored-jobs.tsv, matched on URL) and measures which SOURCES and TITLES actually
 * produce qualifiers (score ≥ pipeline.qualify_score). It then banks ONE dated learning per day to
 * data/web-search-learnings.md — which the pipeline-cron web-search agent reads at the
 * top of its next run to re-target: prioritize high-yield sources/titles, drop dead ones,
 * prefer the company-shapes that scored. search → score → learn → re-search.
 *
 *   node scripts/web-roles-learn.mjs            # print the yield report + bank a learning if gated
 *   node scripts/web-roles-learn.mjs --no-bank  # report only, never write a learning
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { requireTargets } from './targets.mjs';

const PROFILE = requireTargets();
const QUALIFY = Number(PROFILE.pipeline.qualify_score);
const NEAR = Math.max(0, QUALIFY - 0.5);

const HISTORY = 'data/_web-roles-history.tsv';
const SCORED = 'data/scored-jobs.tsv';
const LEARN = 'data/web-search-learnings.md';
const MARKER = '## Learnings (newest first)\n';
const MIN_BANK = 12;   // need this many attributed finds before banking a learning
const MIN_DROP = 10;   // need this many finds in a bucket (with 0 qualifiers) to call a "drop"

const noBank = process.argv.includes('--no-bank');
const today = new Date().toISOString().slice(0, 10);

if (!existsSync(HISTORY)) { console.log('web-learn: no web-roles history yet — nothing to learn.'); process.exit(0); }

// Normalize a URL to a comparable key (strip protocol + query/hash + trailing slash).
const urlKey = u => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '').trim();

// Title → productive bucket: the configured target role it matches (longest first), else 'other'.
const ROLE_BUCKETS = [...PROFILE.targets.roles].map(String).filter(Boolean).sort((a, b) => b.length - a.length);
function bucket(role = '') {
  const r = role.toLowerCase();
  return ROLE_BUCKETS.find(b => r.includes(b.toLowerCase())) || 'other';
}

// Index scored jobs by URL key.
const scoredByUrl = new Map();
if (existsSync(SCORED)) {
  for (const line of readFileSync(SCORED, 'utf-8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    const url = c[6], score = parseFloat(c[3]);
    if (url) scoredByUrl.set(urlKey(url), { score: isNaN(score) ? null : score, verdict: (c[4] || '').trim() });
  }
}

// Walk history (dedup by URL), attribute a verdict to each web find.
const seen = new Set();
const bySource = new Map();   // source → {n, q, near}
const byTitle = new Map();    // bucket → {n, q, near}
const exemplars = [];         // companies of qualified web finds
let total = 0, attributed = 0, qualified = 0;

const bump = (map, key, kind) => {
  const o = map.get(key) || { n: 0, q: 0, near: 0 };
  o.n++; if (kind === 'q') o.q++; else if (kind === 'near') o.near++;
  map.set(key, o);
};

for (const line of readFileSync(HISTORY, 'utf-8').split('\n').slice(1)) {
  if (!line.trim()) continue;
  const [, company = '', role = '', , , url = '', source = ''] = line.split('\t');
  const key = urlKey(url);
  if (!key || seen.has(key)) continue;
  seen.add(key);
  total++;
  const hit = scoredByUrl.get(key);
  if (!hit) { bump(bySource, source || 'unknown', 'unknown'); bump(byTitle, bucket(role), 'unknown'); continue; }
  attributed++;
  const isQ = hit.verdict === 'QUALIFIED' || (hit.score != null && hit.score >= QUALIFY);
  const isNear = !isQ && hit.score != null && hit.score >= NEAR;
  const kind = isQ ? 'q' : isNear ? 'near' : 'pass';
  bump(bySource, source || 'unknown', kind);
  bump(byTitle, bucket(role), kind);
  if (isQ) { qualified++; if (company && !exemplars.includes(company)) exemplars.push(company); }
}

const fmt = map => [...map.entries()].sort((a, b) => b[1].q - a[1].q || b[1].n - a[1].n)
  .map(([k, v]) => `${k} ${v.q}/${v.n}`).join(', ');

console.log(`web-learn: ${total} web finds (${attributed} scored, ${qualified} qualified ≥${QUALIFY})`);
console.log(`  by source (q/n): ${fmt(bySource) || '—'}`);
console.log(`  by title  (q/n): ${fmt(byTitle) || '—'}`);
if (exemplars.length) console.log(`  qualifier exemplars: ${exemplars.slice(0, 8).join(', ')}`);

// Gate: enough attributed signal, not already banked today, banking enabled.
if (noBank) { console.log('  (--no-bank: not writing a learning)'); process.exit(0); }
if (attributed < MIN_BANK) { console.log(`  (need ${MIN_BANK} attributed to bank; have ${attributed})`); process.exit(0); }

let md = '';
try { md = readFileSync(LEARN, 'utf-8'); } catch { console.log('  (no learnings file)'); process.exit(0); }
if (md.includes(`${today} (web-learn)`)) { console.log('  (already banked today)'); process.exit(0); }

// Recommendations.
const prioSrc = [...bySource.entries()].filter(([, v]) => v.q > 0).sort((a, b) => b[1].q / b[1].n - a[1].q / a[1].n).map(([k]) => k);
const dropSrc = [...bySource.entries()].filter(([k, v]) => k !== 'unknown' && v.n >= MIN_DROP && v.q === 0).map(([k]) => k);
const prioTitle = [...byTitle.entries()].filter(([k, v]) => k !== 'other' && v.q > 0).sort((a, b) => b[1].q - a[1].q).map(([k]) => k);
const dropTitle = [...byTitle.entries()].filter(([k, v]) => k !== 'other' && v.n >= MIN_DROP && v.q === 0).map(([k]) => k);

const parts = [`${attributed} attributed web finds (${qualified} qualified).`];
parts.push(`SOURCES q/n: ${fmt(bySource)}.`);
if (prioSrc.length) parts.push(`Prioritize sources [${prioSrc.join(', ')}]${dropSrc.length ? `; deprioritize [${dropSrc.join(', ')}]` : ''}.`);
parts.push(`TITLES q/n: ${fmt(byTitle)}.`);
if (prioTitle.length) parts.push(`Prioritize titles [${prioTitle.join(', ')}]${dropTitle.length ? `; drop [${dropTitle.join(', ')}]` : ''}.`);
if (exemplars.length) parts.push(`Prefer this shape (qualifier exemplars): ${exemplars.slice(0, 6).join(', ')}.`);

const learning = `- ${today} (web-learn): ${parts.join(' ')}`;
const i = md.indexOf(MARKER);
if (i === -1) { console.log('  (learnings marker not found — not banking)'); process.exit(0); }
const at = i + MARKER.length;
// CAP THE FILE (2026-07-29). Every hourly web-search agent is told to read this file first.
// Unbounded appending grew it to 912 KB (~228k tokens) and re-reading it became the single largest
// token line item in the project. Keep only the newest MAX_ENTRIES attributions here and rotate the
// rest into the archive, which agents must never read.
const MAX_ENTRIES = 10;
const ARCHIVE = LEARN.replace(/\.md$/, '-archive.md');
const head = md.slice(0, at);
const tail = md.slice(at);
const tailLines = tail.split('\n');
const isEntry = l => /^- \d{4}-\d{2}-\d{2}/.test(l);
const entries = [learning, ...tailLines.filter(isEntry)];
const other = tailLines.filter(l => !isEntry(l) && l.trim());
const keep = entries.slice(0, MAX_ENTRIES);
const rotate = entries.slice(MAX_ENTRIES);
if (rotate.length) {
  const prev = existsSync(ARCHIVE) ? readFileSync(ARCHIVE, 'utf-8') : '# Web Search Learnings — ARCHIVE\n\nAgents must NOT read this file. It exists for human forensics only.\n';
  writeFileSync(ARCHIVE, prev.replace(/\n*$/, '\n') + rotate.join('\n') + '\n');
}
writeFileSync(LEARN, head + keep.join('\n') + '\n' + (other.length ? other.join('\n') + '\n' : ''));
console.log(`  ✅ banked learning → ${LEARN} (kept ${keep.length}, rotated ${rotate.length} to archive)`);
