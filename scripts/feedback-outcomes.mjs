#!/usr/bin/env node

/**
 * feedback-outcomes.mjs — Outcome feedback loop (the "gets smarter from results" layer).
 *
 *   1. SYNC: add any qualifier in data/qualifiers.tsv not yet tracked to
 *      data/qualifier-outcomes.tsv as `pending` (this store persists past the 24h prune).
 *   2. ANALYZE: response-rate by title-family / score-band / source over DECIDED rows.
 *   3. --learn: if >=5 decided outcomes, prepend a dated, data-driven learning to
 *      data/scan-web-learnings.md so future scoring/pre-filter uses real conversion signal.
 *
 * Usage:  node scripts/feedback-outcomes.mjs [--learn]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { ensureLearnings } from './lib/paths.mjs';
import { requireTargets, loadTargets, isPrimaryRole } from './targets.mjs';

requireTargets();

const QUAL = 'data/qualifiers.tsv', OUT = 'data/qualifier-outcomes.tsv', LEARN = ensureLearnings();
const HEADER = 'url\tcompany\trole\tscore\tsource\toutcome\tupdated';
const POSITIVE = new Set(['responded', 'interview', 'offer']);
const DECIDED = new Set(['responded', 'interview', 'offer', 'rejected']);
const today = new Date().toISOString().slice(0, 10);
const doLearn = process.argv.includes('--learn');

function rows(path) {
  if (!existsSync(path)) return { I: {}, data: [] };
  const L = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const I = Object.fromEntries(L[0].split('\t').map((h, i) => [h, i]));
  return { I, data: L.slice(1).map(l => l.split('\t')) };
}
// Title family = the configured target role the title matches (targets.roles in
// config/profile.yml), checked in order, so the primary role wins ties.
const ROLES = loadTargets().targets.roles.map(r => r.toLowerCase());
function family(role) {
  const r = (role || '').toLowerCase();
  if (isPrimaryRole(role)) return loadTargets().targets.primary_role;
  return ROLES.find(k => r.includes(k)) || 'other';
}

if (!existsSync(OUT)) writeFileSync(OUT, HEADER + '\n');

// 1. Sync new qualifiers → pending
let o = rows(OUT);
const have = new Set(o.data.map(r => r[o.I.url]));
const q = rows(QUAL);
const add = [];
for (const r of q.data) {
  const url = r[q.I.url];
  if (url && !have.has(url)) { add.push([url, r[q.I.company], r[q.I.role], r[q.I.score], r[q.I.source] || '', 'pending', today].join('\t')); have.add(url); }
}
if (add.length) appendFileSync(OUT, add.join('\n') + '\n');
o = rows(OUT);

// 1b. Ingest applications.md — the human source of truth for what you applied to.
//     The qualifiers feed prunes to 24h, so applied jobs older than a day never
//     reached this tracker. Pull every applied/decided row from applications.md and
//     append any not already tracked (dedup by company+role). Maps Status -> outcome.
const STATUS2OUT = { applied: 'applied', responded: 'responded', interview: 'interview', offer: 'offer', rejected: 'rejected' };
if (existsSync('data/applications.md')) {
  const normCR = (c, r) => `${c}|${r}`.toLowerCase().replace(/[^a-z0-9|]+/g, '');
  const seenCR = new Set(o.data.map(row => normCR(row[o.I.company], row[o.I.role])));
  const appAdd = [];
  for (const line of readFileSync('data/applications.md', 'utf-8').split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const c = line.split('|').map(s => s.trim());
    const [, num, , company, role, score, status] = c; // | # | Date | Company | Role | Score | Status | ...
    if (!num || num === '#' || /^-+$/.test(num)) continue;
    const out = STATUS2OUT[(status || '').toLowerCase()];
    if (!out || !company || !role) continue;            // only applied/decided rows
    const key = normCR(company, role);
    if (seenCR.has(key)) continue;
    seenCR.add(key);
    appAdd.push([`app://${key}`, company, role, score || '', 'applications', out, today].join('\t'));
  }
  if (appAdd.length) { appendFileSync(OUT, appAdd.join('\n') + '\n'); o = rows(OUT); }
}

// 2. Analyze decided
const byFam = {}; let decided = 0, pos = 0;
for (const r of o.data) {
  const oc = r[o.I.outcome];
  if (!DECIDED.has(oc)) continue;
  decided++; const f = family(r[o.I.role]);
  (byFam[f] ||= { pos: 0, tot: 0 }).tot++;
  if (POSITIVE.has(oc)) { byFam[f].pos++; pos++; }
}
const ranking = Object.entries(byFam).map(([f, v]) => `${f} ${Math.round(100 * v.pos / v.tot)}% (${v.pos}/${v.tot})`).join(', ');
const pending = o.data.filter(r => r[o.I.outcome] === 'pending').length;

console.log(`Outcome feedback — tracked: ${o.data.length} | new synced: ${add.length} | decided: ${decided} | positive: ${pos}`);
if (decided) console.log(`Response-rate by family: ${ranking}`);
console.log(`Pending your update: ${pending}.  Log with: node scripts/record-outcome.mjs <company|url> <applied|responded|interview|offer|rejected>`);

// 3. Bank a learning (data-driven), one per day max
if (doLearn) {
  if (decided >= 5) {
    const md = readFileSync(LEARN, 'utf-8');
    if (md.includes(`${today} (outcomes`)) { console.log('Outcome learning already banked today.'); }
    else {
      const sorted = Object.entries(byFam).filter(([, v]) => v.tot >= 2).sort((a, b) => (b[1].pos / b[1].tot) - (a[1].pos / a[1].tot));
      const top = sorted[0]?.[0], bot = sorted.at(-1)?.[0];
      const line = `- ${today} (outcomes N=${decided}): response-rate by family — ${ranking}.` + (top && bot && top !== bot ? ` Prioritize **${top}**, deprioritize **${bot}** in pre-filter/scoring.` : '');
      const marker = 'newest first)\n';
      const i = md.indexOf(marker);
      if (i !== -1) writeFileSync(LEARN, md.slice(0, i + marker.length) + line + '\n' + md.slice(i + marker.length));
      else appendFileSync(LEARN, '\n' + line + '\n');
      console.log(`Banked outcome learning → ${LEARN}.`);
    }
  } else console.log(`(--learn) Need >=5 decided outcomes to bank a learning (have ${decided}).`);
}
