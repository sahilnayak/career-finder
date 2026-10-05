#!/usr/bin/env node

/**
 * linkedin-jobsearch.mjs — the LOGGED-IN LinkedIn job search lane.
 *
 * WHY THIS EXISTS. `speed-linkedin.mjs` uses LinkedIn's unauthenticated `jobs-guest`
 * API, which returns a small subset of what the logged-in search shows for the same
 * keyword, window and location (a handful of cards vs 99+ results, when measured).
 *
 * WHY IT DOES NOT TRUST LINKEDIN DATES. "Posted 7 hours ago" is a RE-PROMOTION
 * timestamp, not a publish date, and the "Reposted" label is often absent. Cards
 * claiming "N hours ago" routinely resolve to requisitions that are weeks or months old
 * (and sometimes in a different city) once checked against the employer's own ATS.
 *
 * So this lane only ever NOMINATES a role. Rows are written to data/_web-roles.tsv
 * (which web-roles.mjs --clean then re-filters) with the LinkedIn age recorded as a
 * claim, never as a verified publish date.
 *
 * BUT AGE IS NOT A REJECT. The dates above are still not
 * trusted AS DATES — a card claiming "8 hours" may be a years-old req and the report
 * must say so — but a stale ATS publish date no longer disqualifies the role. LinkedIn
 * re-promoting a req means the employer is still hiring for it; publishedAt records when
 * the req was created, which is a different question. The scoring stage still resolves
 * the ATS every time, for existence, canonical JD, real location and comp. Only the
 * clock stopped being a gate.
 *
 * SAFETY. Follows the linkedin-stealth skill: attaches to the warm logged-in debug
 * Chrome on :9222 (never a fresh headless context), charges the shared `search`
 * budget per query and stops at the cap, jittered human delays, scrolls before
 * extracting, stays on page 1, and aborts the whole run on any checkpoint/CAPTCHA.
 *
 * Usage:
 *   node scripts/linkedin-jobsearch.mjs                       # default query set
 *   node scripts/linkedin-jobsearch.mjs --queries "<role a>|<role b>"
 *   node scripts/linkedin-jobsearch.mjs --dry-run             # print, write nothing
 */

// Request ledger: logged-in traffic is counted from li-budget claim() events; importing it
// registers the exit-time flush to data/_request-ledger.tsv.
import './request-ledger.mjs';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { cdpAlive, newPage, DEFAULT_PORT } from './cdp.mjs';
import { requireTargets, SEARCH_KEYWORDS, LOCAL, titleMatches, titleDropped, locationMatches, loadNoise, areaLabel, dealbreakerHit } from './role-filters.mjs';
import { liSearchGeos, liLocationText } from './li-geo.mjs';
import { claim, cooldown, inCooldown } from './li-budget.mjs';
import { parseCards as parseCardsShared, htmlToText, roleKey, existingWebRoleKeys, extractJobLinks, attachJobIds, jobViewUrl } from './linkedin-parse.mjs';

requireTargets();

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); const n = i !== -1 ? argv[i + 1] : undefined; return n && !n.startsWith('--') ? n : d; };
// --fixture <file>: parse a saved results page (HTML or innerText) instead of a live browser.
// No Chrome, no budget, no network, and nothing is written (implies --dry-run).
const FIXTURE = val('--fixture');
const DRY = argv.includes('--dry-run') || !!FIXTURE;
const JSON_OUT = argv.includes('--json');
const OUT = process.env.CAREER_FINDER_WEB_ROLES || 'data/_web-roles.tsv';

// Query keywords = targets.roles, primary first, CAPPED AT 4 (3 forms x 4 roles = 12 searches/day).
const MAX_ROLES = 4;
const QUERIES = (val('--queries') || SEARCH_KEYWORDS.join('|')).split('|').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ROLES);
// Geo variants: the local geo always; remote-country/any profiles add country geoId + f_WT=2.
// The remote variant is NOT crossed with every form (that doubled the daily search count):
// every form runs on the LOCAL geo, and remote profiles get ONE extra faceted search per role.
const GEOS = liSearchGeos(val('--geo', ''));
const LOCAL_GEO = GEOS.find((g) => g.tag === 'local') || GEOS[0];
const REMOTE_GEO = GEOS.find((g) => g.tag === 'remote');

// TWO SEARCH FORMS PER KEYWORD, and they are not redundant.
//
//   `faceted`  — the structured search: geoId + f_TPR=r86400. LinkedIn applies the location
//                and date facets as filters. This is the form the lane has always used.
//   `semantic` — LinkedIn's natural-language search (origin=SEMANTIC_SEARCH_LANDING_PAGE),
//                where the window is expressed in the query text rather than as a facet.
//
// They return DIFFERENT result sets: the semantic ranker surfaces titles the faceted keyword
// match misses (an adjacent title the keyword does not contain), while the
// faceted form is the only one that hard-filters on the profile's geo. Running both is the
// point — one is recall, the other is precision.
//
// Cost: 2 searches per role on the LOCAL geo (+1 remote faceted search per role when
// remote_policy is remote-country/any), charged to the `jobsearch` budget via claim().
// The `jobsearch` cap lives in li-budget.mjs and the loop stops the moment the budget refuses.
// Every form carries f_TPR=r86400 (past 24h) — the semantic form also says it in the query text.
const FORMS = [
  { name: 'faceted', url: (q, g) => `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(q)}${g.param ? `&${g.param}` : ''}&f_TPR=r86400` },
  { name: 'semantic', url: (q, g) => `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(`${q} ${g.tag === 'remote' ? 'remote jobs' : `jobs in ${liLocationText() || g.label}`} posted in the past 24 hours`)}${g.tag === 'remote' ? `&${g.param}` : ''}&f_TPR=r86400&origin=SEMANTIC_SEARCH_LANDING_PAGE` },
];
const ONLY_FORM = val('--form');   // 'faceted' | 'semantic' — omit to run both
const TARGETS = QUERIES.flatMap((q) => {
  const out = FORMS.filter((f) => !ONLY_FORM || f.name === ONLY_FORM)
    .map((f) => ({ q, form: f.name, geo: LOCAL_GEO.tag, url: f.url(q, LOCAL_GEO) }));
  // The one remote search per role rides with the faceted form (so `--form faceted` runs it).
  if (REMOTE_GEO && (!ONLY_FORM || ONLY_FORM === 'faceted')) out.push({ q, form: 'faceted', geo: REMOTE_GEO.tag, url: FORMS[0].url(q, REMOTE_GEO) });
  return out;
});

// --urls: print the exact search URLs (proves the 24h facet + geo) and exit. Spends nothing.
if (argv.includes('--urls')) {
  console.log(JSON.stringify(TARGETS, null, 2));
  process.exit(0);
}

// ── gates ───────────────────────────────────────────────────────────────────
if (!FIXTURE && existsSync('data/LINKEDIN_OFF')) { console.log('LinkedIn kill-switch is ON — nothing to do.'); process.exit(0); }
const CD = FIXTURE ? null : inCooldown();
if (CD) { console.log(`LinkedIn COOLDOWN until ${CD.until} (${CD.reason}) — nothing to do.`); process.exit(0); }

// CHARGES `jobsearch`, NOT `search` (fixed 2026-08-24).
//
// pace.mjs meters two different LinkedIn surfaces and this lane was billing the wrong one.
// `search` is the PEOPLE lane -- roster sweeps and contact discovery, the surface LinkedIn's
// Commercial Use Limit actually watches -- and it was capped at 12/day. `jobsearch` is the JOB
// surface (cap: li-budget.mjs JOBSEARCH_DAY_CAP), which is what linkedin-crawl.mjs has always correctly charged.
//
// Browsing job listings is what a job seeker does; it is not the metered activity. Billing job
// queries to the people counter meant eight job searches consumed two thirds of a day's contact
// -discovery budget and then refused the eighth query outright.
// claim(), not spend(): same horizons, burst window and cooldown as linkedin-crawl.mjs, and the
// search is logged to data/li-events.tsv like every other account action.
function spendSearchBudget(t) {
  const c = claim('jobsearch', `linkedin-jobsearch "${t.q}" ${t.form}/${t.geo}`);
  if (!c.ok) console.log(`jobsearch budget: ${c.reason}`);
  return c.ok;
}
const jitter = (min, max) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

// ── extraction ──────────────────────────────────────────────────────────────
/**
 * Parse the rendered results list. LinkedIn's card markup churns constantly, so this
 * reads the visible text of the list rather than depending on class names: each card
 * contributes a title line, a company line, a location line and a "Posted N ago" line.
 * Text-shape parsing survives a CSS refactor; a selector does not.
 */
function parseCards(text) {
  const start = text.search(/\d+\+?\s+results/i);
  const body = start === -1 ? text : text.slice(start);
  const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Posted\s+(.+?\s+ago)$/i);
    if (!m) continue;
    // Walk back for the location, company and title. The card renders the title twice
    // (once with a "(Verified job)" suffix), so dedup on the pair.
    const window = lines.slice(Math.max(0, i - 8), i);
    const locIdx = window.findLastIndex((l) => /,\s*[A-Z]{2}\b|Remote|Hybrid|On-site|United States|Metropolitan Area|Area$/i.test(l) || LOCAL.test(l));
    if (locIdx < 1) continue;
    const location = window[locIdx];
    const company = window[locIdx - 1];
    const titleLines = window.slice(0, locIdx - 1).filter((l) => l.length > 3 && !/^\$|benefit|applicant|Easy Apply|promoted/i.test(l));
    const title = (titleLines[titleLines.length - 1] || '').replace(/\s*\(Verified job\)\s*$/i, '').trim();
    if (!title || !company) continue;
    out.push({ title, company, location, ageClaim: m[1] });
  }
  // Dedup on company+title.
  // Fallback: the shared crawl parser (linkedin-parse.mjs) when the walk-back finds nothing —
  // e.g. a card whose location line matches none of the shapes above.
  if (!out.length) for (const c of parseCardsShared(text)) out.push({ title: c.title, company: c.company, location: c.loc, ageClaim: c.age });
  const seen = new Set();
  return out.filter((c) => { const k = `${c.company}|${c.title}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Deterministic pre-filter. Cheap rejections happen here so the scoring stage never
// pays for a role that was never eligible.
const AGENCY = /staffing|recruit(ing|ment|er)?\b|talent partners|robert half|insight global|apex systems/i;
const NOISE = loadNoise();

function keep(c) {
  const co = c.company.toLowerCase();
  if (AGENCY.test(c.company) || NOISE.some((n) => co.includes(n))) return 'staffing/noise';
  if (!titleMatches(c.title)) return 'not a target title';
  if (titleDropped(c.title)) return 'off-target';
  if (dealbreakerHit(c.company, c.title)) return 'dealbreaker';
  if (!locationMatches(c.location, c.title)) {
    return /remote/i.test(c.location) ? 'remote (per remote_policy)' : `outside ${areaLabel()}`;
  }
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
const already = existsSync('data/scored-jobs.tsv')
  ? new Set(readFileSync('data/scored-jobs.tsv', 'utf8').split('\n').map((l) => {
      const f = l.split('\t'); return `${(f[1] || '').toLowerCase()}|${(f[2] || '').toLowerCase()}`;
    }))
  : new Set();

// Chrome must be UP; it does NOT need a tab already open. The old check listed `/json/list` and
// aborted with "no debug Chrome on :9222" when it found no page target — which is what happened on
// EVERY run from 2026-07-30 to 2026-08-10. `/json/version` answered fine the whole time; the
// profile simply starts with zero pages open, so `/json/list` returned `[]` and this lane skipped
// itself for 11 days while reporting a browser problem it did not have. newPage() creates the tab.
if (!FIXTURE && !(await cdpAlive())) {
  console.error(`no debug Chrome on :${DEFAULT_PORT} — run: node scripts/chrome-debug.mjs start`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
let wrote = 0, nominated = [], rejected = {};
const perSearch = [];
// Two search forms per keyword means the SAME card is returned by more than one query — the
// faceted and semantic rankers overlap heavily, and closely related target roles overlap each other. Without this, one requisition is nominated up to 7 times and the
// "nominated N" line overstates the run. web-roles.mjs --clean would collapse them later (the
// row URL is derived from the title), but a misleading count is its own bug.
const seenThisRun = new Set();
const CHECKPOINT_TEXT = /unusual activity|security verification|are you a human|checkpoint\/challenge|let's do a quick security check/i;

/** One live search: navigate (one timeout retry, never a throttle retry), scroll, read. */
async function liveText(url) {
  const page = await newPage();
  try {
    let nav;
    try { nav = await page.navigate(url, { waitMs: 3500, loadTimeout: 60000 }); }
    catch (e) {
      console.error(`navigate failed (${e.message}) — one retry with a longer settle`);
      await jitter(6000, 9000);
      nav = await page.navigate(url, { waitMs: 9000, loadTimeout: 60000 });
    }
    // 999/429 is LinkedIn saying stop. NEVER retry it; trip the shared breaker.
    if (nav?.status === 999 || nav?.status === 429) {
      cooldown(`HTTP ${nav.status} from LinkedIn (jobsearch)`, 6);
      return { stop: `HTTP ${nav.status} — cooldown tripped`, code: 2 };
    }
    await jitter(2500, 5000);
    const text0 = await page.evaluate(() => document.body.innerText);
    if (CHECKPOINT_TEXT.test(text0) || /authwall|\/checkpoint\/|\/login|\/uas\/login/.test(await page.url())) {
      cooldown('authwall/checkpoint (jobsearch)', 12);
      return { stop: 'CHECKPOINT / AUTHWALL — the debug profile is logged out or challenged. Log in manually (npm run linkedin:login); do not retry.', code: 2 };
    }
    // Human-ish: a few scroll bursts so lazy cards render, then read.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const pane = document.querySelector('[class*=scaffold-layout__list]') || document.scrollingElement;
        pane.scrollBy(0, 1200);
      });
      await jitter(900, 1800);
    }
    const text = await page.evaluate(() => document.body.innerText);
    // Job ids live in hrefs, not innerText: collect {id, text} so cards can carry /jobs/view/<id>.
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/jobs/view/"]')]
      .map((a) => ({ id: (a.getAttribute('href').match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) || [])[1] || '', text: a.innerText || '' }))
      .filter((l) => l.id)).catch(() => []);
    return { text, links };
  } finally {
    await page.close().catch(() => {});   // process.exit skips finally, so callers exit after this returns
  }
}

const RUN = FIXTURE ? [{ q: '(fixture)', form: 'fixture', geo: '-', url: FIXTURE }] : TARGETS;
let stopCode = 0;
for (const t of RUN) {
  const { q } = t;
  let text; let links = [];
  if (FIXTURE) {
    const raw = readFileSync(FIXTURE, 'utf8');
    text = htmlToText(raw);
    links = extractJobLinks(raw);
  } else {
    if (!spendSearchBudget(t)) { console.log(`search budget exhausted for today — stopping after ${RUN.indexOf(t)} of ${RUN.length} query(ies).`); break; }
    // RAW CDP, never Playwright — same rule as linkedin-crawl.mjs.
    let r;
    try { r = await liveText(t.url); }
    catch (e) { console.error(`"${q}" [${t.form}/${t.geo}]: failed twice (${e.message}) — skipping this search`); perSearch.push({ ...t, error: e.message }); continue; }
    if (r.stop) { console.error(r.stop); stopCode = r.code; perSearch.push({ ...t, error: r.stop }); break; }
    text = r.text; links = r.links || [];
  }

  const cards = attachJobIds(parseCards(text), links);
  console.log(`\n"${q}" [${t.form}/${t.geo}]: ${cards.length} cards parsed`);
  const searchStat = { q, form: t.form, geo: t.geo, url: t.url, cards: cards.length, kept: 0 };
  perSearch.push(searchStat);

  for (const c of cards) {
    const why = keep(c);
    if (why) { rejected[why] = (rejected[why] || 0) + 1; continue; }
    const runKey = `${c.company.toLowerCase()}|${c.title.toLowerCase()}`;
    const rk = roleKey(c.company, c.title);
    if (already.has(runKey)) { rejected['already scored'] = (rejected['already scored'] || 0) + 1; continue; }
    // Re-read the file per card: the faceted and semantic forms run as separate processes.
    const prior = existingWebRoleKeys(existsSync(OUT) ? readFileSync(OUT, 'utf8') : '');
    if (prior.keys.has(rk) || (c.id && prior.ids.has(String(c.id)))) { rejected['already nominated'] = (rejected['already nominated'] || 0) + 1; continue; }
    if (seenThisRun.has(rk) || (c.id && seenThisRun.has(`id:${c.id}`))) { rejected['dup across search forms'] = (rejected['dup across search forms'] || 0) + 1; continue; }
    seenThisRun.add(rk); if (c.id) seenThisRun.add(`id:${c.id}`);
    nominated.push({ ...c, form: t.form, geo: t.geo });
    searchStat.kept++;
    // 7 cols matching the open-web lane: date, company, role, location, posted, url, source.
    // `posted` deliberately carries the UNVERIFIED LinkedIn claim, tagged so the scorer
    // knows to resolve the real date from the ATS before trusting it.
    const row = [today, c.company, c.title, c.location, `linkedin-claim:${c.ageClaim}`,
      c.id ? jobViewUrl(c.id) : `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(c.title)}`, 'linkedin-loggedin'].join('\t');
    if (!DRY) { appendFileSync(OUT, row + '\n'); wrote++; }
  }
  if (!FIXTURE) await jitter(6000, 14000);   // rest between queries
}

console.log(`\nnominated ${nominated.length}${DRY ? ' (dry run, nothing written)' : `, wrote ${wrote} → ${OUT}`}`);
for (const n of nominated) console.log(`  → ${n.company} | ${n.title} | ${n.location} | claims ${n.ageClaim}`);
console.log(`rejected: ${JSON.stringify(rejected)}`);
console.log('\nNOTE: every row is a NOMINATION. The LinkedIn age is a claim, not a publish date —');
console.log('the scoring stage must resolve the canonical ATS posting for the JD, the real location,');
console.log('comp, and to confirm the req still exists. It must NOT reject on the ATS publish date:');
console.log('a re-promoted req means they are still hiring. Record the real age, do not gate on it.');
if (JSON_OUT) console.log('JSON ' + JSON.stringify({ searches: perSearch, nominated, rejected }));
if (stopCode) process.exit(stopCode);
