#!/usr/bin/env node

/**
 * qualifiers-view.mjs — Terminal viewer for qualified jobs.
 *
 * Reads data/qualifiers.tsv and shows ONLY roles scored >= --min (default 4.3),
 * deduped by URL, sorted by score. Links are clickable (OSC-8) in supporting
 * terminals. Powers `/career-finder qualifiers`.
 *
 * Usage:  node scripts/qualifiers-view.mjs [--min 4.3] [--plain]
 */

import { readFileSync, existsSync } from 'fs';
import { pruneQualifiers } from './prune-qualifiers.mjs';

const QUAL = 'data/qualifiers.tsv';
const argv = process.argv.slice(2);
const min = (() => { const i = argv.indexOf('--min'); return i !== -1 ? parseFloat(argv[i + 1]) : 4.3; })();
const plain = argv.includes('--plain') || !process.stdout.isTTY;

const c = (code, s) => plain ? s : `${code}${s}\x1b[0m`;
const link = (url, text) => plain ? (text || url) : `\x1b]8;;${url}\x1b\\${text || url}\x1b]8;;\x1b\\`;
const fmtAge = (ms) => { const h = ms / 36e5; return h < 1 ? `${Math.round(ms / 6e4)}m ago` : h < 24 ? `${Math.round(h)}h ago` : `${(h / 24).toFixed(1)}d ago`; };
const W = 80, bar = '━'.repeat(W);

if (!existsSync(QUAL)) { console.log('No qualifiers file yet. Run /career-finder discover to scan + score.'); process.exit(0); }

pruneQualifiers(QUAL); // keep the file strictly to last-24h roles before showing

const lines = readFileSync(QUAL, 'utf-8').split('\n').filter(Boolean);
const header = lines[0].split('\t');
const I = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = lines.slice(1).map(l => l.split('\t')).filter(r => r.length >= 6);

// Dedup by URL, keep highest score; filter to >= min.
const byUrl = new Map();
for (const r of rows) {
  const score = parseFloat(r[I.score]) || 0;
  if (score < min) continue;
  const prev = byUrl.get(r[I.url]);
  if (!prev || score > (parseFloat(prev[I.score]) || 0)) byUrl.set(r[I.url], r);
}
const list = [...byUrl.values()].sort((a, b) => (parseFloat(b[I.score]) || 0) - (parseFloat(a[I.score]) || 0));

console.log();
console.log(c('\x1b[1m\x1b[36m', `  QUALIFIED JOBS  ·  score ≥ ${min}  ·  last 24h  ·  ${list.length} role${list.length === 1 ? '' : 's'}`));
console.log(c('\x1b[90m', '  ' + bar));
if (!list.length) {
  console.log(c('\x1b[90m', '\n  (none yet — run /career-finder discover to scan + score)\n'));
  process.exit(0);
}
for (const [i, r] of list.entries()) {
  const score = parseFloat(r[I.score]);
  const sc = score >= 4.5 ? c('\x1b[1m\x1b[32m', score.toFixed(1)) : c('\x1b[1m\x1b[33m', score.toFixed(1));
  const rank = c('\x1b[90m', String(i + 1).padStart(2) + '.');
  console.log();
  const age = r[I.posted] ? ' · ' + fmtAge(Date.now() - new Date(r[I.posted]).getTime()) : '';
  console.log(`  ${rank}  ${sc}  ${c('\x1b[1m', r[I.company])} ${c('\x1b[90m', '—')} ${r[I.role]}  ${c('\x1b[90m', `[${r[I.source] || '-'}${age}]`)}`);
  if (r[I.why]) console.log(`        ${c('\x1b[2m', r[I.why])}`);
  console.log(`        ${c('\x1b[36m', link(r[I.url]))}`);
}
console.log();
console.log(c('\x1b[90m', '  ' + bar));
console.log(c('\x1b[90m', `  ${list.length} qualified · src: ${QUAL} · widen with --min <score>`));
console.log();
