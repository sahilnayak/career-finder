#!/usr/bin/env node

/**
 * outreach-owed.mjs — Reconcile SELECTED qualified jobs against drafted outreach.
 *
 * THE RULE (user-set 2026-07-25, supersedes the old auto-fire-on-qualify rule): scoring >= qualify_score
 * makes a job ELIGIBLE for outreach, not owed. The user picks which qualifiers are worth
 * the LinkedIn spend (dashboard `w`, or scripts/outreach-queue.mjs add) and only picked
 * jobs are owed. A job is owed when it is:
 *     (a) >= qualify_score and not pass/skip,  AND
 *     (b) present in data/outreach-queue.tsv with status != drafted,  AND
 *     (c) has no row in data/outreach-log.tsv yet.
 * Once picked, the guarantee is as strong as it ever was: the job stays owed and resurfaces
 * every run until it is actually drafted, so a picked job is never silently skipped (e.g.
 * when a session has no logged-in browser for contact discovery).
 *
 * Qualifiers the user has NOT picked are not owed and are not lost — see
 * `outreach-queue.mjs awaiting`, which the SessionStart hook surfaces.
 *
 * Usage:
 *   node scripts/outreach-owed.mjs            # human table; prints "OWED: N"
 *   node scripts/outreach-owed.mjs --json     # JSON array for piping into the outreach builder
 *   node scripts/outreach-owed.mjs --all      # ignore the selection gate (every >= qualify_score undrafted)
 *
 * Exit code is always 0 (so it never breaks a pipeline); read the OWED count / JSON length.
 */

import { readFileSync, existsSync } from 'fs';
import { requireTargets } from './targets.mjs';

const PIPE = requireTargets().pipeline;
const THRESHOLD = Number(PIPE.qualify_score) || 4.3; // config pipeline.qualify_score
const ROOT = new URL('..', import.meta.url).pathname;
const asJson = process.argv.includes('--json');
// --all bypasses the user-selection gate (diagnostics / "what could I pick?"), it does NOT
// re-enable auto-drafting: drain-outreach reads the gated list.
const ignoreGate = process.argv.includes('--all');

function readTsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (cells[i] ?? '').trim(); });
    return row;
  });
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const parseScore = s => parseFloat(String(s || '').replace('/5', '')) || 0;

// --- gather qualified (>= qualify_score) jobs from both sources, dedup by company+role ---
const qualified = new Map(); // key -> {company, role, score, url, source}
function ingest(rows, source) {
  for (const r of rows) {
    const company = r.company || '';
    const role = r.role || '';
    if (!company || !role) continue;
    const score = parseScore(r.score);
    if (score < THRESHOLD) continue;
    const verdict = (r.verdict || '').toLowerCase();
    if (verdict === 'pass' || verdict === 'skip') continue; // deliberate non-pursuit (duplicate/downgrade) outranks raw score
    const url = r.url || r.jd_url || '';
    const key = `${norm(company)}::${norm(role)}`;
    const prev = qualified.get(key);
    if (!prev || score > prev.score) qualified.set(key, { company, role, score, url, source });
  }
}
ingest(readTsv(`${ROOT}data/scored-jobs.tsv`), 'scored');
ingest(readTsv(`${ROOT}data/qualifiers.tsv`), 'qualifiers');

// --- index drafted outreach (company+role already covered) ---
const drafted = readTsv(`${ROOT}data/outreach-log.tsv`)
  .map(r => ({ c: norm(r.company), role: norm(r.role), url: (r.jd_url || '').trim() }))
  .filter(r => r.c);

// covered = same jd_url already drafted (exact req match, beats any name variance),
// OR some drafted row whose company matches (equal or prefix) AND role overlaps.
// Bias to NOT covered when unsure, so we never silently skip an owed job.
function isCovered(company, role, url) {
  const c = norm(company), rl = norm(role);
  return drafted.some(d => {
    if (url && d.url && d.url === url) return true;
    const companyMatch = d.c === c || d.c.startsWith(c) || c.startsWith(d.c);
    const roleMatch = d.role === rl || d.role.includes(rl) || rl.includes(d.role);
    return companyMatch && roleMatch;
  });
}

// --- the user-selection gate: only PICKED jobs are owed ---
// (data/outreach-queue.tsv, written by the dashboard `w` key or outreach-queue.mjs add)
const queue = readTsv(`${ROOT}data/outreach-queue.tsv`);
const picked = queue.filter(r => (r.status || 'selected') !== 'drafted');

function isPicked(company, role, url) {
  const c = norm(company), rl = norm(role);
  return picked.some(q => {
    const qu = (q.url || '').trim();
    if (url && qu) return qu === url;
    return norm(q.company) === c && norm(q.role) === rl;
  });
}

/** li_mode the user forced for this job, if any ('auto' when unset). */
function pickedMode(company, role, url) {
  const c = norm(company), rl = norm(role);
  const row = picked.find(q => {
    const qu = (q.url || '').trim();
    if (url && qu) return qu === url;
    return norm(q.company) === c && norm(q.role) === rl;
  });
  return (row && row.li_mode) || 'auto';
}

const eligible = [...qualified.values()]
  .filter(j => !isCovered(j.company, j.role, j.url))
  .sort((a, b) => b.score - a.score);

const owed = (ignoreGate ? eligible : eligible.filter(j => isPicked(j.company, j.role, j.url)))
  .map(j => ({ ...j, li_mode: pickedMode(j.company, j.role, j.url) }));

if (asJson) {
  process.stdout.write(JSON.stringify(owed, null, 2) + '\n');
  process.exit(0);
}

const awaiting = eligible.length - owed.length;

if (!owed.length) {
  if (ignoreGate) {
    console.log('OWED: 0  — every >= qualify_score qualified job has outreach drafted.');
  } else {
    console.log('OWED: 0  — every job you picked for outreach has been drafted.');
    if (awaiting > 0) {
      console.log('       Qualifiers on the board still awaiting your pick: node scripts/outreach-queue.mjs awaiting');
    }
  }
  process.exit(0);
}

console.log(`OWED: ${owed.length}  — you picked these >= ${THRESHOLD} jobs for outreach and they have NO drafts yet (do not skip):\n`);
for (const j of owed) {
  const mode = j.li_mode && j.li_mode !== 'auto' ? `  [LinkedIn: ${j.li_mode}]` : '';
  console.log(`  ${j.score.toFixed(1)}  ${j.company} — ${j.role}${mode}`);
  console.log(`        ${j.url || '(no url on file — fetch the posting before drafting)'}`);
}
if (!ignoreGate && awaiting > 0) {
  console.log('\n(More qualifiers are eligible but not picked — node scripts/outreach-queue.mjs awaiting)');
}
console.log(`\nNext: for each owed job, run the \`outreach\` mode (fetch JD from the url, find HM/recruiter/leader, draft JD-anchored gold/silver/bronze, log pending). Contact discovery needs the logged-in browser; if unavailable, the job stays owed and surfaces again.`);
process.exit(0);
