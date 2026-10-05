#!/usr/bin/env node

/**
 * pipeline-owed.mjs — the "any job found is part of the pipeline" guarantee.
 *
 * THE RULE: the moment a job scores >= pipeline.qualify_score it is
 * automatically part of the pipeline and owes the FULL treatment — an evaluation report, a
 * tailored resume PDF, AND outreach drafts (draft-only, never auto-sent). This generalizes
 * outreach-owed.mjs (which tracked outreach only) to all three artifacts, reconciled against
 * the DURABLE ledger data/scored-jobs.tsv (not the 24h-pruned qualifiers.tsv), so a found job
 * can never silently fall out of the pipeline by ageing past the freshness window.
 *
 * A found job is OWED until each artifact exists OR the tracker marks it terminal
 * (Applied / Discarded / SKIP / Rejected / Offer = out of the pipeline by decision).
 *   report  — applications.md row has a [n](reports/..) link whose file exists.
 *   resume  — tracker PDF cell is ✅, or output/cv-*-{slug}-*.pdf exists. Owed ONLY for picked jobs.
 *   outreach— a matching row in outreach-log.tsv (same jd_url, or company+role overlap).
 *
 * Usage:
 *   node scripts/pipeline-owed.mjs          # human table; prints "OWED: N (report:a full-report:b resume:c outreach:d)"
 *     report      = no report file at all
 *     full-report = only the backfill STUB exists, no A-G evaluation
 *   node scripts/pipeline-owed.mjs --json   # JSON array (each: company, role, score, url, missing[])
 *
 * Exit code is always 0 so it never breaks a pipeline; read the OWED count / JSON length.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { loadTargets } from './targets.mjs';
import { parseApplications, parseScore as parseTrackerScore, extractReportLink } from './tracker-core.mjs';

const THRESHOLD = (() => { try { return loadTargets().pipeline.qualify_score; } catch { return 4.3; } })();
const ROOT = new URL('..', import.meta.url).pathname;
// The candidate's own city names are noise words in a title-vs-filename match.
const CITY_WORDS = (() => {
  try {
    const L = loadTargets().location;
    return [L.city, L.metro, ...(L.cities || [])].join(' ').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  } catch { return []; }
})();
const asJson = process.argv.includes('--json');

// Tracker states that mean the job has LEFT the pipeline by an explicit decision.
const TERMINAL = new Set(['applied', 'discarded', 'skip', 'rejected', 'offer']);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// First word as a filename slug (split on space/punct AND dots so "cora.ai" -> "cora",
// "Observe.AI" -> "observe", "Fireworks AI" -> "fireworks").
const firstToken = s => norm(String(s || '').split(/[\s,.(/-]/)[0]);
// Files are named cv-{candidate}-{slug}-{date}.pdf and {num}-{slug}-{date}.md. Match the
// company's first token against the file's HYPHEN-delimited segments by exact equality, so a
// short slug ("exa","zip") matches its own file but never substring-collides ("san" ⊄ a
// "sf-compute" file). Returns true iff some segment equals the token.
// GENERIC FIRST TOKENS COLLIDE (fixed 2026-09-09). firstToken("AI Fund") is "ai", and exact-segment
// matching then treats EVERY file with an "ai" segment as this employer's: 023-scale-ai-*.md,
// cv-{candidate}-backops-ai-*.pdf, and about a dozen more. AI Fund therefore reported as fully
// satisfied while having no tracker row, no report and no resume. Same class as the
// employer-vs-requisition bug, one level down: the COMPANY identity itself was wrong.
//
// Fix: match the FULL hyphenated company slug first. Only fall back to the single first token when
// that token is distinctive enough to identify an employer on its own.
const GENERIC_TOKEN = new Set(['ai', 'io', 'the', 'my', 'go', 'app', 'data', 'tech', 'labs', 'lab',
  'inc', 'co', 'get', 'we', 'hq', 'one', 'new', 'open', 'super', 'cloud', 'and', 'of']);
const fileMatches = (file, token, fullSlug = '') => {
  const f = file.toLowerCase();
  if (fullSlug && fullSlug.length >= 3 && f.includes(fullSlug)) return true;
  if (!token || token.length < 2 || GENERIC_TOKEN.has(token)) return false;
  return f.split(/[-.]/).some(seg => seg === token);
};
const companySlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function readTsv(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (cells[i] ?? '').trim(); });
    return row;
  });
}

// --- 1. open found jobs (>= qualify_score, not pass/skip, not yet applied) found in the last window_hours ---
// The pipeline is a freshness window, NOT a durable backlog (user-set 2026-06-17): a job that
// ages past 24h drops out of the owed/active view, same as qualifiers.tsv. Older finds stay in
// scored-jobs.tsv as the historical record but are not "owed".
const WINDOW_MS = (() => { try { return loadTargets().pipeline.window_hours; } catch { return 24; } })() * 3600 * 1000;
const now = Date.now();
const foundAtMs = r => {
  // Freshest of found_at / scored date (noon local). A found_at carrying an ATS or aggregator
  // claim date must not drop a row scored today out of the owed window: ATS age is not a
  // freshness gate on nomination lanes.
  const t = Date.parse((r.found_at || '').trim());
  const d = r.date ? Date.parse(`${r.date}T12:00:00`) : NaN;
  const best = Math.max(isNaN(t) ? 0 : t, isNaN(d) ? 0 : d);
  return best;
};
const found = new Map(); // key -> {company, role, score, url}
for (const r of readTsv(`${ROOT}data/scored-jobs.tsv`)) {
  const company = r.company || '', role = r.role || '';
  if (!company || !role) continue;
  const score = parseScore(r.score);
  if (score < THRESHOLD) continue;
  const verdict = (r.verdict || '').toLowerCase();
  if (verdict === 'pass' || verdict === 'skip') continue;
  if ((r.applied_at || '').trim()) continue; // already applied -> out of the "owed" pipeline
  if (now - foundAtMs(r) > WINDOW_MS) continue; // older than 24h -> not part of the active pipeline
  const key = `${norm(company)}::${norm(role)}`;
  const prev = found.get(key);
  if (!prev || score > prev.score) found.set(key, { company, role, score, url: r.url || '' });
}
function parseScore(s) { return parseFloat(String(s || '').replace('/5', '')) || 0; }

// --- 2. tracker index: status + pdf + report path, by company+role ---
const apps = parseApplications(existsSync(`${ROOT}data/applications.md`) ? readFileSync(`${ROOT}data/applications.md`, 'utf8') : '');
const trackerBy = new Map();
for (const a of apps) {
  trackerBy.set(`${norm(a.company)}::${norm(a.role)}`, a);
}
function trackerMatch(company, role) {
  const exact = trackerBy.get(`${norm(company)}::${norm(role)}`);
  if (exact) return exact;
  // loose: same company and one role contains the other
  for (const a of apps) {
    if (norm(a.company) !== norm(company)) continue;
    const ar = norm(a.role), r = norm(role);
    if (!ar || !r) continue;
    if (ar === r) return a;
    // Containment alone is not identity: a segment- or seniority-qualified variant is a
    // different requisition and must not inherit the other's report/resume.
    if ((ar.includes(r) || r.includes(ar)) && !reqMismatch(a.role, role)) return a;
  }
  return null;
}

// --- 3. drafted outreach (reuse outreach-owed's coverage semantics) ---
const drafted = readTsv(`${ROOT}data/outreach-log.tsv`)
  .map(r => ({ c: norm(r.company), role: norm(r.role), url: (r.jd_url || '').trim() }))
  .filter(r => r.c);
function hasOutreach(company, role, url) {
  const c = norm(company), rl = norm(role);
  return drafted.some(d => {
    if (url && d.url && d.url === url) return true;
    const companyMatch = d.c === c || d.c.startsWith(c) || c.startsWith(d.c);
    const roleMatch = d.role === rl || d.role.includes(rl) || rl.includes(d.role);
    return companyMatch && roleMatch;
  });
}

// --- 3b. the OUTREACH SELECTION GATE (user-set 2026-07-25) ---
// Outreach is no longer owed on every >= 4.3: the user picks which qualifiers are worth the
// LinkedIn/email budget (dashboard `w` -> data/outreach-queue.tsv). The report is still owed
// unconditionally (cheap, headless); the resume shares this gate since PDF became interactive-only. So a job only owes OUTREACH when the user
// picked it. An un-picked qualifier missing outreach is a decision, not a gap.
// See .claude/skills/career-finder/modes/outreach.md + memory feedback_outreach_user_selected.
const picked = readTsv(`${ROOT}data/outreach-queue.tsv`)
  .filter(r => (r.status || 'selected') !== 'drafted');
function isPickedForOutreach(company, role, url) {
  const c = norm(company), rl = norm(role);
  return picked.some(q => {
    const qu = (q.url || '').trim();
    if (url && qu) return qu === url;
    return norm(q.company) === c && norm(q.role) === rl;
  });
}

// --- 4. resume PDFs on disk: output/cv-*-{slug}-*.pdf ---
let resumeFiles = [];
try { resumeFiles = readdirSync(`${ROOT}output`).filter(f => /\.pdf$/i.test(f)); } catch {}
// ROLE-AWARE (fixed 2026-09-08). This took the company alone, so ANY Factory PDF — including
// one generated months earlier for a different req — satisfied a newer "Data Engineer,
// Mid-Market" req at the same employer. That is the same company-not-requisition bug the report matcher was fixed
// for twice (2026-07-29, 2026-08-24); the resume side was simply never done.
//
// Filenames come in two shapes: the modern cv-{candidate}-{company}-{role-slug}-{date}.pdf and
// the legacy company-only cv-{candidate}-{company}-{date}.pdf. A role-carrying filename must
// match the role. A legacy company-only file is accepted ONLY when this employer has a single
// found requisition, so it cannot be ambiguous about which req it covers — the same rule the
// dashboard already applies to company-only reports (rolesPerCompany <= 1 in scored.go).
function hasResumeFile(company, role, reqsAtCompany = 1) {
  const slug = firstToken(company);
  const candidates = resumeFiles.filter(f => fileMatches(f, slug, companySlug(company)));
  if (!candidates.length) return false;
  const GENERIC = new Set(['engineer', 'the', 'and', 'for', ...CITY_WORDS]);
  const words = String(role || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC.has(w));
  if (words.length) {
    const roleHit = candidates.some(f => {
      if (reqMismatch(role, f)) return false;
      const hay = f.toLowerCase();
      return words.filter(w => hay.includes(w)).length / words.length >= 0.6;
    });
    if (roleHit) return true;
  }
  // Fall back to a company-only file only when it cannot be about a different req.
  if (reqsAtCompany > 1) return false;
  return candidates.some(f => !reqMismatch(role, f));
}

// --- 5. report files on disk (fallback when the tracker row lacks a link) ---
let reportFiles = [];
try { reportFiles = readdirSync(`${ROOT}reports`).filter(f => /\.md$/i.test(f)); } catch {}
// A report must cover THIS ROLE, not merely this employer (fixed 2026-07-29).
// Company-only matching silently satisfied the check with an unrelated report: a "Commercial
// Analyst" req counted as reported because an older report existed for "Analyst (Professional
// Services)" at the same employer — a different req with different requirements. Employers post many same-company roles; one report per company is
// not one report per job, and the whole point of the report is the per-JD evaluation.
// MATCH THE REPORT'S TITLE, NOT ITS PROSE (fixed 2026-08-24).
//
// This used to scan the first 1200 characters of the report BODY. A report's opening paragraphs
// naturally name the archetype, the responsibilities and half the vocabulary of any same-shaped
// role at that employer, so the 0.6 word-overlap threshold was trivially satisfied by an
// UNRELATED requisition. Measured on 2026-08-24: four fresh qualifiers were reported as already
// having a report when none of them did --
//
//   Acme   "Platform Engineer (Infra)"                  matched 996-acme-platform-reliability-engineer
//   Zip    "Software Engineer, Payments"                matched 802-zip
//   Globex "Agent Platform Engineer"                    matched 781-globex-platform
//
// Same failure class as the Notion case the 2026-07-29 comment above records, and the same one
// merge-tracker hit on row 773: employer-level identity applied to per-requisition data. The
// consequence here is worse than a duplicate -- the pipeline reports the work as DONE, so the
// report is never written and nobody notices.
//
// Every report opens with `# Evaluation: {Company} — {Role}`. That line is the report's own claim
// about which requisition it covers, so match against it and nothing else.
function reportTitle(f) {
  try {
    const head = readFileSync(`${ROOT}reports/${f}`, 'utf-8').slice(0, 400);
    const m = head.match(/^#\s*(?:evaluation:)?\s*(.+)$/im);
    return (m ? m[1] : '').toLowerCase();
  } catch { return ''; }
}
// A STUB IS NOT AN EVALUATION.
//
// backfill-reports.mjs writes a compact auto-generated summary for every scored job at or above the
// bar so the dashboard drill-in always resolves. That is deliberate and it stays. But it satisfied
// the owed check, so `OWED: 0` was reported while the board carried no real evaluations at all:
// measured 2026-08-26, 4 of 6 board jobs had only a stub. The distinction now has a name, because
// the cron's full-report lane needs to know which jobs still need writing.
const STUB_MARK = /auto-generated by [`']?scripts\/backfill-reports|NOT a full A[-\u2013]G evaluation/i;
function isStubReport(relPath) {
  try { return STUB_MARK.test(readFileSync(`${ROOT}${relPath}`, 'utf-8').slice(0, 4000)); } catch { return false; }
}

// SENIORITY AND SCOPE ARE DISTINGUISHING, and a subset match ignores them.
//
// Example: a 4.7 "Acme - Platform Engineer" matched report 889, "Acme - Head of Platform
// Engineering" (2.5, an exec org-builder req). Its distinctive words are BOTH present in the longer title, so overlap
// scored 1.00 and owed reported 0. The IC role had no report at all and the dashboard served
// the exec role's stub in its place.
//
// Word overlap alone can never catch this: "X" is always a subset of "Head of X". So compare
// the seniority/scope tokens directly, and treat any disagreement as a different requisition.
// Same principle as the merge-tracker rule that a report is per-req, never per-employer.
const RANK = /\b(head|director|vp|vice president|principal|chief|founding|manager|lead|senior|staff|associate|junior|entry|intern|president|partner)\b/gi;
const rankOf = (t) => new Set(String(t).toLowerCase().match(RANK) || []);
const rankMismatch = (a, b) => {
  const ra = rankOf(a), rb = rankOf(b);
  if (ra.size !== rb.size) return true;
  for (const x of ra) if (!rb.has(x)) return true;
  return false;
};

// SEGMENT / TERRITORY IS ALSO DISTINGUISHING (fixed 2026-09-08). rankMismatch catches
// "Data Engineer" vs "Head of Data Engineering", but not "Data Engineer" vs
// "Data Engineer, Mid-Market" — same seniority, different requisition, different team.
// Example: an April "Data Engineer" (report 706) and a September "Data Engineer, Mid-Market"
// (4.6, the best qualifier of the day). trackerMatch's loose branch accepts any title that
// CONTAINS the other, so the new req inherited April's report and resume and owed reported 0.
// Same asymmetry as everywhere else in this file: calling two reqs the same silently drops
// work, calling them different costs one redundant report.
const SEGMENT = /\b(mid[- ]?market|enterprise|smb|commercial|strategic|majors|growth|startups?|public sector|federal|govt?|government|named|emerging|corporate|amer|emea|apac|latam|west|east|central|north|south)\b/gi;
const segOf = (t) => new Set((String(t).toLowerCase().match(SEGMENT) || []).map(x => x.replace(/[- ]/g, '')));
const segmentMismatch = (a, b) => {
  const sa = segOf(a), sb = segOf(b);
  if (sa.size !== sb.size) return true;
  for (const x of sa) if (!sb.has(x)) return true;
  return false;
};
// One requisition-identity test, used by every artifact check below.
const reqMismatch = (a, b) => rankMismatch(a, b) || segmentMismatch(a, b);

function reportFileFor(company, role) {
  const slug = firstToken(company);
  const candidates = reportFiles.filter(f => fileMatches(f, slug, companySlug(company)));
  if (!candidates.length) return '';
  const GENERIC = new Set(['engineer', 'the', 'and', 'for', ...CITY_WORDS]);
  const words = String(role).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC.has(w));
  const hit = candidates.find(f => {
    const title = reportTitle(f);
    if (title && reqMismatch(role, title)) return false;
    if (!words.length) return true;
    const hay = f.toLowerCase() + ' ' + title;
    return words.filter(w => hay.includes(w)).length / words.length >= 0.6;
  });
  return hit ? `reports/${hit}` : '';
}

function hasReportFile(company, role) {
  const slug = firstToken(company);
  const candidates = reportFiles.filter(f => fileMatches(f, slug, companySlug(company)));
  if (!candidates.length) return false;
  if (!role) return true;
  // Distinctive role words (drop generic filler that every title shares).
  const GENERIC = new Set(['engineer', 'the', 'and', 'for', ...CITY_WORDS]);
  const words = String(role).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC.has(w));
  if (!words.length) return true;                       // nothing distinctive to match on
  return candidates.some(f => {
    const title = reportTitle(f);
    // A report about a different seniority or scope is a different requisition, however much
    // vocabulary it shares.
    if (title && reqMismatch(role, title)) return false;
    const hay = f.toLowerCase() + ' ' + title;
    const hits = words.filter(w => hay.includes(w)).length;
    return hits / words.length >= 0.6;                  // most distinctive words present
  });
}

// --- 6. reconcile each found job -> which artifacts are missing ---
// How many distinct requisitions has each employer got on the board? Decides whether a
// company-only resume/report filename is unambiguous enough to count.
const reqsPerCompany = new Map();
for (const j of found.values()) {
  const c = norm(j.company);
  reqsPerCompany.set(c, (reqsPerCompany.get(c) || 0) + 1);
}
const owed = [];
for (const j of found.values()) {
  const t = trackerMatch(j.company, j.role);
  if (t && TERMINAL.has((t.status || '').toLowerCase())) continue; // left pipeline by decision

  const reportPath = t ? extractReportLink(t.report) : null;
  const hasReport = (reportPath && existsSync(`${ROOT}${reportPath}`)) || hasReportFile(j.company, j.role);
  const hasResume = (t && (t.pdf || '').includes('✅')) || hasResumeFile(j.company, j.role, reqsPerCompany.get(norm(j.company)) || 1);
  // Outreach counts as owed only when the user picked this job (selection gate).
  const outreach = hasOutreach(j.company, j.role, j.url) || !isPickedForOutreach(j.company, j.role, j.url);

  const missing = [];
  if (!hasReport) missing.push('report');
  else {
    // Resolve which file answered, then ask whether it is a real evaluation or the stub.
    const rp = (reportPath && existsSync(`${ROOT}${reportPath}`)) ? reportPath : reportFileFor(j.company, j.role);
    if (rp && isStubReport(rp)) missing.push('full-report');
  }
  // Resume is owed only for jobs the user picked (item #3): PDF generation is interactive-only,
  // so an un-picked qualifier without a PDF is a decision, not a gap. Same gate as outreach.
  if (!hasResume && isPickedForOutreach(j.company, j.role, j.url)) missing.push('resume');
  if (!outreach) missing.push('outreach');
  if (missing.length) owed.push({ ...j, status: t ? t.status : '(not in tracker)', missing });
}
owed.sort((a, b) => b.score - a.score);

if (asJson) {
  process.stdout.write(JSON.stringify(owed, null, 2) + '\n');
  process.exit(0);
}

// Surface artifacts that FAILED semantic verification on the last cron run. The cron
// used to swallow these (`|| true`), so a severity:high verdict was written to disk and
// never seen — a fail sat unread from 2026-07-03 until 2026-07-26. Now it reaches the
// session that could act on it.
function reportVerifyFailures() {
  try {
    const lines = readFileSync('data/_verify-failures.txt', 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    console.log(`\n⚠️  VERIFY FAILED on ${lines.length} outreach artifact(s) in the last cron run — do NOT send these:`);
    for (const f of lines) {
      const vp = `output/verify/${f.split('/').pop().replace(/\.html$/, '')}`;
      console.log(`   ${f}`);
      console.log(`        verdict: output/verify/ (match ${vp}*.verify.json)`);
    }
    console.log('   Fix at the source (data/bullets/{slug}.json or the template) and rerun gen-outreach.\n');
  } catch { /* no sentinel = nothing failed */ }
}

const tally = owed.reduce((acc, j) => {
  for (const m of j.missing) acc[m] = (acc[m] || 0) + 1;
  return acc;
}, {});
if (!owed.length) {
  console.log(`OWED: 0  — every found (>= ${THRESHOLD}) job has a report, and every job you picked has a resume and outreach drafts.`);
  reportVerifyFailures();
  process.exit(0);
}
console.log(`OWED: ${owed.length}  — found (>= ${THRESHOLD}) jobs missing pipeline artifacts ` +
  `(report:${tally.report || 0} full-report:${tally['full-report'] || 0} resume:${tally.resume || 0} outreach:${tally.outreach || 0}). ` +
  `Each found job is part of the pipeline; produce what's missing (draft-only, never auto-send):\n`);
for (const j of owed) {
  console.log(`  ${j.score.toFixed(1)}  ${j.company} — ${j.role}   [${j.status}]`);
  console.log(`        missing: ${j.missing.join(', ')}`);
  console.log(`        ${j.url || '(no url on file — fetch the posting first)'}`);
}
reportVerifyFailures();
process.exit(0);
