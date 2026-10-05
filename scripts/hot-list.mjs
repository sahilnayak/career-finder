#!/usr/bin/env node

/**
 * hot-list.mjs — build the curated company set the 5-minute tier sweeps.
 *
 * WHY A TIER AT ALL. The full sweep is ~1,339 boards and takes minutes; running it
 * every 5 minutes would be both rude to those servers and pointless, because most of
 * them will never post a role this candidate wants. But time-to-lead is real: the
 * roles that qualify get 100+ applicants within a day. So a small, evidence-selected
 * subset gets polled hard, and everything else stays on the hourly sweep.
 *
 * WHO MAKES THE LIST — evidence, not vibes. A company is "hot" if it has actually
 * produced a near-or-above-bar role for this candidate before (any scored role >=
 * MIN_SCORE in data/scored-jobs.tsv). That is a far better predictor than "is it a
 * famous AI company", and it self-updates: as the ledger grows, the list re-derives.
 *
 * Rebuild it whenever the ledger has moved:
 *   node scripts/hot-list.mjs --build          # writes data/hot-companies.tsv
 *   node scripts/hot-list.mjs                  # show what the list would be
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const OUT = 'data/hot-companies.tsv';
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; };
const MIN_SCORE = Number(val('--min-score', 4.0));
const MAX = Number(val('--max', 150));
const WRITE = argv.includes('--build');

if (!existsSync('data/scored-jobs.tsv') || !existsSync('data/company-index.tsv')) {
  console.error('need data/scored-jobs.tsv and data/company-index.tsv');
  process.exit(1);
}

// Index companies, keyed lowercase, so the hot list can only ever name boards the
// sweep can actually fetch. A hot entry with no board is a silent no-op otherwise.
const indexed = new Map();
for (const line of readFileSync('data/company-index.tsv', 'utf8').split('\n').slice(1)) {
  const f = line.split('\t');
  if (f[0] && f[4]) indexed.set(f[0].toLowerCase().trim(), f[0].trim());
}

// Best score and most recent activity per company.
const best = new Map();
for (const line of readFileSync('data/scored-jobs.tsv', 'utf8').split('\n').slice(1)) {
  const f = line.split('\t');
  const co = (f[1] || '').trim();
  const score = parseFloat(f[3]);
  if (!co || !Number.isFinite(score)) continue;
  const key = co.toLowerCase();
  const prev = best.get(key);
  const seen = Date.parse(f[7] || f[0]) || 0;
  if (!prev || score > prev.score) best.set(key, { co, score, seen: Math.max(seen, prev?.seen || 0) });
  else if (seen > prev.seen) best.set(key, { ...prev, seen });
}

const hot = [...best.values()]
  .filter((x) => x.score >= MIN_SCORE)
  .filter((x) => indexed.has(x.co.toLowerCase()))
  .sort((a, b) => b.score - a.score || b.seen - a.seen)
  .slice(0, MAX);

const missing = [...best.values()].filter((x) => x.score >= MIN_SCORE && !indexed.has(x.co.toLowerCase()));

console.log(`hot list: ${hot.length} companies (score >= ${MIN_SCORE}, capped ${MAX})`);
for (const h of hot.slice(0, 12)) console.log(`  ${h.score.toFixed(1)}  ${h.co}`);
if (hot.length > 12) console.log(`  …and ${hot.length - 12} more`);

if (missing.length) {
  // These are the real coverage bugs: a company good enough to qualify that the sweep
  // cannot even fetch. Worth running probe-ats.mjs against.
  console.log(`\n${missing.length} qualifying employers are NOT in the index (sweep-invisible):`);
  for (const m of missing.slice(0, 10)) console.log(`  ✗ ${m.score.toFixed(1)}  ${m.co}`);
  console.log(`  -> node scripts/probe-ats.mjs --names "${missing.slice(0, 10).map((m) => m.co).join(',')}" --append`);
}

if (WRITE) {
  writeFileSync(OUT, 'company\tbest_score\n' + hot.map((h) => `${h.co}\t${h.score}`).join('\n') + '\n');
  console.log(`\nwrote ${hot.length} → ${OUT}`);
}
