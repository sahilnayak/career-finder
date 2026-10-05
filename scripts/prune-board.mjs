#!/usr/bin/env node

/**
 * prune-board.mjs — auto-dismiss ≥4.3 qualifiers older than the 24h board window.
 *
 * THE RULE (user-set 2026-06-22, reaffirmed 2026-07-27): the dashboard shows ONLY jobs
 * found in the last 24h. An empty Found board stays empty.
 *
 * The UI already enforces that on DISPLAY (`QualifiersInWindow` with a 24h window, and the
 * Live Leads fallback disabled in jobs.go). This script enforces it in the DATA, by stamping
 * `dismissed_at` (col 10 of scored-jobs.tsv) on qualifiers that have aged past the window.
 * Same column and RFC3339 format the dashboard's own MarkDismissed writes — but an OPTIONAL
 * 11th column records `aged`, so an auto-prune IS distinguishable from a hand dismissal.
 *
 * Why the marker exists (added 2026-07-27): `daily-quota.mjs`'s LIVE FALLBACK (the
 * "empty board -> keep searching" rule) surfaces the freshest live >=4.3 qualifier of a
 * missing archetype from the last 7d. It excludes dismissed rows — correctly, a job the
 * user waved off should not come back. But this pruner dismissed every qualifier the moment
 * it crossed 24h, so the 7-day fallback pool was ALWAYS empty and the rule could never fire.
 * The marker lets the fallback tell "aged out of the board window" (still a live lead worth
 * surfacing, flagged >24h) from "the user decided no" (gone for good). The dashboard reads
 * col 10 only and ignores extra columns, so its strict 24h board is unaffected.
 *
 * Why both: display filtering hides an aged job, but it stays "undecided" forever in the
 * ledger, so every consumer that reads the file (and any dashboard build with a different
 * window) can resurface it. Stamping makes the decision durable.
 *
 * NEVER touches:
 *   - applied jobs (col 9 applied_at set) — those are a permanent record, not a fresh lead
 *   - already-dismissed rows
 *   - pass/skip verdicts (never on the board to begin with)
 * Rows are never deleted; scored-jobs.tsv stays a full history.
 *
 * Usage: node scripts/prune-board.mjs [--hours 24] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const HOURS = Number(val('--hours', 24)) || 24;
const DRY = argv.includes('--dry-run');
const MIN_SCORE = 4.3;
const PATH = 'data/scored-jobs.tsv';

if (!existsSync(PATH)) { console.error(`${PATH} not found`); process.exit(1); }

const now = Date.now();
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const lines = readFileSync(PATH, 'utf-8').split('\n');
const cleared = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const f = line.split('\t');
  if (f.length < 7) continue;

  const score = parseFloat(f[3]);
  if (!(score >= MIN_SCORE)) continue;
  const verdict = String(f[4] || '').toLowerCase();
  if (verdict === 'pass' || verdict === 'skip') continue;

  while (f.length < 11) f.push('');
  if (f[8]) continue;   // applied — leave it
  if (f[9]) continue;   // already dismissed

  // found_at (col 8) is the discovery time; fall back to the date column.
  // Freshest of the two: a found_at holding an old ATS claim must not age out a row scored today.
  const tf = Date.parse(f[7] || ''), td = Date.parse(f[0] ? `${f[0]}T12:00:00` : '');
  if (isNaN(tf) && isNaN(td)) continue;
  const t = Math.max(isNaN(tf) ? 0 : tf, isNaN(td) ? 0 : td);
  const ageH = (now - t) / 3600e3;
  if (ageH <= HOURS) continue;

  cleared.push({ age: Math.round(ageH), score, company: f[1], role: f[2] });
  // col 11 = dismissal REASON. 'aged' means "left the 24h board window", NOT "user said no" —
  // daily-quota's live fallback may still surface it (flagged >24h, never re-stamped fresh).
  if (!DRY) { f[9] = stamp; f[10] = 'aged'; lines[i] = f.join('\t'); }
}

if (!DRY && cleared.length) writeFileSync(PATH, lines.join('\n'));

if (!cleared.length) {
  console.log(`board: nothing to prune — no undecided >=${MIN_SCORE} qualifier older than ${HOURS}h.`);
} else {
  console.log(`board: ${DRY ? 'would dismiss' : 'dismissed'} ${cleared.length} qualifier(s) older than ${HOURS}h`);
  for (const c of cleared.slice(0, 10)) console.log(`  ${c.age}h  ${c.score}  ${c.company} — ${c.role}`);
  if (cleared.length > 10) console.log(`  ...and ${cleared.length - 10} more`);
}
