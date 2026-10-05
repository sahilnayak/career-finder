#!/usr/bin/env node
/**
 * next-report-num.mjs — the ONLY safe way to pick the next report/tracker number.
 *
 * WHY THIS EXISTS. On 2026-09-09 a report number was taken as `max(reports/*.md) + 1`, which
 * returned 1128. But row 1128 already existed in data/applications.md: a Mercor "Enterprise AI
 * Associate" row recorded the day before, with status Interview and no report file yet. The new
 * TSV therefore looked to merge-tracker.mjs like an UPDATE to that row, and silently overwrote a
 * live interview record with an unrelated job.
 *
 * The reports directory is NOT the high-water mark. A tracker row can exist without a report
 * (status-only rows, interviews logged before the write-up), so the number space is the UNION.
 * data/applications.md is gitignored, so an overwrite here is not recoverable from git; the only
 * reason the Mercor row came back is that its original TSV survived in
 * batch/tracker-additions/merged/.
 *
 * Usage:  node scripts/next-report-num.mjs        # prints the next safe number
 *         node scripts/next-report-num.mjs --why  # prints both maxima and the decision
 */
import { readFileSync, readdirSync, existsSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
let maxReport = 0;
try {
  for (const f of readdirSync(`${ROOT}reports`)) {
    const m = /^(\d+)/.exec(f);
    if (m) maxReport = Math.max(maxReport, Number(m[1]));
  }
} catch { /* no reports dir */ }

let maxTracker = 0;
const apps = `${ROOT}data/applications.md`;
if (existsSync(apps)) {
  for (const m of readFileSync(apps, 'utf8').matchAll(/^\|\s*(\d+)\s*\|/gm)) {
    maxTracker = Math.max(maxTracker, Number(m[1]));
  }
}

// Pending TSVs count too: they are numbers already claimed but not yet merged.
let maxPending = 0;
try {
  for (const f of readdirSync(`${ROOT}batch/tracker-additions`)) {
    const m = /^(\d+)/.exec(f);
    if (m) maxPending = Math.max(maxPending, Number(m[1]));
  }
} catch { /* none */ }

const next = Math.max(maxReport, maxTracker, maxPending) + 1;
if (process.argv.includes('--why')) {
  console.log(`max report file   : ${maxReport}`);
  console.log(`max tracker row   : ${maxTracker}`);
  console.log(`max pending TSV   : ${maxPending}`);
  console.log(`NEXT SAFE NUMBER  : ${next}`);
} else {
  // process.stdout.write, NOT console.log: console.log formats a Number with ANSI colour codes
  // when stdout is a TTY, and `N=$(node scripts/next-report-num.mjs)` then captures the escape
  // sequence into the filename. That produced reports/<ESC>[33m1132<ESC>[39m-ramp-... on
  // 2026-09-09, which verify-pipeline correctly reported as a broken report link.
  process.stdout.write(String(next) + '\n');
}
