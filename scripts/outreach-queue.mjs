#!/usr/bin/env node

/**
 * outreach-queue.mjs — the USER-SELECTION GATE for outreach.
 *
 * THE RULE (user-set 2026-07-25, supersedes the old "outreach is unskippable on >= qualify_score"
 * auto-fire): a qualifier does NOT get outreach just because it scored >= qualify_score. The user
 * picks which jobs are worth the LinkedIn spend, and only picked jobs are drafted.
 *
 *   - Cheap, headless steps (JD-mapped bullets) still run automatically for every
 *     qualifier, so a picked job is instantly ready to draft.
 *   - The expensive, risk-bearing steps (LinkedIn roster / people-search, email finding,
 *     HTML drafting) run ONLY for jobs in this queue. LinkedIn profile visits are capped
 *     at 40/day, so this is the gate that decides where that budget goes.
 *   - Unpicked qualifiers are NOT lost silently: `awaiting` lists them, and the
 *     SessionStart hook surfaces them so nothing ages out of the 24h window unseen.
 *
 * Selection normally happens in the dashboard (`w` on the Found panel). This script is
 * the same gate from the CLI, and the read API that outreach-owed.mjs / drain-outreach.mjs
 * consult before spending anything.
 *
 * Usage:
 *   node scripts/outreach-queue.mjs                       # list the queue (human)
 *   node scripts/outreach-queue.mjs list --json
 *   node scripts/outreach-queue.mjs awaiting              # >= qualify_score in window, not yet picked
 *   node scripts/outreach-queue.mjs awaiting --json
 *   node scripts/outreach-queue.mjs awaiting --count      # one line for the digest (read-only)
 *   node scripts/outreach-queue.mjs add --company "Acme" --role "Data Engineer" \
 *                                       [--url U] [--score 4.4] [--li-mode auto|roster|targeted]
 *   node scripts/outreach-queue.mjs done --company "Acme" --role "..."   # mark drafted
 *   node scripts/outreach-queue.mjs remove --company "Acme" --role "..." # un-pick
 *
 * Exit code is always 0 except on a usage error, so it never breaks a pipeline.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { requireTargets } from './targets.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const QUEUE = `${ROOT}data/outreach-queue.tsv`;
const PIPE = requireTargets().pipeline;
const THRESHOLD = Number(PIPE.qualify_score) || 4.3; // config pipeline.qualify_score
// Match the dashboard Found board: config pipeline.window_hours, so "awaiting" shows
// exactly what the user can still see and pick.
const WINDOW_H = Number(PIPE.window_hours) || 24;
const WINDOW_MS = WINDOW_H * 60 * 60 * 1000;

const HEADER = ['selected_at', 'company', 'role', 'score', 'url', 'li_mode', 'status', 'drafted_at'];

// ---- args ----
const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'list';
const has = f => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const asJson = has('--json');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const parseScore = s => parseFloat(String(s || '').replace('/5', '')) || 0;

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

function readQueue() { return readTsv(QUEUE); }

function writeQueue(rows) {
  const body = rows.map(r => HEADER.map(h => String(r[h] ?? '').replace(/\t/g, ' ')).join('\t'));
  writeFileSync(QUEUE, [HEADER.join('\t'), ...body].join('\n') + '\n');
}

// A queue row and a job refer to the same posting when the url matches exactly, or
// (no url on one side) company+role match. Bias to matching so we never double-queue.
function sameJob(a, b) {
  const au = (a.url || '').trim(), bu = (b.url || '').trim();
  if (au && bu) return au === bu;
  return norm(a.company) === norm(b.company) && norm(a.role) === norm(b.role);
}

/** Qualifiers (>= qualify_score, not pass/skip/dismissed) found inside the board window. */
function qualifiersInWindow() {
  const now = Date.now();
  const out = new Map();
  const ingest = rows => {
    for (const r of rows) {
      const company = r.company || '', role = r.role || '';
      if (!company || !role) continue;
      const score = parseScore(r.score);
      if (score < THRESHOLD) continue;
      const verdict = (r.verdict || '').toLowerCase();
      if (verdict === 'pass' || verdict === 'skip') continue;
      if ((r.dismissed_at || '').trim()) continue;
      if ((r.applied_at || '').trim()) continue;
      const foundAt = Date.parse(r.found_at || r.posted || r.date || '') || 0;
      if (foundAt && now - foundAt > WINDOW_MS) continue;
      const key = `${norm(company)}::${norm(role)}`;
      const prev = out.get(key);
      if (!prev || score > prev.score) out.set(key, { company, role, score, url: r.url || '', foundAt });
    }
  };
  ingest(readTsv(`${ROOT}data/scored-jobs.tsv`));
  ingest(readTsv(`${ROOT}data/qualifiers.tsv`));
  return [...out.values()].sort((a, b) => b.score - a.score);
}

// ---- commands ----

if (cmd === 'add') {
  const company = val('--company'), role = val('--role');
  if (!company || !role) {
    console.error('Usage: outreach-queue.mjs add --company "X" --role "Y" [--url U] [--score 4.4] [--li-mode auto|roster|targeted]');
    process.exit(2);
  }
  const liMode = val('--li-mode', 'auto');
  if (!['auto', 'roster', 'targeted'].includes(liMode)) {
    console.error(`--li-mode must be auto|roster|targeted (got "${liMode}")`);
    process.exit(2);
  }
  const rows = readQueue();
  const incoming = { company, role, url: val('--url') };
  const existing = rows.find(r => sameJob(r, incoming));
  if (existing) {
    if (existing.status === 'drafted') {
      // Re-picking an already-drafted job is a deliberate redraft request.
      existing.status = 'selected';
      existing.drafted_at = '';
      existing.selected_at = new Date().toISOString();
      writeQueue(rows);
      console.log(`re-queued for redraft: ${company} — ${role}`);
    } else {
      console.log(`already queued: ${company} — ${role} (${existing.li_mode || 'auto'})`);
    }
    process.exit(0);
  }
  // Backfill score/url from the ledger when the caller didn't pass them.
  const known = qualifiersInWindow().find(q => sameJob(q, incoming));
  rows.push({
    selected_at: new Date().toISOString(),
    company, role,
    score: val('--score') || (known ? known.score.toFixed(1) : ''),
    url: incoming.url || (known ? known.url : ''),
    li_mode: liMode,
    status: 'selected',
    drafted_at: '',
  });
  writeQueue(rows);
  console.log(`queued for outreach: ${company} — ${role}`);
  process.exit(0);
}

if (cmd === 'done' || cmd === 'remove') {
  const company = val('--company'), role = val('--role'), url = val('--url');
  if (!company && !url) {
    console.error(`Usage: outreach-queue.mjs ${cmd} --company "X" --role "Y"  (or --url U)`);
    process.exit(2);
  }
  const rows = readQueue();
  const target = { company, role, url };
  const row = rows.find(r => sameJob(r, target));
  if (!row) {
    console.log(`not in queue: ${company || url}`);
    process.exit(0);
  }
  if (cmd === 'done') {
    row.status = 'drafted';
    row.drafted_at = new Date().toISOString();
    writeQueue(rows);
    console.log(`marked drafted: ${row.company} — ${row.role}`);
  } else {
    writeQueue(rows.filter(r => r !== row));
    console.log(`removed from queue: ${row.company} — ${row.role}`);
  }
  process.exit(0);
}

if (cmd === 'awaiting') {
  const queued = readQueue();
  // Already-drafted jobs are not awaiting a decision even if they predate the queue file
  // (e.g. drafted under the old auto-fire rule) — check outreach-log.tsv too.
  const drafted = readTsv(`${ROOT}data/outreach-log.tsv`)
    .map(r => ({ company: r.company || '', role: r.role || '', url: (r.jd_url || '').trim() }))
    .filter(r => r.company);
  const awaiting = qualifiersInWindow()
    .filter(q => !queued.some(r => sameJob(r, q)))
    .filter(q => !drafted.some(d => sameJob(d, q)));
  if (has('--count')) { console.log(`OUTREACH AWAITING: ${awaiting.length}`); process.exit(0); }
  if (asJson) {
    process.stdout.write(JSON.stringify(awaiting, null, 2) + '\n');
    process.exit(0);
  }
  if (!awaiting.length) {
    console.log('OUTREACH SELECTION: 0 awaiting — every qualifier on the board has been picked or passed over.');
    process.exit(0);
  }
  console.log(`OUTREACH SELECTION: ${awaiting.length} qualifier(s) on the board with no outreach decision yet.`);
  console.log('These are NOT being drafted. Outreach spends the LinkedIn budget (40 profile visits/day), so it only runs on jobs you pick.\n');
  for (const j of awaiting) {
    const age = j.foundAt ? `${Math.round((Date.now() - j.foundAt) / 3.6e6)}h ago` : 'age unknown';
    console.log(`  ${j.score.toFixed(1)}  ${j.company} — ${j.role}   (found ${age})`);
    if (j.url) console.log(`        ${j.url}`);
  }
  console.log('\nPick in the dashboard with `w` on the Found panel, or tell the agent which ones to do outreach for.');
  console.log(`They drop off the board ${WINDOW_H}h after they were found, picked or not — that is by design, not a bug.`);
  process.exit(0);
}

// default: list
const rows = readQueue();
if (asJson) {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  process.exit(0);
}
if (!rows.length) {
  console.log('OUTREACH QUEUE: empty — nothing picked for outreach yet.');
  console.log('Run `node scripts/outreach-queue.mjs awaiting` to see the qualifiers you could pick.');
  process.exit(0);
}
const selected = rows.filter(r => r.status !== 'drafted');
const drafted = rows.filter(r => r.status === 'drafted');
console.log(`OUTREACH QUEUE: ${selected.length} awaiting draft, ${drafted.length} drafted.\n`);
for (const r of selected) {
  console.log(`  [selected] ${r.score || '?'}  ${r.company} — ${r.role}   (LinkedIn: ${r.li_mode || 'auto'})`);
}
for (const r of drafted) {
  console.log(`  [drafted]  ${r.score || '?'}  ${r.company} — ${r.role}`);
}
process.exit(0);
