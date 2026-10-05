#!/usr/bin/env node

/**
 * speed-metrics.mjs — Improvement loop for the speed-to-lead monitor.
 *
 * Log a cycle:   node scripts/speed-metrics.mjs <ats_found> <browser_found> <scored> <qualified> [note]
 * Analyze:       node scripts/speed-metrics.mjs --analyze
 *
 * Logs every speed cycle to data/speed-log.tsv. --analyze learns WHICH HOURS (local TZ)
 * actually produce fresh ≥4.3 posts, and after enough cycles banks a learning to
 * modes/scan-web.md so the loop can prioritize those windows (tighter cadence when
 * roles post, idle when they don't) — getting more efficient over time.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { TZ } from './scan-core.mjs';

const LOG = 'data/speed-log.tsv', LEARN = 'modes/scan-web.md';
const HEADER = 'ts\thour_pt\tats_found\tbrowser_found\tscored\tqualified\tnote';
const argv = process.argv.slice(2);

if (argv.includes('--analyze')) {
  if (!existsSync(LOG)) { console.log('No speed-log yet.'); process.exit(0); }
  const rows = readFileSync(LOG, 'utf-8').split('\n').filter(Boolean).slice(1).map(l => l.split('\t'));
  const cycles = rows.length;
  const withQ = rows.filter(r => (parseInt(r[5], 10) || 0) > 0);
  const byHour = {};
  for (const r of rows) { const h = r[1]; (byHour[h] ||= { c: 0, q: 0 }); byHour[h].c++; byHour[h].q += parseInt(r[5], 10) || 0; }
  const hot = Object.entries(byHour).filter(([, v]) => v.q > 0).sort((a, b) => b[1].q - a[1].q).map(([h, v]) => `${h}:00 (${v.q})`).slice(0, 4).join(', ');
  console.log(`cycles: ${cycles} | cycles with a qualifier: ${withQ.length} | qualifier-producing hours (local): ${hot || 'none yet'}`);
  if (cycles >= 20 && hot) {
    const today = new Date().toISOString().slice(0, 10);
    const md = readFileSync(LEARN, 'utf-8');
    if (!md.includes(`${today} (speed)`)) {
      const line = `- ${today} (speed): across ${cycles} speed cycles, fresh ≥4.3 posts cluster at hours ${hot} (${TZ}). Prioritize the browser supplement + tighter cadence in those windows; idle elsewhere to save cost.`;
      const m = 'newest first)\n'; const i = md.indexOf(m);
      if (i !== -1) { writeFileSync(LEARN, md.slice(0, i + m.length) + line + '\n' + md.slice(i + m.length)); console.log('Banked speed timing learning → modes/scan-web.md.'); }
    }
  }
  process.exit(0);
}

const [af = '0', bf = '0', sc = '0', q = '0', ...noteParts] = argv;
const now = new Date();
const hourPt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now);
if (!existsSync(LOG)) writeFileSync(LOG, HEADER + '\n');
appendFileSync(LOG, [now.toISOString(), hourPt, af, bf, sc, q, noteParts.join(' ')].join('\t') + '\n');
console.log(`logged speed cycle: ats=${af} browser=${bf} scored=${sc} qualified=${q} @ ${hourPt}:00 ${TZ}`);
