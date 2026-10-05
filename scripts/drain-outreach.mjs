#!/usr/bin/env node

/**
 * drain-outreach.mjs — draft outreach for every owed job.
 *
 * THE SELECTION GATE (user-set 2026-07-25, supersedes the old auto-fire-on-qualify rule):
 * scoring >= qualify_score makes a job ELIGIBLE, not owed. The user picks which qualifiers get
 * outreach (dashboard `w`, or scripts/outreach-queue.mjs add) and only picked jobs are
 * drafted, because the expensive steps spend a hard-capped LinkedIn budget (12 profile
 * visits/day). The split:
 *
 *   --bullets-only  runs step 1 for EVERY eligible >= qualify_score job (ungated). Bullets are
 *                   headless, cheap and cost no LinkedIn budget, so pre-generating them
 *                   means a job the user later picks is instantly ready to draft.
 *   (default)       runs the full drain for PICKED jobs only — steps 2-6 spend LinkedIn
 *                   profile visits and the Hunter email quota, so they need the user's OK.
 *
 *   for each owed job:
 *     1. gen-bullets.mjs  -> JD-mapped bullets (claude -p, NO browser)   [always]
 *     2. resolve its LinkedIn company slug (rosters + data/li-slugs.tsv)
 *     3. scan-roster.mjs  -> contacts (needs logged-in debug Chrome)     [if slug known]
 *     4. gen-outreach.mjs -> gold/silver/bronze HTML + email search       [if slug known]
 *     5. append data/outreach-log.tsv so the job stops being "owed"
 *     6. outreach-queue.mjs done -> mark the pick satisfied
 *
 * LinkedIn depth is matched to company size (user-set 2026-07-25): a small company gets
 * the full /people/ roster sweep; a large/multi-team one (OpenAI, Databricks, Stripe...)
 * gets targeted persona search only, which is both cheaper and more accurate there — the
 * roster at a big company returns off-team people.
 * scan-roster.mjs --auto-mode decides
 * from the employee count on the company page; the queue's li_mode column overrides it.
 *
 * Modes:
 *   --bullets-only   step 1 only, for every eligible job (headless-safe; run in cron).
 *   (default)        full drain of PICKED jobs; steps 3-4 need the browser.
 *   --limit N        process at most N jobs.   --company "X"  only that company.
 *
 * LinkedIn slugs are NOT the company name (Exa -> exa-ai). Known slugs come from
 * data/rosters/*.json + data/li-slugs.tsv. A job with no resolvable slug still gets
 * bullets; it's reported as "needs li-slug" (add it to data/li-slugs.tsv).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { requireTargets } from './targets.mjs';

requireTargets(); // exits with an onboarding message if config/profile.yml is missing

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const BULLETS_ONLY = has('--bullets-only');
// Escape hatch for the judge gate (step 6). Without it a HARD violation leaves the job
// queued instead of marked drafted. Use only when the violation is known-cosmetic.
const FORCE = has('--force');
const LIMIT = Number(val('--limit', 0)) || Infinity;
const ONLY_CO = val('--company', null);

// --quiet: print only the lines that carry a decision or a failure, and drop the
// step-by-step narration. A full drain emits 40-60 lines per job, which is pure cost
// when an agent reads the output; the summary block alone answers "what happened".
// Anything written to stderr is untouched, so real errors always survive.
const QUIET = has('--quiet') || process.env.CAREER_OPS_QUIET === '1';
if (QUIET) {
  const _log = console.log;
  const KEEP = /^(────|===|✓|✗|!|Done:|Persona coverage|outreach drafted|bullets generated|failed:|marked drafted|roster: no usable|search-budget|roster-budget|HARDENED|Cursor:|LOG_ROWS)/;
  console.log = (...a) => { if (KEEP.test(String(a.join(' ')).trim())) _log(...a); };
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = new Date().toISOString().slice(0, 10);

// --- owed list ---
// --bullets-only ignores the selection gate (--all): bullets are free of LinkedIn budget,
// so pre-generating them for every eligible qualifier means a later pick drafts instantly.
// The full drain uses the GATED list — only jobs the user picked.
const owedArgs = ['scripts/outreach-owed.mjs', '--json', ...(BULLETS_ONLY ? ['--all'] : [])];
const owedRes = spawnSync('node', owedArgs, { encoding: 'utf-8' });
let owed = [];
try { owed = JSON.parse(owedRes.stdout); } catch { console.error('could not read owed list'); process.exit(1); }
if (ONLY_CO) owed = owed.filter(j => j.company.toLowerCase() === ONLY_CO.toLowerCase());
owed = owed.slice(0, LIMIT);
if (!owed.length) {
  if (BULLETS_ONLY) {
    console.log('drain: nothing owed.');
  } else {
    console.log('drain: nothing picked for outreach.');
    console.log('       Pick jobs in the dashboard (`w` on Found) or: node scripts/outreach-queue.mjs awaiting');
  }
  process.exit(0);
}

// --- LinkedIn slug map: rosters (company -> filename slug) + overrides ---
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const liSlug = new Map();
const emailDomain = new Map(); // company -> email domain (for the email finder)
if (existsSync('data/rosters')) for (const f of readdirSync('data/rosters')) {
  if (!f.endsWith('.json')) continue;
  try { const d = JSON.parse(readFileSync(`data/rosters/${f}`, 'utf-8')); if (d.company) liSlug.set(norm(d.company), f.replace(/\.json$/, '')); } catch { /* skip */ }
}
// data/li-slugs.tsv: company <tab> linkedin-slug <tab> email-domain (3rd col optional)
if (existsSync('data/li-slugs.tsv')) for (const line of readFileSync('data/li-slugs.tsv', 'utf-8').split('\n')) {
  const [co, sl, dom] = line.split('\t'); if (co && sl) liSlug.set(norm(co), sl.trim()); if (co && dom) emailDomain.set(norm(co), dom.trim());
}
const FRESH_DAYS = 30;
const fresh = (path, days) => {
  if (!existsSync(path)) return false;
  let d; try { d = JSON.parse(readFileSync(path, 'utf-8')); } catch { return false; }
  const age = Date.now() - +new Date(d.generatedAt || d.scannedAt || 0);
  return age < days * 864e5;
};
/**
 * A roster is only usable if the run that produced it FINISHED.
 * scan-roster.mjs saves incrementally inside the visit loop, and those snapshots
 * carry no `selection`. Before 2026-07-25 `fresh()` looked only at `scannedAt`, so
 * an interrupted run produced a file that counted as a fresh cache for 30 days
 * while gen-outreach.mjs read `selection || []` and drafted outreach with ZERO
 * contacts — silently. data/rosters/lumalabsai.json was in exactly that state
 * (208 people, 7 visited, no selection, good until 2026-08-25).
 */
const rosterUsable = (path) => {
  if (!existsSync(path)) return false;
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8'));
    return d.partial !== true && Array.isArray(d.selection) && d.selection.length > 0;
  } catch { return false; }
};

const run = (cmd, args, timeout) => spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'inherit', timeout });

const summary = { bullets: [], drafted: [], needsSlug: [], failed: [], violations: [], blocked: [] };

for (const j of owed) {
  console.log(`\n=== ${j.score.toFixed(1)}  ${j.company} — ${j.role} ===`);
  const cslug = slug(j.company);
  const bulletsPath = `data/bullets/${cslug}.json`;
  // 1. bullets (always, headless)
  if (fresh(bulletsPath, 14)) { console.log(`bullets: fresh cache (${bulletsPath})`); }
  else {
    const r = run('node', ['scripts/gen-bullets.mjs', '--company', j.company, '--role', j.role, '--jd-url', j.url || '', '--slug', cslug], 260000);
    if (r.status !== 0) { summary.failed.push(`${j.company} (bullets)`); continue; }
  }
  summary.bullets.push(j.company);
  if (BULLETS_ONLY) continue;

  // 2. resolve LinkedIn slug
  const sl = liSlug.get(norm(j.company));
  if (!sl) { console.log(`needs li-slug: add "${j.company}\\t<linkedin-slug>" to data/li-slugs.tsv (bullets are ready)`); summary.needsSlug.push(j.company); continue; }

  // 3. roster (browser) if missing/stale — LinkedIn depth matched to company size.
  //    auto     -> scan-roster reads the employee count off the company page and picks
  //                the full roster sweep (small co) or targeted persona search (large co)
  //    roster   -> force the full /people/ sweep
  //    targeted -> force persona search only (cheap; right for big multi-team companies)
  const rosterPath = `data/rosters/${sl}.json`;
  if (!fresh(rosterPath, FRESH_DAYS) || !rosterUsable(rosterPath)) {
    if (fresh(rosterPath, FRESH_DAYS) && !rosterUsable(rosterPath)) {
      console.log(`roster: cache is PARTIAL (interrupted run, no selection) — rescanning rather than drafting with no contacts.`);
    }
    const mode = j.li_mode || 'auto';
    const modeArgs = mode === 'roster' ? ['--no-auto-mode']
      : mode === 'targeted' ? ['--search-only']
      : [];   // auto is the default now
    console.log(`roster: LinkedIn depth = ${mode}`);
    // Pass the DISPLAY name too. roster-score.mjs confirms a contact really works here
    // by matching the employer named in their headline against the company aliases, and
    // those aliases are derived from the SLUG unless we hand it the real name. When the
    // two differ past suffix-stripping the check inverts: Broccoli AI's slug is
    // `broccoli-com`, so every "Talent @ Broccoli AI" headline resolved to `other`
    // (i.e. "works somewhere else") and the whole roster was hard-dropped as
    // unconfirmable. The queue already knows the display name — give it to the scorer.
    const r = run('node', ['scripts/scan-roster.mjs', '--company', sl, '--company-name', j.company, ...modeArgs], 40 * 60000);
    if (r.status !== 0) { summary.failed.push(`${j.company} (roster — browser up?)`); continue; }
    // A cooldown or exhausted budget exits 0 with no roster written. Drafting with
    // no contacts is worse than not drafting, so stop the whole drain here.
    if (!rosterUsable(rosterPath)) {
      console.log(`roster: no usable roster after scan (cooldown, budget, or no confirmable contacts) — leaving ${j.company} queued.`);
      summary.failed.push(`${j.company} (no usable roster)`);
      continue;
    }
  } else console.log(`roster: fresh cache (${rosterPath})`);

  // 4. gen-outreach (auto-loads bullets + runs email search)
  const spec = [{ company: j.company, role: j.role, jd_url: j.url || '', linkedin_company: sl, domain: emailDomain.get(norm(j.company)) || undefined, use_roster: true, hmFirstName: '' }];
  writeFileSync('data/_drain-spec.json', JSON.stringify(spec, null, 2));
  const g = run('node', ['scripts/gen-outreach.mjs', 'data/_drain-spec.json'], 10 * 60000);
  if (g.status !== 0) { summary.failed.push(`${j.company} (gen-outreach)`); continue; }

  // 5. append outreach-log from the drafts.json
  const draftsPath = `output/outreach/${slug(j.company)}-${slug(j.role)}-${today}.drafts.json`;
  if (existsSync(draftsPath)) {
    const dj = JSON.parse(readFileSync(draftsPath, 'utf-8'));
    const html = draftsPath.replace(/\.drafts\.json$/, '.html');
    for (const p of dj.personas) for (const ch of p.channels) {
      appendFileSync('data/outreach-log.tsv', [today, j.company, j.role, p.persona, ch.channel, `${p.target.name} (${p.persona}): JD-mapped bullets, gold/silver/bronze`, j.url || '', html, 'pending', 'pending'].join('\t') + '\n');
    }
  }
  // 6. JUDGE — the deterministic gate (em dashes, 300-char LinkedIn cap, per-persona
  //    CTA, every $/% claim present in cv.md). It exits non-zero on a HARD violation.
  //
  //    THE VERDICT NOW BLOCKS (2026-07-26). Until today it did not: the job was marked
  //    drafted regardless, on the reasoning that "re-drafting would respend the LinkedIn
  //    budget for what is a text fix." That reasoning is wrong in its premise — steps 3-4
  //    are what spend the budget, and a rerun hits the fresh roster cache, so re-judging
  //    is nearly free. The cost of the old behavior was real: verify-stage flagged
  //    duplicate gold/silver/bronze across all four contacts on 2026-07-03 (severity
  //    high) and nothing changed, because no verdict in this pipeline stopped anything.
  //
  //    A HARD violation now leaves the pick QUEUED so it resurfaces until fixed.
  //    --force ships anyway for a known-cosmetic violation.
  const judged = spawnSync('node', ['scripts/outreach-judge.mjs', `${slug(j.company)}-${slug(j.role)}`], { encoding: 'utf-8', stdio: 'inherit', timeout: 120000 });
  if (judged.status !== 0) {
    summary.violations.push(j.company);
    if (!FORCE) {
      console.log(`judge: HARD violation for ${j.company} — leaving it QUEUED (artifacts written, not marked drafted). Fix the source and rerun, or pass --force.`);
      summary.blocked.push(j.company);
      continue;
    }
    console.log(`judge: HARD violation for ${j.company} — shipping anyway (--force).`);
  }

  // 7. mark the user's pick satisfied so it stops showing as awaiting-draft in the queue.
  //    (outreach-log.tsv already makes it "covered"; this keeps the queue view honest.)
  run('node', ['scripts/outreach-queue.mjs', 'done', '--company', j.company, '--role', j.role, '--url', j.url || ''], 20000);

  summary.drafted.push(j.company);
}

console.log('\n──────── drain summary ────────');
console.log(`bullets generated: ${summary.bullets.length} (${summary.bullets.join(', ') || '—'})`);
if (!BULLETS_ONLY) console.log(`outreach drafted:  ${summary.drafted.length} (${summary.drafted.join(', ') || '—'})`);
if (summary.needsSlug.length) console.log(`needs li-slug:     ${summary.needsSlug.join(', ')}  (add to data/li-slugs.tsv, then rerun)`);
if (summary.failed.length) console.log(`failed:            ${summary.failed.join(', ')}`);
if (summary.violations.length) {
  console.log(`\n⚠️  HARD VIOLATIONS — do NOT send these until fixed: ${summary.violations.join(', ')}`);
  console.log(`   Fix at the source (data/bullets/{slug}.json or the template), then rerun gen-outreach for that company.`);
}
if (summary.blocked.length) {
  console.log(`\n⛔ BLOCKED (left queued, not marked drafted): ${summary.blocked.join(', ')}`);
  console.log(`   The artifacts were written, so review them, fix the source, and rerun. Pass --force to ship as-is.`);
}
// Non-zero exit when anything was blocked, so a cron step that ends in `|| true`
// still shows up in the log as a real failure rather than a silent pass.
if (summary.blocked.length) process.exitCode = 3;
