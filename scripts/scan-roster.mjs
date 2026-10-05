#!/usr/bin/env node

/**
 * scan-roster.mjs — scan a company's FULL LinkedIn /people/ roster and rank it
 * for outreach. Run automatically by gen-outreach.mjs before the HTML is built
 * (standing rule 2026-06-12), or standalone.
 *
 * Phases:
 *   1. Roster: open linkedin.com/company/{slug}/people/, scroll + "Show more"
 *      until every employee card is loaded; capture name/title/profile URL.
 *   1b. Persona search (NEW 2026-06-14): the /people/ page is engineer-dominated
 *      and paginates, so recruiters and the specific hiring manager often never
 *      surface there. Resolve the company's numeric ID and run title-targeted
 *      LinkedIn people-searches (currentCompany=[ID] + keywords) for each
 *      persona that the roster alone under-fills: Recruiter, Team-Leader,
 *      Team-Manager/HM, peers in the target role. Merge the hits into the roster (deduped by
 *      profile URL) so EVERY persona has candidates before ranking.
 *   2. Profiles: visit only the TOP relevant profiles (HARDENED 2026-06-17 after a
 *      LinkedIn automation flag: sequential 1 lane, 6-12s spacing, per-run cap 15 +
 *      a per-DAY budget shared with the linkedin-stealth skill's pace.mjs counter
 *      via scripts/li-budget.mjs, charged per visit, resumable via the cache file) for
 *      headline, location, and the most recent post. Override: --max-visits / --daily-cap
 *      / --concurrency (max 2). Prefer the targeted LinkedIn search for big companies.
 *   3. Rank + select: score each person for outreach relevance, then pick a
 *      diverse, local-first set across persona types. CEO/CTO/founders are
 *      excluded (user rule: leaders come from engineering leadership below the
 *      C-suite). Two per persona where the surface allows (primary + backup).
 *
 * Cache: data/rosters/{slug}.json (incrementally updated; rerun = resume).
 * Needs the debug Chrome (scripts/chrome-debug.mjs start) logged into LinkedIn.
 *
 * Usage:
 *   node scripts/scan-roster.mjs --company gigaml [--out data/rosters/gigaml.json]
 *                                [--max 200] [--skip-visits] [--fresh]
 *                                [--company-id 123456] [--no-search]
 *                                [--max-visits 15] [--daily-cap 40] [--concurrency 1] [--visit-all]
 *                                [--auto-mode] [--search-only] [--no-auto-mode] [--large-threshold 800]
 *
 * LinkedIn depth (user-set 2026-07-25): --auto-mode reads the employee count off the
 * company page and skips the /people/ sweep for large companies (>= --large-threshold,
 * default 800), falling back to targeted persona search only — cheaper on the 40/day
 * profile budget and more accurate, since a big company's roster returns off-team people.
 * --search-only forces that path; --no-auto-mode forces the full sweep regardless of size.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import {
  check as checkBudget, CAPS as LI_CAPS,
  claim, cooldown, inCooldown, logEvent,
} from './li-budget.mjs';
import { assignPersonas, ladderFor, companyAliases, CORRUPTED } from './roster-score.mjs';
import { requireTargets } from './targets.mjs';

const PROFILE = requireTargets();
// Words naming the team that hires the target role (outreach.team_functions), e.g. ["data",
// "analytics"]; falls back to the primary role. Drives the leader/manager persona searches.
const TEAM_FNS = (PROFILE.outreach?.team_functions || []).map(String).filter(Boolean);
if (!TEAM_FNS.length) TEAM_FNS.push(PROFILE.targets.primary_role);
const ROLE_TERMS = PROFILE.targets.roles.map(String).filter(Boolean);
const reEsc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEAM_ALT = TEAM_FNS.map(reEsc).join('|');
const ROLE_ALT = ROLE_TERMS.map(reEsc).join('|');

// KILL-SWITCH: refuse ALL LinkedIn scraping while data/LINKEDIN_OFF exists (user-set 2026-06-17).
// This is the logged-in /people/ scraper, the one that risks the account — hard-stop before any launch.
if (existsSync(new URL('../data/LINKEDIN_OFF', import.meta.url))) {
  console.error('scan-roster: LinkedIn activity is OFF (data/LINKEDIN_OFF present). Remove that file to re-enable.');
  process.exit(0);
}
// CIRCUIT BREAKER: a 999/checkpoint/authwall seen by ANY earlier run persists a
// cooldown. drain-outreach.mjs spawns one process per company, so an in-memory
// backoff taught the next company nothing — this is the only thing that does.
const CD = inCooldown();
if (CD) {
  console.error(`scan-roster: LinkedIn COOLDOWN active until ${CD.until} (${CD.reason}). Not scraping.`);
  process.exit(0);
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) { args[k] = process.argv[++i]; }
    else args[k] = true;
  }
}
if (!args.company) {
  console.error('Usage: node scripts/scan-roster.mjs --company <linkedin-company-slug> [--out file] [--max N] [--skip-visits] [--fresh]');
  process.exit(1);
}

// --quiet: keep the budget lines, the outcome and any warning; drop the per-card and
// per-visit narration. Roster scans are the noisiest thing in the pipeline and the
// detail is only useful when debugging a specific scan. stderr is never suppressed.
const QUIET = args.quiet || process.env.CAREER_OPS_QUIET === '1';
if (QUIET) {
  const _log = console.log;
  const KEEP = /^(Done:|Persona coverage|Top picks|Roster ->|roster: no usable|roster: cache|search-budget|roster-budget|pre-filter|HARDENED|!|✗|✓)/;
  console.log = (...a) => { if (KEEP.test(String(a.join(' ')).trim())) _log(...a); };
}

const COMPANY = args.company;
const OUT = args.out || `data/rosters/${COMPANY}.json`;
const MAX = Number(args.max) || 200;
let COMPANY_ID = args['company-id'] || null; // numeric LinkedIn org id (for persona search)

// --- LinkedIn depth, matched to company size (user-set 2026-07-25) ---
// Small company  -> full /people/ roster sweep (the roster is representative there).
// Large company  -> targeted persona search only: cheaper on the 40/day profile budget
//                   AND more accurate, because a big company's roster returns off-team
//                   people (memory: feedback_outreach_large_company_targeted_search).
// --auto-mode decides from the employee count on the company page; --search-only forces
// targeted; --no-auto-mode forces the full sweep regardless of size.
// Auto-mode is now the DEFAULT (2026-07-25) — `--no-auto-mode` is the explicit
// opt-out, not the other way round. gen-outreach.mjs used to spawn this script with
// no depth flag at all, which meant a full /people/ sweep on a 10,000-person company.
const SEARCH_ONLY = !!args['search-only'];
const AUTO_MODE = !args['no-auto-mode'];
// 800 -> 60. Below ~60 employees one un-scrolled /people/ page genuinely IS the
// roster and beats search. Above it the roster is a non-representative sample that
// returns off-team people (memory: feedback_outreach_large_company_targeted_search)
// AND burns the profile budget — the worst of both.
const LARGE_THRESHOLD = Number(args['large-threshold']) || 60;
const TEAM_TOKENS = String(args['team-tokens'] || '').split(',').map(s => s.trim()).filter(Boolean);
const JD_KEYWORDS = String(args['jd-keywords'] || '').split(',').map(s => s.trim()).filter(Boolean);
const FN_WANTED = args['fn'] || 'target';
let EMPLOYEE_COUNT = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

mkdirSync('data/rosters', { recursive: true });
const cache = !args.fresh && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf-8')) : null;

// ---- relevance ranking ----
const EXCLUDE_RE = /\b(ceo|cto|coo|cfo|chief|founder|co-?founder)\b/i;
// Recall filter only (the persona decision lives in roster-score.mjs). Leader/manager rows
// require the target TEAM word next to the title, so a generic "Sales Director" is not read
// as the leader of the user's team.
const SCORERS = [
  { re: /recruit|talent|sourcer|people ops|people operations|people & |head of people|\bbizops\b|biz ?ops|\bhr\b|human resources/i, pts: 80, tag: 'recruiter' },
  { re: new RegExp(`\\b(vp|vice president|head|director)\\b[^|]*\\b(${TEAM_ALT})\\b`, 'i'), pts: 78, tag: 'team-leader' },
  { re: new RegExp(`\\b(${TEAM_ALT})\\b[^|]*\\b(vp|vice president|head|director)\\b`, 'i'), pts: 78, tag: 'team-leader' },
  { re: new RegExp(`\\b(${TEAM_ALT})\\b[^|]*\\b(manager|lead|supervisor)\\b|\\b(manager|lead|supervisor)\\b[^|]*\\b(${TEAM_ALT})\\b`, 'i'), pts: 68, tag: 'team-manager' },
  { re: new RegExp(`(${ROLE_ALT})`, 'i'), pts: 65, tag: 'peer-role' },
  { re: /\b(staff|principal|senior|lead)\b/i, pts: 35, tag: 'senior-ic' },
  { re: /product manager|\bpm\b/i, pts: 20, tag: 'product' },
];
function rank(person) {
  const hay = `${person.title || ''} ${person.headline || ''}`;
  if (EXCLUDE_RE.test(hay)) return { score: 0, tag: 'excluded-cxo', excluded: true };
  let best = { score: 5, tag: 'other', excluded: false };
  for (const s of SCORERS) if (s.re.test(hay) && s.pts > best.score) best = { score: s.pts, tag: s.tag, excluded: false };
  return best;
}
// NOTE: `TAG_FLOOR` / `finalRank` were deleted 2026-07-25. They were dead code:
// personaMatch() already requires a search hit to carry the searched tag before it
// is kept, and every floor value exactly equalled its tag's SCORERS points, so the
// floor could never raise a score. The SCORERS table below survives ONLY as the
// coarse recall filter deciding which search hits are worth keeping and which
// cards are worth visiting — the actual persona decision now lives in
// roster-score.mjs, which scores (level, function) as two independent axes.

// ---- browser ----
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
if (!ctx) { console.error('No browser context — is debug Chrome running? (node scripts/chrome-debug.mjs start)'); process.exit(1); }
const page = await ctx.newPage();

async function loadRoster() {
  const url = args['people-url'] || `https://www.linkedin.com/company/${COMPANY}/people/`;
  const c = claim('pageview', `company page ${COMPANY}`);
  if (!c.ok) { console.error(`roster: ${c.reason} — cannot open the company page.`); process.exit(0); }
  console.log(`roster: loading ${url}`);
  const resp0 = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await guard(page, resp0);
  await sleep(5000);
  const bodyHead = await page.evaluate(() => document.body.innerText.slice(0, 400));
  if (/authwall|join linkedin|sign in/i.test(bodyHead) && !/people/i.test(bodyHead)) {
    console.error('Authwall — log the debug Chrome profile into LinkedIn first.');
    process.exit(1);
  }
  // Capture the numeric org id (used to scope persona searches). It lives in the
  // "X employees" canned-search link: ...currentCompany=["74892218"]...
  if (!COMPANY_ID) {
    COMPANY_ID = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href*="currentCompany"]')]
        .map(x => decodeURIComponent(x.href).match(/currentCompany=\[?"?(\d+)"?\]?/)?.[1]).find(Boolean);
      return a || null;
    });
    if (COMPANY_ID) console.log(`roster: resolved company id ${COMPANY_ID}`);
  }
  // Employee count off the same page — the size signal for --auto-mode. The link text
  // reads like "1,234 employees" / "10K+ employees"; treat unparseable as unknown.
  EMPLOYEE_COUNT = await page.evaluate(() => {
    const txt = [...document.querySelectorAll('a, span, h2')]
      .map(e => (e.innerText || '').trim())
      .find(t => /^[\d,.]+(K|M)?\+?\s+(associated members|employees)/i.test(t));
    if (!txt) return null;
    const m = txt.match(/^([\d,.]+)(K|M)?/i);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (/k/i.test(m[2] || '')) n *= 1000;
    if (/m/i.test(m[2] || '')) n *= 1000000;
    return Math.round(n);
  });
  if (EMPLOYEE_COUNT != null) console.log(`roster: ~${EMPLOYEE_COUNT.toLocaleString()} employees on LinkedIn`);

  // AUTO MODE (user-set 2026-07-25): match LinkedIn depth to company size. At a large,
  // multi-team company the /people/ roster is the wrong instrument — it returns off-team
  // people (memory: feedback_outreach_large_company_targeted_search) AND burns the 40/day
  // profile budget. Skip the roster sweep there and let persona search do the work.
  if (SEARCH_ONLY || (AUTO_MODE && EMPLOYEE_COUNT != null && EMPLOYEE_COUNT >= LARGE_THRESHOLD)) {
    const why = SEARCH_ONLY ? 'forced (--search-only)' : `~${EMPLOYEE_COUNT.toLocaleString()} employees >= ${LARGE_THRESHOLD}`;
    console.log(`roster: SKIPPING the /people/ sweep — ${why}. Using targeted persona search only.`);
    if (!COMPANY_ID) console.log('roster: WARNING — no company id resolved, persona search will be unscoped. Pass --company-id N.');
    return [];
  }

  // We only reach here for a company under LARGE_THRESHOLD (~60), where one or two
  // pages genuinely IS the whole roster. The old loop ran until 7 consecutive stalls,
  // which on a big board was a long, machine-paced enumeration — the single most
  // bot-shaped access pattern we had, and programmatic scrollTo emits no wheel/pointer
  // events, so "scroll like a human" produced the exact absence-of-input signature it
  // was meant to avoid. Bounded to 3 expansions: enough to reach ~60 people, short
  // enough that it is no longer an enumeration.
  const MAX_EXPANSIONS = 3;
  let known = 0;
  for (let i = 0; i < MAX_EXPANSIONS; i++) {
    const count = await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      const btn = [...document.querySelectorAll('button')].find(b => /show more results/i.test(b.innerText));
      if (btn) btn.click();
      return new Set([...document.querySelectorAll('a[href*="/in/"]')].map(a => a.href.split('?')[0])).size;
    });
    if (count <= known) break; // nothing new — the roster is fully loaded
    known = count;
    if (known >= MAX) break;
    await sleep(jitter(1800, 3200));
  }
  const people = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('main a[href*="/in/"], .org-people__main a[href*="/in/"], a[href*="/in/"]')) {
      const url = a.href.split('?')[0];
      if (seen.has(url)) continue;
      let card = a;
      for (let i = 0; i < 7 && card; i++) {
        card = card.parentElement;
        if (card && (card.tagName === 'LI' || /profile-card/.test(card.className || ''))) break;
      }
      const NOISE = /^(connect|follow|message|view profile|view|out of network)$/i;
      // drop connection-degree lines in all their forms: "·", "· 2nd", "2nd",
      // "• 3rd+", "1st degree connection", and standalone middots.
      const DEGREE = /^[·•‧]?\s*(1st|2nd|3rd\+?)(\s*degree connection)?$|degree connection|^[·•‧]$/i;
      const lines = (card?.innerText || a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)
        .filter(s => !NOISE.test(s) && !DEGREE.test(s));
      if (!lines.length) continue;
      // name = first line; title = first following line that isn't the name or a
      // location-looking line (so the card title is the real job title).
      const name = lines[0];
      const LOC = /(Area|, [A-Z]{2}\b|United States|California|Greater )/;
      let title = '';
      for (let k = 1; k < lines.length; k++) {
        if (lines[k] === name) continue;
        if (!title && LOC.test(lines[k]) && lines[k].length < 40) continue; // skip a leading location
        title = lines[k]; break;
      }
      seen.set(url, { name, title, profileUrl: url });
    }
    return [...seen.values()];
  });
  console.log(`roster: captured ${people.length} unique profiles`);
  return people.slice(0, MAX);
}

// ---- persona search (NEW) ----
// Title-targeted people-search scoped to the company id. Surfaces recruiters /
// hiring managers / team leaders the /people/ page never lists. Parses the same
// result-card shape as the roster page.
const orQ = (xs) => xs.map(x => `"${x}"`).join(' OR ');
const PERSONA_QUERIES = [
  { tag: 'recruiter',    kw: 'recruiter OR talent OR recruiting OR "people ops"' },
  { tag: 'team-leader',  kw: orQ(TEAM_FNS.flatMap(f => [`head of ${f}`, `vp of ${f}`, `director of ${f}`, `${f} director`])) },
  { tag: 'team-manager', kw: orQ(TEAM_FNS.flatMap(f => [`${f} manager`, `manager, ${f}`, `${f} lead`])) },
  { tag: 'peer-role',    kw: orQ(ROLE_TERMS) },
];
async function searchPersona(kw, pg = page) {
  if (!COMPANY_ID) return [];
  // PAY FIRST. Until 2026-07-25 this function charged NOTHING — five queries per
  // company against a 30/day cap that nothing enforced, so in --search-only mode
  // (i.e. every large company, the exact case this script is for) a whole run was
  // free. Searches are also the lane LinkedIn's Commercial Use Limit meters.
  const c = claim('search', `persona-search ${COMPANY}`);
  if (!c.ok) { console.log(`search-budget: ${c.reason} — skipping remaining queries.`); return null; }
  const url = `https://www.linkedin.com/search/results/people/?currentCompany=%5B%22${COMPANY_ID}%22%5D&keywords=${encodeURIComponent(kw)}`;
  try {
    const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await guard(pg, resp);
    await sleep(jitter(2500, 4000));
    // ONE gentle scroll burst, page 1 only. Three bursts was deep pagination by
    // another name, and page-2+ results are progressively less relevant anyway.
    await pg.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.5)));
    await sleep(jitter(900, 1600));
    return await pg.evaluate(() => {
      const seen = new Map();
      const DEGREE = /^[·•‧]?\s*(1st|2nd|3rd\+?)(\s*degree connection)?$|degree connection|^[·•‧]$/i;
      const NOISE = /^(connect|follow|message|view profile|view|status is|premium|verified)/i;
      const MUTUAL = /mutual connection|is a mutual|are mutual|other mutual|followers?$/i;
      const LOC = /(Area|, [A-Z]{2}\b|United States|California|Greater )/;
      const DEG = /(•|·)\s*(1st|2nd|3rd)/;
      // LinkedIn renders each result as an OUTER <a href="/in/..."> card whose
      // text holds name + degree + headline + location; mutual-connection links
      // are nested <a>s inside it (short, name-only). Accept only card-level
      // anchors (own text carries a degree badge or a location line); nested
      // mutual anchors are skipped, which kept a Gong "mutual" out of results.
      for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
        const url = a.href.split('?')[0];
        if (!/\/in\//.test(url) || seen.has(url)) continue;
        const raw = a.innerText || '';
        if (!DEG.test(raw) && !LOC.test(raw)) continue; // not a card-level anchor
        let lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
        const cut = lines.findIndex(l => MUTUAL.test(l));
        if (cut > -1) lines = lines.slice(0, cut); // drop the mutual/followers tail
        lines = lines.filter(s => !DEGREE.test(s) && !NOISE.test(s));
        if (!lines.length) continue;
        const name = lines[0];
        if (!name || /^LinkedIn Member$/i.test(name)) continue;
        let title = '', location = '';
        for (let k = 1; k < lines.length; k++) {
          if (lines[k] === name) continue;
          if (LOC.test(lines[k]) && lines[k].length < 60) { if (!location) location = lines[k]; continue; }
          if (!title) title = lines[k];
        }
        seen.set(url, { name, title, location, profileUrl: url });
      }
      return [...seen.values()];
    });
  } catch (e) {
    if (e instanceof LiAbort) throw e;
    console.log(`  search "${kw.slice(0, 28)}..." failed: ${String(e).slice(0, 60)}`);
    return [];
  }
}

async function resolveCompanyId() {
  if (COMPANY_ID) return COMPANY_ID;
  try {
    const c = claim('pageview', `resolve org id ${COMPANY}`);
    if (!c.ok) { console.log(`persona-search: ${c.reason} — cannot resolve company id.`); return null; }
    const resp = await page.goto(`https://www.linkedin.com/company/${COMPANY}/people/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await guard(page, resp);
    await sleep(jitter(2500, 4000));
    COMPANY_ID = await page.evaluate(() => [...document.querySelectorAll('a[href*="currentCompany"]')]
      .map(x => decodeURIComponent(x.href).match(/currentCompany=\[?"?(\d+)"?\]?/)?.[1]).find(Boolean) || null);
    if (COMPANY_ID) console.log(`persona-search: resolved company id ${COMPANY_ID}`);
  } catch (e) { if (e instanceof LiAbort) throw e; /* else leave null */ }
  return COMPANY_ID;
}

// A search hit sometimes names a DIFFERENT current employer in its headline
// ("Analyst @ OtherCo") — LinkedIn's currentCompany filter is leaky
// on large orgs. Drop a hit when it explicitly names an employer that isn't ours.
// No employer named => keep (can't tell). companyToken is the slug minus suffix.
const COMPANY_TOKEN = COMPANY.toLowerCase().replace(/[-.].*$/, '');
function namesOtherEmployer(text) {
  const m = (text || '').match(/(?:@|\bat)\s+([A-Za-z0-9][\w .&'-]{1,30})/i);
  if (!m) return false;
  return !m[1].toLowerCase().includes(COMPANY_TOKEN);
}

async function augmentWithSearch(people) {
  if (args['no-search']) return people;
  await resolveCompanyId();
  if (!COMPANY_ID) { console.log('persona-search: skipped (could not resolve company id — pass --company-id N)'); return people; }
  const have = new Set(people.map(p => p.profileUrl));
  let added = 0;
  for (const q of PERSONA_QUERIES) {
    const hits = await searchPersona(q.kw);
    if (hits === null) break;   // budget/cooldown said stop — keep what we have
    let newHits = 0;
    for (const h of hits) {
      if (have.has(h.profileUrl)) continue;
      // Drop hits whose headline names a different current employer (leaky filter).
      if (namesOtherEmployer(h.title)) continue;
      // LinkedIn keyword search is fuzzy, so keep only hits whose card title
      // actually matches the persona family we searched for (drops the noise).
      if (!personaMatch(q.tag, rank(h), h)) continue;
      h.source = 'search'; h.searchTag = q.tag;
      people.push(h); have.add(h.profileUrl); added++; newHits++;
    }
    console.log(`persona-search [${q.tag}]: ${hits.length} cards, +${newHits} new`);
    await sleep(jitter(2000, 4000));
  }
  console.log(`persona-search: +${added} contacts the roster page missed`);
  return people;
}
// keep only hits that match the persona family we searched for
function personaMatch(qtag, r, h) {
  if (r.excluded) return false;
  const family = [qtag];
  if (family.includes(r.tag)) return true;
  if (qtag === 'recruiter' && /recruit|talent|people ops|people operations|biz ?ops/i.test(`${h.title} ${h.headline || ''}`)) return true;
  return false;
}

/**
 * Inspect a response + landed page for LinkedIn telling us to stop.
 * Throws LiAbort, which unwinds the whole run — never retries.
 *
 * The old code answered 999/429 with up to three MORE requests. 999 is LinkedIn's
 * request-denied code; retrying into it is an anti-circuit-breaker and is the
 * likeliest way a soft throttle becomes a hard one.
 */
class LiAbort extends Error {}
async function guard(pg, resp) {
  const status = resp?.status?.();
  if (status === 999 || status === 429) {
    cooldown(`HTTP ${status} from LinkedIn`, 6);
    throw new LiAbort(`HTTP ${status} — stopping and cooling down 6h`);
  }
  const url = pg.url() || '';
  if (/\/checkpoint\/|\/authwall|\/uas\/login/.test(url)) {
    cooldown(`challenge page: ${url.slice(0, 80)}`, 24);
    throw new LiAbort(`challenge/authwall (${url.slice(0, 60)}) — 24h cooldown, resolve manually`);
  }
  let body = '';
  try { body = await pg.evaluate(() => document.body.innerText.slice(0, 1200)); } catch { /* ignore */ }
  if (/unusual activity|security check|verify (it'?s|its) you|we'?ve restricted|temporarily restricted/i.test(body)) {
    cooldown('restriction/verification interstitial', 24);
    throw new LiAbort('LinkedIn showed a restriction/verification page — 24h cooldown');
  }
  if (/commercial use limit|monthly limit.*search/i.test(body)) {
    // The ONLY real calibration datapoint we will ever get about where the CUL sits.
    logEvent({ kind: 'cul-banner', status: 'seen', note: url.slice(0, 120) });
    cooldown('commercial use limit banner', 24, 'search');
    throw new LiAbort('Commercial Use Limit banner — search lane stopped, logged to data/li-events.tsv');
  }
  if (/\bSign in\b|\bJoin now\b/.test(body) && !/\/in\/|\/company\//.test(url)) {
    cooldown('session logged out', 12);
    throw new LiAbort('debug Chrome is no longer logged into LinkedIn — log in, then rerun');
  }
}

async function visitProfile(p, pg = page) {
  try {
    const resp = await pg.goto(p.profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await guard(pg, resp);
    await sleep(jitter(2500, 4500));
    const d = await pg.evaluate((cardName) => {
      const t = document.body.innerText;
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      // LinkedIn's current profile DOM has no h1; anchor on the card name, with
      // the nav block's "Advertise" line as fallback (name renders right after it).
      const NOISE = /degree connection|^·|^(1st|2nd|3rd\+?)$|^(Message|Follow|Connect|More|Contact info|Highlights|He\/Him|She\/Her|They\/Them|· \d)/i;
      let i = cardName ? lines.findIndex(l => l === cardName) : -1;
      if (i === -1) i = lines.findIndex(l => l === 'Advertise');
      const name = i > -1 && lines[i] !== 'Advertise' ? lines[i] : (i > -1 ? lines[i + 1] : null);
      let headline = null;
      const start = lines[i] === 'Advertise' ? i + 1 : i;
      if (start > -1) {
        for (let j = start + 1; j < Math.min(start + 10, lines.length); j++) {
          if (lines[j] === name || NOISE.test(lines[j])) continue;
          headline = lines[j]; break;
        }
      }
      const loc = t.match(/\n([A-Z][^\n]*?(?:Area|California|United States|, [A-Z]{2}))\n/)?.[1] || null;
      // recent post: lines following the Activity header, minus chrome
      let recentPost = null;
      const ai = lines.findIndex(l => /^Activity$/.test(l));
      if (ai > -1) {
        const POST_NOISE = /^(\d[\d,]* followers?|Follow|Posts|Comments|Images|Videos|Show all|Load more|·|\d+[dwmo] ?(• Edited)? ?·?)$/i;
        const body = lines.slice(ai + 1, ai + 14).filter(l => l !== name && !POST_NOISE.test(l) && !/no recent posts/i.test(l));
        recentPost = body.join(' ').slice(0, 280) || null;
      }
      return { name, headline, location: loc, recentPost };
    }, p.name);
    // A page that loads but yields neither name nor headline means the session is
    // degraded. Caching that as visited:true with null fields silently poisons
    // outreach, so refuse to record it.
    if (!d.name && !d.headline) return { ...p, visited: false, visitError: 'empty extract' };
    return { ...p, name: d.name || p.name, headline: d.headline, location: d.location, recentPost: d.recentPost, visited: true };
  } catch (e) {
    if (e instanceof LiAbort) throw e;              // never swallow a stop signal
    return { ...p, visited: false, visitError: String(e).slice(0, 120) };
  }
}

// ---- main ----
let people;
if (cache?.people?.length) {
  people = cache.people;
  if (cache.companyId && !COMPANY_ID) COMPANY_ID = cache.companyId;
  console.log(`cache: resuming with ${people.length} people (${people.filter(p => p.visited).length} already visited)`);
} else {
  people = await loadRoster();
}

// 1b. Persona search — merge in recruiters/HMs/team leaders the /people/ page misses.
people = await augmentWithSearch(people);

// Pre-filter: rank each person by their ROSTER CARD title first and skip the
// low-relevance ones entirely (no profile visit). Threshold is permissive —
// anything scoring above a generic IC (>5) is visited; CxO are excluded. This
// cuts ~72 down to the ~15-20 that matter. Override with --visit-all or tune
// with --min-card <score>.
// Defined here (not after the visit loop) because the provisional finalist pass below
// needs it to decide WHO to spend visits on.
const scoreCtx = {
  aliases: companyAliases(COMPANY, [cache?.company, args['company-name']].filter(Boolean)),
  teamTokens: TEAM_TOKENS,
  jdKeywords: JD_KEYWORDS,
  fnWanted: FN_WANTED,
  employeeCount: EMPLOYEE_COUNT ?? cache?.employeeCount,
};

const CARD_MIN = args['visit-all'] ? -1 : (Number(args['min-card']) || 6);
function shouldVisit(p) {
  if (p.visited) return false;
  const r = rank(p); // uses card title (p.title) when no headline yet
  return !r.excluded && r.score >= CARD_MIN;
}

if (!args['skip-visits']) {
  // Apply card-stage relevance to everyone first (so skipped people still carry a tag).
  for (const p of people) { const r = rank(p); p.cardScore = r.score; p.cardTag = r.tag; p.excluded = p.excluded || r.excluded; }
  const queue = people.map((p, idx) => ({ p, idx })).filter(({ p }) => shouldVisit(p));
  const skipped = people.filter(p => !p.visited && !p.excluded && p.cardScore < CARD_MIN).length;
  console.log(`pre-filter: ${queue.length} relevant to visit, ${skipped} low-relevance skipped, ${people.filter(p => p.excluded).length} CxO excluded (card-stage)`);

  // ── HARDENED VOLUME CONTROLS (2026-06-17, after a LinkedIn automation flag) ──
  // Root cause of the flag: 3 back-to-back roster scans visited ~246 profiles in ~1h.
  // Defenses: (1) keep only the most-relevant profiles, (2) hard per-run cap, (3) a
  // per-DAY budget shared across runs so bursts can't accumulate. Prefer the targeted
  // LinkedIn search (.claude/skills/career-finder/modes/outreach.md) over scanning a whole roster on big companies.
  //
  // The daily budget lives in the shared linkedin-stealth counter (li-budget.mjs
  // → pace.mjs), NOT a private file. Before 2026-07-25 this script kept its own
  // data/_roster-budget.json, so agent-driven browsing and script runs each got a
  // full "daily" allowance against the same account. One counter now.
  // 15 -> 2. Measured 2026-07-25 across 816 cached visits: the visited headline is
  // byte-identical to the free card title 98.4% of the time, and 13 of 17 companies
  // produce an IDENTICAL selection with zero visits. A visit is worth an action on
  // exactly two conditions — repairing a corrupted card, and breaking a thin tie on
  // the highest-weight slot — so the cap is the number of those we expect per company.
  // 2 -> 6 (user-set 2026-07-26: "for all outreach spend profile visits").
  // 2 was sized on the finding that a visited headline matches the free card title 98.4%
  // of the time — true, but it optimised the wrong thing. The headline is not what a visit
  // buys; `recentPost` is, and that hook is the difference between an opener that references
  // something real and one that says "I've been digging into what {Company} is building".
  // 6 covers the full persona set (2 x HM/Recruiter/Leader), so every contact that reaches
  // a draft has been seen. The daily/weekly/burst horizons still bound the total.
  const PER_RUN_CAP = Number(args['max-visits']) || 6;
  const DAILY_CAP = Number(args['daily-cap']) || LI_CAPS.profile;
  const spent = checkBudget('profile');
  // Honor a stricter --daily-cap than the shared cap, but never a looser one.
  const effectiveCap = Math.min(DAILY_CAP, spent.cap);
  const remainingToday = Math.max(0, effectiveCap - spent.used);
  // Rank the queue by card relevance so the cap keeps the most useful contacts.
  // VISIT THE FINALISTS FIRST (user-set 2026-07-26: "for all outreach spend profile visits").
  //
  // Sorting by raw cardScore spends the visit budget in ranking order, which is NOT the
  // same as the people who end up in drafts. On 2026-07-26 that sent both of Luma AI's
  // visits to contacts that had already been rejected, while the actual Hiring Manager in
  // the drafts (Head of Engineering) stayed unvisited and therefore had no recent-post
  // hook — so his email opened with a generic company line instead of anything personal.
  //
  // A visit's whole value is the hook (headline is byte-identical to the card 98.4% of the
  // time; `recentPost` is the part only a visit can get). So run a PROVISIONAL persona
  // assignment on card data and visit those finalists first — every person who will appear
  // in a draft gets enriched before anyone who won't.
  let provisional = new Set();
  try {
    const prov = assignPersonas(people.filter(p => !p.excluded), scoreCtx);
    for (const s of (prov.selection || [])) if (s.profileUrl) provisional.add(s.profileUrl);
    if (provisional.size) console.log(`visit-priority: ${provisional.size} provisional finalist(s) queued ahead of card rank`);
  } catch { /* provisional pass is best-effort; fall back to card rank */ }
  queue.sort((a, b) => {
    const fa = provisional.has(a.p.profileUrl) ? 1 : 0;
    const fb = provisional.has(b.p.profileUrl) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return (b.p.cardScore || 0) - (a.p.cardScore || 0);
  });
  const capN = Math.min(queue.length, PER_RUN_CAP, remainingToday);
  if (capN < queue.length) {
    console.log(`HARDENED: visiting top ${capN}/${queue.length} by relevance (per-run cap ${PER_RUN_CAP}, daily budget ${remainingToday}/${effectiveCap} left). Override: --max-visits N / --daily-cap N.`);
  }
  const deferred = queue.slice(capN); // over-cap: NOT to be visited this run, by any path
  queue.length = capN; // truncate in place to the allowed count
  const attempted = new Set(queue.map(({ idx }) => idx)); // only these may be retried below
  if (capN === 0) {
    console.log('HARDENED: daily roster-visit budget exhausted — skipping profile visits this run (card-stage data + cache only).');
  }

  // Worker pool. HARDENED: default SEQUENTIAL (1 lane) — parallel profile loads are a
  // strong automation signal. Allow at most 2 via --concurrency, never the old 3-6.
  // Hard 1, no override. Overlapping in-flight profile loads from one member id is
  // a clean automation tell, and --concurrency 2 bought ~3 minutes on a run that is
  // now 2 visits long anyway. (config/narrative.md told agents to pass 3; fixed.)
  const LANES = 1;
  let qi = 0, done = 0;
  const saveLock = { busy: false };
  const save = () => {
    // partial:true — this snapshot has no `selection` yet. Consumers MUST refuse to
    // treat it as a usable roster (see the note on the final write below).
    writeFileSync(OUT, JSON.stringify({
      company: COMPANY, companyId: COMPANY_ID, employeeCount: EMPLOYEE_COUNT,
      scannedAt: new Date().toISOString(), partial: true, total: people.length, people,
    }, null, 1));
  };
  async function worker(lane) {
    const pg = lane === 0 ? page : await ctx.newPage();
    try {
      while (qi < queue.length) {
        const { p, idx } = queue[qi++];
        // Charge BEFORE the load, not after the run. A crash or Ctrl-C used to
        // discard the whole run's count, handing back visits that already hit
        // LinkedIn. Pay first, then act.
        //
        // Must be claim(), NOT spend(): spend() only touches the day counter and
        // writes no event, so profile visits were invisible to horizons() — the
        // weekly cap never fired and BURST_PER_HOUR never saw the one loop it was
        // built for (drain-outreach spawns a process per company, so three
        // companies was ~45 visits in ~25 min with nothing able to observe it).
        // claim() also re-checks the persisted cooldown between visits.
        const b = claim('profile', `${COMPANY} ${p.name || ''}`.trim());
        if (!b.ok) { console.log(`roster-budget: profile visits stopped — ${b.reason}`); break; }
        people[idx] = await visitProfile(p, pg);
        const r = rank(people[idx]); // re-rank on full headline
        people[idx].relevance = r.score; people[idx].tag = r.tag; people[idx].excluded = r.excluded;
        done++;
        save(); // incremental => resumable
        if (done % 5 === 0) console.log(`profiles: ${done}/${queue.length} visited (${LANES} lane${LANES > 1 ? 's' : ''})`);
        await sleep(jitter(6000, 12000)); // HARDENED: human-like 6-12s spacing between profile views
      }
    } finally {
      if (lane !== 0) await pg.close();
    }
  }
  await Promise.all(Array.from({ length: LANES }, (_, l) => worker(l)));

  // Mop-up: retry the profiles THIS RUN attempted and failed (transient load
  // errors under concurrency). Scoped to `attempted` on purpose — it used to
  // select every unvisited relevant person in the roster, which silently
  // re-included everyone the caps had just excluded and walked them at 3-6s
  // spacing. That defeated both caps and is the likeliest cause of the
  // 2026-06-17 flag surviving the original hardening.
  const stragglers = people
    .map((p, idx) => ({ p, idx }))
    .filter(({ p, idx }) => attempted.has(idx) && !p.visited && !p.excluded && p.cardScore >= CARD_MIN);
  if (stragglers.length) {
    console.log(`mop-up: retrying ${stragglers.length} failed visits sequentially...`);
    for (const { p, idx } of stragglers) {
      const b = claim('profile', `mop-up ${COMPANY} ${p.name || ''}`.trim());
      if (!b.ok) { console.log(`roster-budget: mop-up abandoned — ${b.reason}`); break; }
      people[idx] = await visitProfile(p, page);
      const r = rank(people[idx]);
      people[idx].relevance = r.score; people[idx].tag = r.tag; people[idx].excluded = r.excluded;
      save();
      await sleep(jitter(6000, 12000)); // same spacing as the main loop; 3-6s was a second bot tell
    }
  }
  if (deferred.length) {
    console.log(`deferred: ${deferred.length} relevant profiles left unvisited by the caps — rerun tomorrow to resume (cache makes it incremental).`);
  }
  const failed = people.filter(p => p.visited === false && !p.excluded && p.cardScore >= CARD_MIN);
  if (failed.length) console.log(`warning: ${failed.length} relevant profiles could not be loaded after retries: ${failed.map(p => p.name).join(', ')}`);

  // Visits were charged as they happened (see the worker loop), so nothing to
  // reconcile here — just report where the shared daily budget stands.
  const after = checkBudget('profile');
  console.log(`roster-budget: ${after.used}/${after.cap} profile views used today (shared with linkedin-stealth pace.mjs).`);
}
// ── Selection (rewritten 2026-07-25) ─────────────────────────────────────
// Everything below the old flat-score selection is replaced by roster-score.mjs.
// What changed and why (all three verified against these cached rosters):
//   * (level, function) are parsed as TWO axes. The old single score tagged
//     labelbox's "Head of Forward Deployed Engineers" as a PEER — and peers are
//     dropped from drafts — so the actual hiring manager was found and discarded
//     while the run reported full persona coverage.
//   * Past-employer clauses are stripped before the level parse, so openai's
//     "Software Engineer AI/ML, OpenAI, ex: ... VP Engineering@Upstart" is an IC
//     again instead of a Leader.
//   * Persona allocation scales with company size instead of always giving the
//     Leader two slots and the Hiring Manager one, which was backwards everywhere.
//   * There is NO top-up. The old code padded the selection to six with whoever
//     ranked next, which is how "Lead Development Representative at TeleNet
//     Marketing Solutions" became an Uber contact. Unfilled slots are reported.
const result = assignPersonas(people.filter(p => !p.excluded), scoreCtx);
const { selection, unresolvedAuthority, missingPersonas, personaCounts } = result;
for (const p of people) {
  const s = result.scored.find(x => x.profileUrl === p.profileUrl);
  if (s) { p.relevance = s.score; p.level = s.level; p.fn = s.fn; p.evidence = s.evidence; }
}

if (unresolvedAuthority.length) {
  console.log(`company-unconfirmed (kept out of auto-pick — headline names no employer, can't confirm they're at ${COMPANY}): ${unresolvedAuthority.map(p => `${p.name} [${p.persona}]`).join(', ')}`);
}

const out = {
  company: COMPANY,
  companyId: COMPANY_ID,
  employeeCount: EMPLOYEE_COUNT ?? cache?.employeeCount ?? null,
  scannedAt: new Date().toISOString(),
  // `partial` is the marker that this file is a COMPLETE result. The incremental
  // save() inside the visit loop writes partial:true; only this final write clears
  // it. Without it, an interrupted run left a roster with no `selection` at all,
  // which drain-outreach.mjs then treated as a fresh cache for 30 days while
  // gen-outreach.mjs read `selection || []` — i.e. silently drafted outreach with
  // ZERO contacts. data/rosters/lumalabsai.json was in exactly that state.
  partial: false,
  ladder: result.ladder,
  total: people.length,
  visited: people.filter(p => p.visited).length,
  fromSearch: people.filter(p => p.source === 'search').length,
  excludedCxO: people.filter(p => p.excluded).map(p => `${p.name} (${p.title || p.headline})`),
  personaCounts,
  missingPersonas,
  unconfirmedAuthority: unresolvedAuthority.map(p => `${p.name} [${p.persona}] — ${p.headline || p.title} — ${p.profileUrl}`),
  selection,
  people,
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nDone: ${out.total} people (${out.fromSearch} via persona-search), ${out.visited} visited, ${out.excludedCxO.length} CxO/founders excluded.`);
console.log(`Persona coverage: ${Object.entries(personaCounts).map(([k, v]) => `${k}:${v}`).join('  ') || 'none'}${missingPersonas.length ? `  (MISSING: ${missingPersonas.join(', ')})` : '  — all covered'}`);
console.log('Top picks:');
for (const s of selection) console.log(`  [${s.persona} ${s.relevance} lvl${s.level}/${s.fn}/${s.evidence}${s.source === 'search' ? ' search' : ''}] ${s.name} — ${s.headline || s.title} — ${s.location || ''} — ${s.profileUrl}`);
console.log(`\nRoster -> ${OUT}`);
await page.close();
process.exit(0);
