#!/usr/bin/env node

/**
 * build-catalog.mjs — generate data/INDEX.md: ONE referenceable row per job, joining the
 * structured files so everything is a single lookup away (no RAG needed).
 *
 * Joins (by normalized company + role):
 *   data/applications.md  -> the canonical record: #, date, score, status, report link, notes
 *   data/scored-jobs.tsv  -> verdict, JD url, found_at / applied_at (speed-loop output)
 *   data/outreach-log.tsv -> outreach package (html), personas drafted, sent state
 *
 * Output: data/INDEX.md — a summary header + a table sorted by score desc, with clickable
 * links to each job's report, outreach package, and JD posting.
 *
 * Usage:  node scripts/build-catalog.mjs           # write data/INDEX.md
 *         node scripts/build-catalog.mjs --print    # also print a terminal summary
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { loadTargets } from './targets.mjs';
const QUALIFY = (() => { try { return loadTargets().pipeline.qualify_score; } catch { return 4.3; } })();

const PRINT = process.argv.includes('--print');

// ---- helpers ----
const stripParen = s => s.replace(/\s*\([^)]*\)/g, '').trim();
const normCompany = s => stripParen(String(s || '')).toLowerCase()
  .replace(/\b(inc\.?|llc|ltd|corp\.?|corporation|technologies|technology|group|co\.?)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const normRole = s => String(s || '').toLowerCase().replace(/[,/()\-]/g, ' ').replace(/\s+/g, ' ').trim();
const key = (c, r) => `${normCompany(c)}|${normRole(r)}`;
const parseScore = s => { const m = String(s || '').match(/(\d+\.?\d*)/); return m ? parseFloat(m[1]) : 0; };
const trunc = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };

function normStatus(raw) {
  const s = String(raw || '').replace(/\*\*/g, '').toLowerCase().trim();
  if (/no aplicar|^skip|geo blocker/.test(s)) return 'SKIP';
  if (/interview|entrevista/.test(s)) return 'Interview';
  if (/offer|oferta/.test(s)) return 'Offer';
  if (/responded|respondido/.test(s)) return 'Responded';
  if (/applied|aplicad|enviada|sent/.test(s)) return 'Applied';
  if (/rejected|rechaz/.test(s)) return 'Rejected';
  if (/discarded|descartad|cerrada|cancelada|dup/.test(s)) return 'Discarded';
  if (/evaluated|evaluad|hold|monitor|condicional/.test(s)) return 'Evaluated';
  return raw ? raw.trim() : '—';
}
const STATUS_RANK = { Interview: 0, Offer: 1, Responded: 2, Applied: 3, Evaluated: 4, '—': 5, SKIP: 6, Rejected: 7, Discarded: 8 };

// ---- parse applications.md (canonical record) ----
function parseApplications() {
  const path = existsSync('data/applications.md') ? 'data/applications.md' : 'applications.md';
  if (!existsSync(path)) return [];
  const rows = [];
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    let line = raw.trim();
    if (!line.startsWith('|') || /^\|\s*#/.test(line) || /^\|[-\s|]+$/.test(line)) continue;
    line = line.replace(/^\|/, '').replace(/\|$/, '');
    const f = (line.includes('\t') ? line.split('\t') : line.split('|')).map(x => x.trim());
    if (f.length < 8 || !/^\d+$/.test(f[0])) continue;
    const rep = (f[7] || '').match(/\[(\d+)\]\(([^)]+)\)/);
    rows.push({
      num: parseInt(f[0], 10), date: f[1], company: f[2], role: f[3],
      score: parseScore(f[4]), status: normStatus(f[5]),
      reportPath: rep ? rep[2] : '', notes: f[8] || '',
    });
  }
  return rows;
}

// ---- parse scored-jobs.tsv ----
function parseScored() {
  const m = new Map();
  if (!existsSync('data/scored-jobs.tsv')) return m;
  const lines = readFileSync('data/scored-jobs.tsv', 'utf-8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (f.length < 7) continue;
    m.set(key(f[1], f[2]), { verdict: f[4], why: f[5], url: f[6], foundAt: f[7] || '', appliedAt: f[8] || '', score: parseScore(f[3]) });
  }
  return m;
}

// ---- parse outreach-log.tsv (dedup to package per company+role) ----
function parseOutreach() {
  const m = new Map();
  if (!existsSync('data/outreach-log.tsv')) return m;
  const lines = readFileSync('data/outreach-log.tsv', 'utf-8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (f.length < 8) continue;
    const k = key(f[1], f[2]);
    const html = f[7], jd = f[6], sent = (f[8] || '').toLowerCase();
    const e = m.get(k) || { html: '', jd: '', personas: 0, sent: false };
    if (html && !e.html) e.html = html;
    if (jd && !e.jd) e.jd = jd;
    e.personas += 1;
    if (sent && sent !== 'pending' && sent !== 'hold') e.sent = true;
    m.set(k, e);
  }
  return m;
}

// ---- join ----
const apps = parseApplications();
const scored = parseScored();
const outreach = parseOutreach();

const rows = apps.map(a => {
  const k = key(a.company, a.role);
  const s = scored.get(k);
  const o = outreach.get(k);
  return {
    ...a,
    verdict: s?.verdict || (a.score >= QUALIFY ? 'QUALIFIED' : a.score >= 4.0 ? 'near' : ''),
    url: s?.url || o?.jd || '',
    outreachHtml: o?.html || '',
    outreachPersonas: o?.personas || 0,
    outreachSent: o?.sent || false,
    appliedAt: s?.appliedAt || '',
  };
});

rows.sort((x, y) => (y.score - x.score) || ((STATUS_RANK[x.status] ?? 9) - (STATUS_RANK[y.status] ?? 9)) || x.company.localeCompare(y.company));

// ---- emit data/INDEX.md ----
const byStatus = {};
let nQual = 0, nReport = 0, nOutreach = 0;
for (const r of rows) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  if (r.score >= QUALIFY) nQual++;
  if (r.reportPath) nReport++;
  if (r.outreachHtml) nOutreach++;
}
const statusLine = Object.entries(byStatus).sort((a, b) => (STATUS_RANK[a[0]] ?? 9) - (STATUS_RANK[b[0]] ?? 9)).map(([k, v]) => `${k} ${v}`).join(' · ');
const now = new Date().toISOString();

const link = (text, target) => target ? `[${text}](${target})` : '·';
const out = [];
out.push('# Job Catalog (INDEX)');
out.push('');
out.push('> Auto-generated by `scripts/build-catalog.mjs` — one referenceable row per job, joining');
out.push('> `applications.md` + `scored-jobs.tsv` + `outreach-log.tsv`. Regenerate: `/career-finder catalog`.');
out.push('');
out.push(`**Generated:** ${now}`);
out.push(`**Total:** ${rows.length} jobs · **Qualifiers (≥${QUALIFY}):** ${nQual} · **With report:** ${nReport} · **With outreach:** ${nOutreach}`);
out.push(`**By status:** ${statusLine}`);
out.push('');
out.push('| Score | Status | Company | Role | Report | Outreach | JD |');
out.push('|------:|--------|---------|------|:------:|:--------:|:--:|');
for (const r of rows) {
  const score = r.score ? r.score.toFixed(1) : '·';
  const flag = r.score >= QUALIFY ? '🟢' : r.score >= 4.0 ? '🟡' : '';
  const rep = link(r.reportPath ? `#${r.num}` : '', r.reportPath);
  const otr = r.outreachHtml ? link(`${r.outreachPersonas}p${r.outreachSent ? '✓' : ''}`, r.outreachHtml) : '·';
  const jd = link(r.url ? 'link' : '', r.url);
  out.push(`| ${flag}${score} | ${r.status} | ${trunc(r.company, 28)} | ${trunc(r.role, 42)} | ${rep} | ${otr} | ${jd} |`);
}
out.push('');
writeFileSync('data/INDEX.md', out.join('\n'));

console.log(`Wrote data/INDEX.md — ${rows.length} jobs (${nQual} qualifiers, ${nReport} with reports, ${nOutreach} with outreach).`);
if (PRINT) {
  console.log(`By status: ${statusLine}`);
  console.log('\nTop 12 by score:');
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${(r.score || 0).toFixed(1)}  ${r.status.padEnd(10)} ${trunc(r.company, 22).padEnd(22)} ${trunc(r.role, 38)}${r.reportPath ? '  [report]' : ''}${r.outreachHtml ? '  [outreach]' : ''}`);
  }
}
