#!/usr/bin/env node

/**
 * prune-qualifiers.mjs — Keep data/qualifiers.tsv strictly to roles posted in the last 24h.
 *
 * Drops any row whose `posted` timestamp (fallback: `date`) is more than 24h old, so the
 * file only ever contains currently-fresh qualifiers. Exported pruneQualifiers() is reused
 * by qualifiers-view.mjs (prune-on-view) and called by the recurring pipeline each run.
 *
 * Usage:  node scripts/prune-qualifiers.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const QUAL = 'data/qualifiers.tsv';
const MAX_MS = 24 * 3600 * 1000;

export function pruneQualifiers(path = QUAL, now = Date.now()) {
  if (!existsSync(path)) return { dropped: 0, kept: 0 };
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  if (lines.length <= 1) return { dropped: 0, kept: 0 };
  const header = lines[0].split('\t');
  const I = Object.fromEntries(header.map((h, i) => [h, i]));
  const keep = [lines[0]];
  let dropped = 0;
  for (const l of lines.slice(1)) {
    const c = l.split('\t');
    const stamp = c[I.posted] || c[I.date] || '';
    const t = new Date(stamp).getTime();
    if (!isNaN(t) && (now - t) <= MAX_MS) keep.push(l);
    else dropped++;
  }
  if (dropped) writeFileSync(path, keep.join('\n') + '\n');
  return { dropped, kept: keep.length - 1 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = pruneQualifiers();
  console.log(`pruned ${r.dropped} stale (>24h); ${r.kept} remain`);
}
