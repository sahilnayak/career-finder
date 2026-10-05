#!/usr/bin/env node

/**
 * near-miss-pool.mjs — emit the 3.8-4.2 near-miss pool for a full-JD re-read.
 *
 * WHY THIS EXISTS. `modes/_profile.md` has named this escalation step 1 since 2026-06-10 —
 * "full-JD re-read of every 3.8-4.2 near-miss from the last 24h", citing Learning Commons going
 * 3.8 -> 4.3 on a full-JD read — but nothing ever implemented it. The keep-search loop hunted
 * NET-NEW supply instead and wrote 0 rows on 40 of 41 rounds, while the near-miss pool sat
 * unread on disk. Snippet scoring systematically under-scores some role shapes; the full JD
 * is where the gates actually resolve.
 *
 * Emits TSV (company, role, url, score) for rows scored 3.8-4.2 inside the window that have NOT
 * been re-read since, skipping known non-employers (staffing/marketplace shells recorded in memory).
 *
 * Usage: node scripts/near-miss-pool.mjs [--days 7] [--primary-only]
 */

import { readFileSync, existsSync } from 'fs';
import { isPrimaryRole, loadTargets } from './targets.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; };
const DAYS = Number(val('--days', 7));
const PRIMARY_ONLY = argv.includes('--primary-only') || argv.includes('--se-only');

// Non-employers: recruiting marketplaces / staffing intermediaries with anonymous client reqs.
const NOT_EMPLOYERS = /^(recruitrookie|lensa)/i; // generic aggregators; extend via data/_speed-noise.txt
let QUALIFY = 4.3; try { QUALIFY = Number(loadTargets().pipeline.qualify_score) || 4.3; } catch {}
const isPrimary = (t) => { try { return isPrimaryRole(t); } catch { return false; } };

if (!existsSync('data/scored-jobs.tsv')) { process.exit(0); }
const cutoff = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const rows = readFileSync('data/scored-jobs.tsv', 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));

// A url that later appears with a >=4.3 score has already been promoted — don't re-read it.
const promoted = new Set(rows.filter(f => parseFloat(f[3]) >= QUALIFY).map(f => (f[6] || '').trim()));

const out = [];
const seen = new Set();
for (const f of rows) {
  const [date, co, role, score, , , url] = f;
  const s = parseFloat(score);
  if (!(s >= QUALIFY - 0.5 && s < QUALIFY)) continue;
  if (!date || date < cutoff) continue;
  if (!url || promoted.has(url.trim()) || seen.has(url.trim())) continue;
  if (NOT_EMPLOYERS.test(co || '')) continue;
  if (PRIMARY_ONLY && !isPrimary(role || '')) continue;
  seen.add(url.trim());
  out.push([co, role, url, score].join('\t'));
}
if (out.length) {
  console.log(['company', 'role', 'url', 'prior_score'].join('\t'));
  console.log(out.join('\n'));
}
console.error(`near-miss-pool: ${out.length} row(s) in the last ${DAYS}d${PRIMARY_ONLY ? ' (primary role only)' : ''}`);
