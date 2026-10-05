#!/usr/bin/env node

/**
 * reconcile-qualifiers.mjs — keep data/qualifiers.tsv honest against the canonical
 * scored ledger (data/scored-jobs.tsv), which is what the dashboard's Found panel reads.
 *
 * WHY: qualifiers.tsv is fed by snippet scans (scan-se / scan-index) that score from a
 * LinkedIn/board card; pipeline-cron later re-scores the SAME job from the canonical JD.
 * The two can disagree, so a job can sit in qualifiers.tsv at >=4.3 while the canonical
 * re-score put it below 4.3 — a false positive the dashboard correctly hides, leaving the
 * two views out of sync. This step reconciles them every pipeline cycle.
 *
 * For each qualifiers.tsv row, find its canonical row in scored-jobs.tsv (match by job-id
 * in the URL, fallback company+role) and classify:
 *   CONFIRMED  canonical score >=4.3 (not pass/skip)  -> keep; backfill found_at if missing.
 *   DEMOTED    canonical is NEWER-or-equal AND <4.3    -> drop from qualifiers (false positive).
 *   RESCORE    canonical match is OLDER than the card  -> keep, flag: needs a fresh canonical score.
 *   ORPHAN     no canonical row at all                 -> backfill a scored-jobs row (found_at =
 *                                                         posted) so the dashboard can surface it.
 *
 * The dashboard reads scored-jobs.tsv, so CONFIRMED/ORPHAN make it show every true qualifier
 * with a precise timestamp; DEMOTED stops phantom qualifiers; RESCORE marks the ambiguous ones.
 *
 * Usage:  node scripts/reconcile-qualifiers.mjs [--dry]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

const QUAL = 'data/qualifiers.tsv';
const SCORED = 'data/scored-jobs.tsv';
const LOG = 'data/_qualifiers-reconcile.log';
const DRY = process.argv.includes('--dry');

const normCompany = s => String(s || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|co|ai)\b/g, '').replace(/[^a-z0-9]+/g, '');
const normRole = s => String(s || '').toLowerCase().replace(/[(),/-]/g, ' ').replace(/\s+/g, ' ').trim();
const ts = s => { const t = new Date(s).getTime(); return isNaN(t) ? 0 : t; };

// Pull a stable job id out of an ATS/LinkedIn URL: gh_jid, Ashby UUID, Lever/Workday id,
// or the trailing numeric/slug id on a LinkedIn /view/ link. Used for cross-file matching.
function jobId(url = '') {
  const u = String(url);
  const gh = u.match(/gh_jid=(\d+)/i); if (gh) return gh[1];
  const ash = u.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (ash) return ash[0].toLowerCase();
  const li = u.match(/(\d{6,})\/?(?:\?|$)/); if (li) return li[1];
  return '';
}

function parseTsv(path) {
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const header = lines[0].split('\t');
  const I = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  return { header, I, rows: lines.slice(1).map(l => l.split('\t')), raw: lines.slice(1) };
}

if (!existsSync(QUAL) || !existsSync(SCORED)) {
  console.log('reconcile-qualifiers: missing qualifiers.tsv or scored-jobs.tsv; nothing to do.');
  process.exit(0);
}

const q = parseTsv(QUAL);
const s = parseTsv(SCORED);
const sI = s.I;

// Index every scored row by job-id and by company|role, keeping the LATEST canonical row.
const scoredById = new Map();
const scoredByCR = new Map();
for (const r of s.rows) {
  const url = r[sI.url] || '';
  const company = r[sI.company] || '';
  const role = r[sI.role] || '';
  const score = parseFloat((r[sI.score] || '').match(/[\d.]+/)?.[0] ?? '');
  const verdict = (r[sI.verdict] || '').toLowerCase();
  const stamp = ts(r[sI.found_at] || r[sI.date]);
  const rec = { score: isNaN(score) ? null : score, verdict, stamp, raw: r };
  const id = jobId(url);
  const cr = `${normCompany(company)}|${normRole(role)}`;
  if (id) { const p = scoredById.get(id); if (!p || stamp >= p.stamp) scoredById.set(id, rec); }
  const p2 = scoredByCR.get(cr); if (!p2 || stamp >= p2.stamp) scoredByCR.set(cr, rec);
}

const findCanonical = (url, company, role) =>
  scoredById.get(jobId(url)) || scoredByCR.get(`${normCompany(company)}|${normRole(role)}`) || null;

const keep = [q.header.join('\t')];
const orphanRows = [];     // scored-jobs lines to append
const backfillFoundAt = []; // {url, posted} for CONFIRMED rows missing found_at
const actions = [];
let confirmed = 0, demoted = 0, rescore = 0, orphan = 0;

for (const r of q.rows) {
  const company = r[q.I.company], role = r[q.I.role], url = r[q.I.url];
  const qScore = parseFloat((r[q.I.score] || '').match(/[\d.]+/)?.[0] ?? '');
  const postedTs = ts(r[q.I.posted] || r[q.I.date]);
  const why = r[q.I.why] || '';
  const m = findCanonical(url, company, role);

  if (!m) {
    // ORPHAN — never canonically scored; surface it in the dashboard via a scored-jobs row.
    orphan++; keep.push(r.join('\t'));
    const foundAt = r[q.I.posted] || new Date().toISOString();
    orphanRows.push([
      r[q.I.date] || new Date().toISOString().slice(0, 10),
      company, role, isNaN(qScore) ? '-' : qScore.toFixed(1),
      'QUALIFIED', (why || 'from qualifiers.tsv (no canonical row)').replace(/\t/g, ' '),
      url, foundAt, '',
    ].join('\t'));
    actions.push(`ORPHAN    ${company} | ${role} -> backfilled scored-jobs (found_at=${foundAt})`);
    continue;
  }

  const passlike = m.verdict === 'pass' || m.verdict === 'skip';
  if (m.score != null && m.score >= 4.3 && !passlike) {
    confirmed++; keep.push(r.join('\t'));
    if (!(m.raw[sI.found_at] || '').trim() && r[q.I.posted]) backfillFoundAt.push({ url, posted: r[q.I.posted], company, role });
    actions.push(`CONFIRMED ${company} | ${role} (canonical ${m.score})`);
  } else if (m.stamp >= postedTs) {
    // canonical re-score is newer (or same age) and below the bar -> genuine false positive.
    demoted++;
    actions.push(`DEMOTED   ${company} | ${role} (canonical ${m.score ?? '-'} ${m.verdict}, newer than card) -> removed`);
  } else {
    // canonical match is older than the card -> stale; needs a fresh canonical score.
    rescore++; keep.push(r.join('\t'));
    actions.push(`RESCORE   ${company} | ${role} (canonical ${m.score ?? '-'} is stale @ ${new Date(m.stamp).toISOString().slice(0,10)}) -> kept, needs re-score`);
  }
}

const summary = `reconcile-qualifiers: confirmed ${confirmed}, demoted ${demoted}, orphan-backfilled ${orphan}, needs-rescore ${rescore}`;

if (DRY) {
  console.log('[dry run]\n' + actions.map(a => '  ' + a).join('\n') + '\n' + summary);
  process.exit(0);
}

// Apply: rewrite qualifiers.tsv (false positives removed), append orphan scored-jobs rows,
// backfill found_at on confirmed rows that lacked one, and log the cycle.
if (demoted) writeFileSync(QUAL, keep.join('\n') + '\n');
if (orphanRows.length) appendFileSync(SCORED, orphanRows.join('\n') + '\n');
if (backfillFoundAt.length) {
  let sc = readFileSync(SCORED, 'utf-8').split('\n');
  for (const b of backfillFoundAt) {
    for (let i = 1; i < sc.length; i++) {
      const f = sc[i].split('\t');
      if ((f[sI.url] || '') === b.url || (normCompany(f[sI.company]) === normCompany(b.company) && normRole(f[sI.role]) === normRole(b.role))) {
        while (f.length < 9) f.push('');
        if (!f[sI.found_at].trim()) { f[sI.found_at] = b.posted; sc[i] = f.join('\t'); }
        break;
      }
    }
  }
  writeFileSync(SCORED, sc.join('\n'));
}

const stamp = new Date().toISOString();
appendFileSync(LOG, `=== ${stamp} ===\n${actions.map(a => '  ' + a).join('\n')}\n${summary}\n`);
console.log(summary);
if (rescore) console.log(`  ${rescore} flagged for re-score — see ${LOG}`);
