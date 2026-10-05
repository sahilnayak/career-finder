#!/usr/bin/env node

/**
 * rotate-logs.mjs — cap the append-only pipeline logs.
 *
 * WHY THIS EXISTS (2026-08-20). Nothing has ever rotated these files. Every cron lane appends
 * (`>> $PLOG`) and no step trims, so they grow without bound: measured at cleanup time,
 * data/_hot.log was 4.2 MB (the 5-minute tier writes ~288 times a day) and data/_pipeline.log
 * 720 KB. That is a real cost on two axes — an agent that greps or tails a multi-megabyte log
 * burns context on it, and the files are pure noise in every directory listing.
 *
 * Rotation, not deletion: the tail is what anyone debugging actually wants ("what did the last
 * few runs do?"), and the older history is gzipped beside it rather than dropped, so a
 * post-mortem can still reach it. A .gz of a text log is ~5% of the original.
 *
 * Idempotent and cheap: a file already under its line cap is left untouched, so this is safe to
 * call at the end of every cron run.
 *
 * Usage:  node scripts/rotate-logs.mjs [--quiet]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'fs';
import { gzipSync } from 'zlib';

const QUIET = process.argv.includes('--quiet') || process.env.CAREER_OPS_QUIET === '1';
const ARCHIVE = 'data/archive/logs';

// keepLines: how much tail stays live in the file. The hot tier writes ~2 lines per 5-minute
// cycle, so 2000 lines is roughly the last three days — enough to debug a bad night.
const LOGS = [
  { path: 'data/_hot.log', keepLines: 2000 },
  { path: 'data/_pipeline.log', keepLines: 2000 },
  { path: 'data/_qualifiers-reconcile.log', keepLines: 500 },
  { path: 'data/_speed-cron.log', keepLines: 500 },
];

function rotate({ path, keepLines }) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n');
  if (lines.length <= keepLines) return null;           // under the cap — nothing to do

  const before = statSync(path).size;
  const cut = lines.length - keepLines;
  const older = lines.slice(0, cut).join('\n');
  const keep = lines.slice(cut).join('\n');

  // Append the trimmed history to a single per-log gzip rather than making a new file each
  // run — one growing .gz beats a directory of hundreds of fragments.
  mkdirSync(ARCHIVE, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.split('/').pop().replace(/^_/, '');
  appendFileSync(`${ARCHIVE}/${base}.${stamp}.gz`, gzipSync(older + '\n'));

  writeFileSync(path, keep, 'utf-8');
  return { path, before, after: statSync(path).size, trimmed: cut };
}

const kb = n => `${(n / 1024).toFixed(0)}KB`;
let any = false;
for (const spec of LOGS) {
  const r = rotate(spec);
  if (!r) continue;
  any = true;
  if (!QUIET) console.log(`rotated ${r.path}: ${kb(r.before)} → ${kb(r.after)} (${r.trimmed} lines archived)`);
}
if (!any && !QUIET) console.log('rotate-logs: all logs under cap, nothing to do');
