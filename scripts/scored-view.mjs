#!/usr/bin/env node

/**
 * scored-view.mjs — View ALL scored jobs (data/scored-jobs.tsv), ranked by score.
 *
 * Shows the full picture (QUALIFIED ≥4.3 / near 4.0–4.2 / pass <4.0) — unlike
 * `qualifiers` which shows only fresh ≥4.3. Powers `/career-finder scored`.
 *
 * Usage:  node scripts/scored-view.mjs [--min 4.0] [--plain]
 */

import { readFileSync, existsSync } from 'fs';

const F = 'data/scored-jobs.tsv';
const argv = process.argv.slice(2);
const min = (() => { const i = argv.indexOf('--min'); return i !== -1 ? parseFloat(argv[i + 1]) : 0; })();
const plain = argv.includes('--plain') || !process.stdout.isTTY;
const c = (code, s) => plain ? s : `${code}${s}\x1b[0m`;
const link = (u, t) => plain ? (t || u) : `\x1b]8;;${u}\x1b\\${t || u}\x1b]8;;\x1b\\`;
const W = 84, bar = '━'.repeat(W);

if (!existsSync(F)) { console.log('No scored jobs yet — run /career-finder speed or /career-finder discover.'); process.exit(0); }
const lines = readFileSync(F, 'utf-8').split('\n').filter(Boolean);
const I = Object.fromEntries(lines[0].split('\t').map((h, i) => [h, i]));
const rows = lines.slice(1).map(l => l.split('\t')).filter(r => r.length >= 4);

const byKey = new Map();
for (const r of rows) {
  const s = parseFloat(r[I.score]) || 0;
  if (s < min) continue;
  const k = r[I.url] || `${r[I.company]}::${r[I.role]}`;
  const p = byKey.get(k);
  if (!p || s > (parseFloat(p[I.score]) || 0)) byKey.set(k, r);
}
const list = [...byKey.values()].sort((a, b) => (parseFloat(b[I.score]) || 0) - (parseFloat(a[I.score]) || 0));
const color = s => s >= 4.3 ? '\x1b[1m\x1b[32m' : s >= 4.0 ? '\x1b[1m\x1b[33m' : '\x1b[2m';
const tag = s => s >= 4.3 ? 'QUALIFIED' : s >= 4.0 ? 'near     ' : 'pass     ';

console.log();
console.log(c('\x1b[1m\x1b[36m', `  SCORED JOBS  ·  ${list.length} roles${min ? `  ·  ≥ ${min}` : ''}`));
console.log(c('\x1b[90m', '  ' + bar));
for (const r of list) {
  const s = parseFloat(r[I.score]) || 0;
  console.log();
  console.log(`  ${c(color(s), s.toFixed(1) + '  ' + tag(s))}  ${c('\x1b[1m', r[I.company])} ${c('\x1b[90m', '—')} ${r[I.role]}`);
  if (r[I.why]) console.log(`        ${c('\x1b[2m', r[I.why])}`);
  if (r[I.url]) console.log(`        ${c('\x1b[36m', link(r[I.url]))}`);
}
console.log();
const q = list.filter(r => (parseFloat(r[I.score]) || 0) >= 4.3).length;
console.log(c('\x1b[90m', '  ' + bar));
console.log(c('\x1b[90m', `  ${list.length} scored · ${q} qualified (≥4.3) · src: ${F} · filter --min <score>`));
console.log();
