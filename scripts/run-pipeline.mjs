#!/usr/bin/env node

/**
 * run-pipeline.mjs — One recurring, zero-token pass of the Bay-Area pipeline.
 *
 *   1. discover-companies.mjs   → grow data/company-index.tsv (curated + --from agent file + YC)
 *   2. scan-index.mjs --out     → sweep the index, write fresh candidates to data/_candidates.tsv
 *
 * Scoring (offer ≥4.3 → data/qualifiers.tsv) is the LLM step and is done by the
 * scheduled Claude agent / a local session — NOT here (node can't score).
 * This script is the autonomous, headless-safe half of the hybrid design.
 *
 * Recency: prefer a TRUE ROLLING window (--hours N) over calendar days. The day-level
 * predicate (--days 1) only matches a job whose *Pacific calendar date* equals today, so a
 * role posted yesterday evening (e.g. 13h ago) is invisible all of today even though it is
 * well within the 24h time-to-lead target. --hours uses a precise now-minus-N-hours cutoff.
 *
 * Usage:  node scripts/run-pipeline.mjs [--hours N | --days N]   (default: --hours 48)
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

// Recency window: --hours N (rolling, preferred) wins; else --days N; else default 48h rolling.
const hoursArg = (() => { const i = process.argv.indexOf('--hours'); return i !== -1 ? process.argv[i + 1] : null; })();
const daysArg = (() => { const i = process.argv.indexOf('--days'); return i !== -1 ? process.argv[i + 1] : null; })();
const windowArgs = hoursArg ? ['--hours', String(hoursArg)]
  : daysArg ? ['--days', String(daysArg)]
  : ['--hours', '48'];
const AGENT_FILE = 'data/_discovered-companies.tsv';
const CANDIDATES = 'data/_candidates.tsv';

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) console.error(`  (exited ${r.status})`);
  return r.status;
}

console.log(`=== run-pipeline ${new Date().toISOString()} (window=${windowArgs.join(' ')}) ===`);

// 1. Discovery — merge the background agent's findings if present.
const discoverArgs = ['scripts/discover-companies.mjs'];
if (existsSync(AGENT_FILE)) discoverArgs.push('--from', AGENT_FILE);
run('node', discoverArgs);

// 2. Zero-token sweep → candidates file (rolling-hours recency so evening-posted roles aren't lost).
run('node', ['scripts/scan-index.mjs', ...windowArgs, '--out', CANDIDATES]);

console.log(`\nDone. Next: score ${CANDIDATES} with the offer rubric (≥4.3) → data/qualifiers.tsv`);
console.log('(In a scheduled Claude run this scoring step happens automatically.)');
