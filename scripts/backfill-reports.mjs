#!/usr/bin/env node

/**
 * backfill-reports.mjs — ensure every job in data/scored-jobs.tsv has a report
 * in reports/. Jobs missing one get a compact auto-generated report built from
 * the scored data (score / verdict / why / url), clearly marked as
 * snippet-scored so it is never confused with a full A-G evaluation.
 *
 * Matching mirrors gen-outreach.mjs findReport: company slug, slug head,
 * hyphen-squashed slug, plus alias squashes ("Acme Compute Company"
 * matches "acmecompute" via initial-word compression).
 *
 * Dedup: one report per company+role (highest score row wins).
 * Numbering: sequential, max existing + 1 (repo convention).
 *
 * Usage: node scripts/backfill-reports.mjs [--dry-run]
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { requireTargets } from './targets.mjs';

const DRY = process.argv.includes('--dry-run');
// Artifacts are usually produced AFTER the stub (the résumé and JD snapshot come later in the same
// cycle), so a stub written first records `❌` forever. --refresh re-resolves the JD/PDF lines on
// EXISTING auto-generated stubs. It only ever touches files that carry the backfill provenance
// marker — a hand-written A–G report is never rewritten.
const REFRESH = process.argv.includes('--refresh');
// SCORE FLOOR (added 2026-08-24). Without one this stubbed EVERY scored row — 842 files on the
// first real run, most of them for `pass`/`stale`/`SKIP` jobs that will never be applied to. That
// buries reports/ and renumbers the sequence into the thousands for no benefit. A report only has
// to exist for jobs the board can surface, i.e. >= the qualifier bar.
const minIdx = process.argv.indexOf('--min');
const MIN = minIdx > -1 && process.argv[minIdx + 1] ? Number(process.argv[minIdx + 1]) : requireTargets().pipeline.qualify_score;
// Verdicts that can never reach the board, regardless of score.
const DEAD = /^(pass|stale|SKIP)$/i;
const today = new Date().toISOString().slice(0, 10);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// A report is the drill-in for a job, so it has to POINT AT the other two artifacts. The first
// version hard-coded `**PDF:** ❌` and had no JD line at all — so a job with a résumé and a JD
// snapshot on disk still showed neither, which reads as "nothing was produced for this job".
// Both are resolved by filename slug the same way the dashboard resolves them.
const lsSafe = (d) => { try { return readdirSync(d); } catch { return []; } };
const CAND = slug(requireTargets().candidate?.full_name || 'candidate');
const RESUME_PREFIX = new RegExp(`^cv-${CAND}-`);
const RESUMES = lsSafe('output').filter(f => RESUME_PREFIX.test(f) && f.endsWith('.pdf'));
const JDS = lsSafe('data/jds').filter(f => f.endsWith('.md'));

function findArtifact(files, company, role, prefixStrip) {
  const co = slug(company);
  const roleHead = slug(role).split('-').slice(0, 3).join('-');
  const forCompany = [];
  let roleMatch = '';
  for (const f of files) {
    const rest = prefixStrip ? f.replace(prefixStrip, '') : f;
    if (!rest.startsWith(co + '-')) continue;
    forCompany.push(f);
    const tail = rest.slice(co.length + 1);
    if (roleHead && tail.startsWith(roleHead)) roleMatch = f;   // newest wins by sort order
  }
  if (roleMatch) return roleMatch;
  // A COMPANY-ONLY fallback is safe ONLY when that company has exactly one artifact. Paradigm runs
  // Deployed Engineer AND Deployment Strategist; falling back linked the Strategist report to the
  // Engineer's résumé. A WRONG artifact link is worse than a missing one — it sends you into an
  // interview holding the other role's CV. When the company is ambiguous, return nothing.
  return forCompany.length === 1 ? forCompany[0] : '';
}
const findResume = (c, r) => findArtifact(RESUMES.slice().sort(), c, r, RESUME_PREFIX);
const findJd = (c, r) => findArtifact(JDS.slice().sort(), c, r, null);
const squash = s => s.replace(/-/g, '');

const reports = readdirSync('reports').filter(f => /^\d+-.+\.md$/.test(f));
const repSlugs = reports.map(f => f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, ''));
let nextNum = Math.max(0, ...reports.map(f => parseInt(f, 10)).filter(Number.isFinite)) + 1;

function hasReport(company) {
  const cs = slug(company);
  const variants = new Set([cs, cs.split('-')[0], squash(cs)]);
  // alias form: leading words compressed to initials + last word ("san-francisco-compute-company" -> "sfcompute"-ish)
  const words = cs.split('-');
  if (words.length > 2) {
    variants.add(words.map((w, i) => (i < words.length - 1 ? w[0] : w)).join(''));
    variants.add(words.slice(0, -1).map(w => w[0]).join('') + words[words.length - 1]);
    for (let k = 2; k < words.length; k++) variants.add(words.map((w, i) => (i < k ? w[0] : w)).join(''));
  }
  // PREFIX MATCH, because two filename conventions live in reports/:
  //   old: {num}-{company}-{date}.md          -> repSlug "greptile"
  //   new: {num}-{company}-{role}-{date}.md   -> repSlug "greptile-customer-engineer"
  // Only the old form ever equalled the company slug, so every report written under the NEW
  // convention was invisible here and the job got re-stubbed on every run. Measured 2026-08-26:
  // Greptile, Condor and Lightwheel had FOUR stubs each, one per backfill run that day, alongside
  // the real evaluation. Making this idempotent is the fix; the cleanup of existing duplicates is
  // separate.
  return repSlugs.some(s => variants.has(s) || variants.has(squash(s)) ||
    [...variants].some(v => s === v || s.startsWith(`${v}-`) ||
      squash(s) === squash(v) || squash(s).startsWith(squash(v)) ||
      squash(s) === v.replace(/company$/, '')));
}

const rows = readFileSync('data/scored-jobs.tsv', 'utf8').trim().split('\n').slice(1)
  .map(l => l.split('\t'))
  .map(([date, company, role, score, verdict, why, url]) => ({ date, company, role, score, verdict, why, url }));

// dedup company+role, keep highest score (then latest date)
const byKey = new Map();
for (const r of rows) {
  const k = `${slug(r.company)}|${slug(r.role)}`;
  const prev = byKey.get(k);
  if (!prev || Number(r.score) > Number(prev.score) || (r.score === prev.score && r.date > prev.date)) byKey.set(k, r);
}

let created = 0, skipped = 0;
let skippedLow = 0;
for (const r of byKey.values()) {
  if (!(Number(r.score) >= MIN) || DEAD.test(String(r.verdict || '').trim())) { skippedLow++; continue; }
  if (hasReport(r.company)) { skipped++; continue; }
  // Filename carries the ROLE, matching the hand-written A-G convention
  // (1019-hatch-sales-engineer-2026-08-21.md). Without it an employer running two reqs produced two
  // indistinguishable stubs, and anything matching by filename could not tell them apart.
  const roleSlug = slug(r.role).split('-').slice(0, 4).join('-');
  const file = `reports/${String(nextNum).padStart(3, '0')}-${slug(r.company)}${roleSlug ? '-' + roleSlug : ''}-${today}.md`;
  const body = `# ${r.company} — ${r.role}

**Score:** ${r.score}/5 (${r.verdict || 'scored'})
**URL:** ${r.url || 'n/a'}
**JD:** ${findJd(r.company, r.role) ? `data/jds/${findJd(r.company, r.role)}` : '— not snapshotted'}
**PDF:** ${findResume(r.company, r.role) ? `output/${findResume(r.company, r.role)}` : '❌ not generated'}
**Legitimacy:** Unverified (auto-backfilled)

## Summary

${r.why || 'No scoring rationale recorded.'}

## Provenance

- Scored ${r.date} by the speed-loop/scan pipeline (snippet scoring) with verdict **${r.verdict || 'n/a'}**.
- This report was auto-generated by \`scripts/backfill-reports.mjs\` on ${today} so every scored job has a referenceable report.
- It is NOT a full A–G evaluation: no CV-match, comp, or legitimacy verification was performed. For the full treatment run \`/career-finder offer ${r.url || '{url}'}\`.
`;
  if (!DRY) writeFileSync(file, body);
  console.log(`${DRY ? '[dry] ' : ''}created ${file}  (${r.score} ${r.verdict || ''} ${r.company} — ${r.role})`);
  nextNum++;
  created++;
}
// ── --refresh: re-resolve JD/PDF on stubs written before those artifacts existed ──────────────
let refreshed = 0;
if (REFRESH) {
  for (const r of byKey.values()) {
    if (!(Number(r.score) >= MIN) || DEAD.test(String(r.verdict || '').trim())) continue;
    const co = slug(r.company);
    // Match on the report's TITLE LINE, not its filename. Stub filenames are
    // {num}-{company}-{date}.md with NO role, so an employer running two reqs (Paradigm's Deployed
    // Engineer AND Deployment Strategist) produces two indistinguishable files — and a
    // company-only match refreshed one of them twice and the other never. Same employer-vs-
    // requisition confusion as the scoring dedup and the JD-snapshot skip.
    const wantTitle = `# ${r.company} — ${r.role}`;
    let path = '', body = '';
    for (const f of reports.slice().sort().reverse()) {
      if (!f.replace(/^\d+-/, '').startsWith(co + '-')) continue;
      let candidate;
      try { candidate = readFileSync(`reports/${f}`, 'utf8'); } catch { continue; }
      if (candidate.startsWith(wantTitle)) { path = `reports/${f}`; body = candidate; break; }
    }
    if (!path) continue;
    // Only ever touch OUR OWN stubs. A hand-written A-G report must never be rewritten.
    if (!body.includes('auto-generated by `scripts/backfill-reports.mjs`')) continue;

    const jd = findJd(r.company, r.role);
    const pdf = findResume(r.company, r.role);
    const jdLine = `**JD:** ${jd ? `data/jds/${jd}` : '— not snapshotted'}`;
    const pdfLine = `**PDF:** ${pdf ? `output/${pdf}` : '❌ not generated'}`;

    let out = body;
    out = /^\*\*JD:\*\*.*$/m.test(out)
      ? out.replace(/^\*\*JD:\*\*.*$/m, jdLine)
      : out.replace(/^(\*\*PDF:\*\*.*)$/m, `${jdLine}\n$1`);
    out = out.replace(/^\*\*PDF:\*\*.*$/m, pdfLine);

    if (out !== body) { if (!DRY) writeFileSync(path, out); refreshed++; }
  }
  console.log(`${refreshed} existing stub(s) ${DRY ? 'would be ' : ''}refreshed with current JD/PDF paths.`);
}

console.log(`\n${created} reports ${DRY ? 'would be ' : ''}created, ${skipped} scored jobs already had one.`);
