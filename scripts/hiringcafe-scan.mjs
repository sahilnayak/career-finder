#!/usr/bin/env node

/**
 * hiringcafe-scan.mjs — the HiringCafe lane. Zero LLM cost, zero browser.
 *
 * WHY THIS EXISTS. HiringCafe aggregates job postings and — critically — carries the
 * EMPLOYER'S OWN canonical ATS apply URL for each one, plus a structured extraction of
 * the posting (years-of-experience gate, workplace type, compensation band, seniority,
 * degree requirement). That combination is what makes it useful where other aggregators and
 * LinkedIn are not: it is a discovery surface that hands back the primary source.
 *
 * WHY IT IS CHEAP. The site server-renders its results into a `__NEXT_DATA__` script tag,
 * so a plain HTTPS GET returns the full structured hit list — no `claude -p`, no API key.
 * This is the same class of lane as scan.mjs — never replace it with an agent pass.
 *
 * BROWSER FALLBACK (added 2026-09-15). hiringcafe.com started answering every plain HTTP
 * request — curl, node fetch, any header combination, even a bare GET of `/` with no query
 * string — with a Cloudflare bot-management challenge (`cf-mitigated: challenge`, HTTP 403).
 * The already-warmed debug-Chrome profile this project runs on :9222 for LinkedIn/board work
 * clears it with no visible interstitial, so `fetchPage()` tries the plain GET first (still
 * the cheap path, and the one that resumes working for free if Cloudflare relaxes) and only
 * opens a CDP tab — via cdp.mjs, never Playwright, never the chrome-devtools MCP (unavailable
 * in `claude -p` cron mode anyway) — when that GET is rejected.
 *
 * WHAT IT DOES NOT DO — READ THIS BEFORE TRUSTING A DATE.
 * `v5_processed_job_data.estimated_publish_date` is HiringCafe's *estimate*, and
 * `dateFetchedPastNDays` filters on when HiringCafe INDEXED the posting, not when the
 * employer published it. Both are aggregator claims, so rows carry the date tagged
 * `hiringcafe-claim:<iso>` and never as a verified publish date.
 *
 * AGE IS NOT A GATE ON THIS LANE (user-set 2026-08-24). A role surfaced here is one the
 * employer is actively re-listing, and re-listing means still hiring — so a stale ATS
 * publish date does not disqualify it. The ATS is still resolved downstream, every time,
 * for four things it alone can answer: the req still exists and is open, the canonical JD,
 * the real location (isRemote flags lie in both directions), and comp. Only the clock
 * stopped being a gate. The real age is still RECORDED, because it moves the legitimacy
 * tier and a long-open req deserves to be named as one.
 *
 * WHAT IT IS UNUSUALLY GOOD AT.
 *   1. `min_industry_and_role_yoe` — the tenure gate as an integer. That gate is what
 *      disqualifies many roles this pipeline finds, and here it is readable
 *      before a single JD is fetched.
 *   2. `position_employer_type` — "Internal Position" vs anything else separates real
 *      employers from staffing intermediaries, which is a filter this project has
 *      otherwise had to build one blocklist entry at a time.
 *   3. `source` + `board_token` — feeds data/_discovered-companies.tsv and grows the ATS
 *      index, including families the sweep cannot yet parse (e.g. `gem`), which is the
 *      coverage problem the index has.
 *
 * SEARCH GEOMETRY comes from config/profile.yml `location`: center `lat`/`lng` (required),
 * `radius_mi` (default 50), optional `postal_code`, labelled with city/state/country.
 * `dateFetchedPastNDays` defaults to pipeline.hiringcafe_days (7). One search runs per `targets.roles` entry
 * (SEARCH_KEYWORDS), deduped case-insensitively and capped at 6. targets.title_keywords are for
 * recognising titles, not for searching, so they are never sent as queries.
 *
 * Rate limiting: queries run sequentially with 3-6s jittered spacing. A 429 honours Retry-After,
 * else backs off 15/30/60s, all inside a global ~170s budget. If the first two queries both end
 * in 429 the run stops (circuit breaker) and exits 3.
 *
 * Usage:
 *   node scripts/hiringcafe-scan.mjs                 # scan + append rows (the cron lane)
 *   node scripts/hiringcafe-scan.mjs --dry-run       # scan, print, write nothing
 *   node scripts/hiringcafe-scan.mjs --days 7        # widen the indexed-since window
 *   node scripts/hiringcafe-scan.mjs --sources       # diagnostic: ATS family histogram
 *   node scripts/hiringcafe-scan.mjs --quiet         # summary line only
 *   node scripts/hiringcafe-scan.mjs --help          # usage, no sweep
 *
 * Exit codes: 0 ok, 1 profile not set up, 3 one or more queries failed after retries (or rate-limited).
 */

import { record as recordRequest } from './request-ledger.mjs';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { requireTargets, loadTargets, loadNoise, titleDropped, titleMatches, SEARCH_KEYWORDS, locationMatches, areaLabel } from './role-filters.mjs';
import * as TG from './targets.mjs';
import { cdpAlive, newPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log(`Usage: node scripts/hiringcafe-scan.mjs [options]

Searches hiringcafe.com for every targets.roles entry (max 6) around location.lat/lng
and appends matches to data/_web-roles.tsv (metadata to data/_hiringcafe.tsv).

Options:
  --dry-run        scan and print, write nothing
  --days N         indexed-since window (default pipeline.hiringcafe_days, 7)
  --max-pages N    pages per query (default 5)
  --sources        diagnostic: ATS family histogram only
  --quiet          summary line only
  --no-browser     never fall back to the debug Chrome on :9222 (also CAREER_FINDER_NO_BROWSER=1)
  --help           this message

Exit: 0 ok, 1 profile missing, 3 a query failed after retries.`);
  process.exit(0);
}

requireTargets();
const PROFILE = loadTargets();

const DRY = has('--dry-run');
const NO_BROWSER = has('--no-browser') || process.env.CAREER_FINDER_NO_BROWSER === '1';
const QUIET = has('--quiet') || (process.env.CAREER_FINDER_QUIET || process.env.CAREER_OPS_QUIET) === '1';
const DAYS = Number(val('--days', String(PROFILE.pipeline?.hiringcafe_days || 7))) || 7;
const MAX_PAGES = Number(val('--max-pages', '5'));
const SOURCES_MODE = has('--sources');

const WEB_ROLES = 'data/_web-roles.tsv';
const SIDECAR = 'data/_hiringcafe.tsv';
const DISCOVERED = 'data/_discovered-companies.tsv';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const LOC = PROFILE.location;

// ── Profile-driven gates. Prefer the shared helpers in targets.mjs; fall back to equivalent
// local logic so this lane keeps working if a helper is absent.
const MGMT_RE = /\b(manager|director|lead|head)\b/i;
const INCLUDE_MGMT = typeof PROFILE.targets.include_management === 'boolean'
  ? PROFILE.targets.include_management
  : PROFILE.targets.roles.some((r) => MGMT_RE.test(r));
const DEALBREAKERS = (PROFILE.targets.dealbreakers || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
const CAND_YEARS = Number(PROFILE.candidate?.years);
const MAX_YOE_OVER = Number(PROFILE.pipeline?.max_yoe_over ?? 2);

function dealbreakerHit(company, title) {
  if (typeof TG.dealbreakerHit === 'function') return TG.dealbreakerHit(company, title);
  const s = `${company} ${title}`.toLowerCase();
  return DEALBREAKERS.find((d) => s.includes(d)) || null;
}

// 'drop' when TG.yoeTooHigh (beyond candidate.years + max_yoe_over), 'stretch' when over
// candidate.years at all, '' otherwise.
function yoeFit(minYoe) {
  if (TG.yoeTooHigh(minYoe)) return 'drop';
  const need = Number(minYoe);
  if (minYoe === '' || minYoe == null || !Number.isFinite(need) || !Number.isFinite(CAND_YEARS)) return '';
  return need > CAND_YEARS ? 'stretch' : '';
}

// Structured workplace_type is the source of truth for remote vs on-site; never splice a
// fake "; Remote" into the free-text location.
function workplaceAllowed(wt, loc, title) {
  // targets.workplaceAllowed(wt) only judges the type against remote_policy; the location still decides.
  if (typeof TG.workplaceAllowed === 'function' && !TG.workplaceAllowed(wt)) return false;
  if (/remote/i.test(wt)) return TG.remoteAllowed(loc || 'Remote', title);
  return !!loc && locationMatches(loc, title);
}

const normTitle = (t) => t.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// HiringCafe's searchState location object, built from the profile. lat/lng are required:
// HiringCafe filters on a radius around a point, and a missing center would silently search
// nowhere (or everywhere), which is indistinguishable from a quiet market.
function buildLocation(l) {
  if (l.lat == null || l.lng == null || Number.isNaN(Number(l.lat)) || Number.isNaN(Number(l.lng))) {
    console.error('hiringcafe: location.lat / location.lng are not set in config/profile.yml — ' +
      'add the coordinates of your city (onboarding fills these) and re-run.');
    process.exit(1);
  }
  const country = l.country || 'United States';
  const countryShort = /^(us|usa|united states)/i.test(country) ? 'US' : country;
  const comps = [];
  if (l.postal_code) comps.push({ long_name: String(l.postal_code), short_name: String(l.postal_code), types: ['postal_code'] });
  if (l.city) comps.push({ long_name: l.city, short_name: l.city, types: ['locality'] });
  if (l.state) comps.push({ long_name: l.state, short_name: l.state, types: ['administrative_area_level_1'] });
  comps.push({ long_name: country, short_name: countryShort, types: ['country'] });
  const label = [l.city, l.state, countryShort].filter(Boolean).join(', ');
  const slug = (l.postal_code ? `zip-${l.postal_code}` : `${l.city || 'loc'}-${l.state || ''}`)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  return {
    id: `${countryShort.toLowerCase()}-${slug}`,
    ...(l.postal_code ? { postal_code: String(l.postal_code) } : {}),
    types: [l.postal_code ? 'postal_code' : 'locality'],
    formatted_address: label,
    address_components: comps,
    geometry: { location: { lat: Number(l.lat), lon: Number(l.lng) } },
    ...(l.postal_code ? { postal_code_source: 'geonames' } : {}),
    workplace_types: [],
    options: { radius: Number(l.radius_mi) || 50, radius_unit: 'miles', ignore_radius: false },
  };
}
const LOCATION = buildLocation(LOC);

// Queries: targets.roles only (title_keywords are for recognition, not search), deduped
// case-insensitively, capped so the worst case stays inside the runtime budget.
const MAX_QUERIES = 6;
const QUERIES = (() => {
  const out = [], seenQ = new Set();
  for (const r of SEARCH_KEYWORDS) {
    const k = String(r).trim(), lk = k.toLowerCase();
    if (k && !seenQ.has(lk)) { seenQ.add(lk); out.push(k); }
  }
  return out.slice(0, MAX_QUERIES);
})();

// source token -> the board root the index stores in column 3. Families the sweep cannot
// parse yet are mapped to null and reported, not silently dropped: knowing that N local
// target roles sit on Gem is itself the finding.
const BOARD_ROOT = {
  grnhse: (t) => `https://job-boards.greenhouse.io/${t}`,
  greenhouse: (t) => `https://job-boards.greenhouse.io/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  smartrecruiters: (t) => `https://careers.smartrecruiters.com/${t}`,
  workable: (t) => `https://apply.workable.com/${t}`,
  recruitee: (t) => `https://${t}.recruitee.com`,
  bamboohr: (t) => `https://${t}.bamboohr.com`,
  teamtailor: (t) => `https://${t}.teamtailor.com`,
  rippling: (t) => `https://ats.rippling.com/${t}`,
};

// Try the cheap path — a plain GET with browser-shaped headers. Cloudflare now answers this
// with a bot-management challenge on every request regardless of headers (confirmed
// 2026-09-15: even a bare `curl https://hiringcafe.com/` with no query string 403s), but the
// check costs one round trip and stays correct for the day that stops being true.
async function fetchViaPlainHttp(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
    });
  } catch (e) { recordRequest(url, { status: 'error' }); throw e; }
  recordRequest(url, { status: res.status });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`); e.status = res.status;
    e.retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    throw e;
  }
  return res.text();
}

let cdpChecked = false, cdpOk = false;
let CF_BLOCKED = false; // set once a 403 is seen with the browser disabled

// Last resort: the shared debug-Chrome profile (port 9222) that LinkedIn and browser-boards
// already use. Its cookies/TLS fingerprint clear Cloudflare's challenge with no visible
// interstitial — confirmed by loading the exact same searchState URL through it and getting a
// 200 with __NEXT_DATA__ intact. Never Playwright (banned repo-wide, broken against current
// Chrome) and never the chrome-devtools MCP (not available in `claude -p` cron mode).
async function fetchViaBrowser(url) {
  // --no-browser / CAREER_FINDER_NO_BROWSER=1: never touch the shared :9222 Chrome (e.g. while a
  // LinkedIn session owns it, or in discovery-audit --live).
  if (NO_BROWSER) throw new Error('browser fallback disabled (--no-browser)');
  recordRequest(url, { status: 'cdp' });
  if (!cdpChecked) { cdpChecked = true; cdpOk = !!(await cdpAlive()); }
  if (!cdpOk) throw new Error('debug Chrome not running on :9222 (start with: node scripts/chrome-debug.mjs start)');
  let tab;
  try {
    tab = await newPage();
    const nav = await tab.navigate(url);
    if (nav.status && nav.status >= 400) {
      const e = new Error(`HTTP ${nav.status} (browser)`); e.status = nav.status; throw e;
    }
    return await tab.evaluate(() => document.documentElement.outerHTML);
  } finally {
    try { await tab?.close(); } catch { /* tab already gone */ }
  }
}

async function fetchPage(searchQuery, page) {
  const state = { locations: [LOCATION], searchQuery, dateFetchedPastNDays: DAYS };
  let url = 'https://hiringcafe.com/?searchState=' + encodeURIComponent(JSON.stringify(state));
  if (page > 0) url += `&page=${page}`;

  let html;
  try {
    html = await fetchViaPlainHttp(url);
  } catch (plainErr) {
    try {
      html = await fetchViaBrowser(url);
    } catch (e) {
      // --no-browser + a Cloudflare 403: there is no path that can succeed, so stop the lane now
      // instead of burning the runtime budget on 15/30/60s backoffs (~157s/role in the 10-04 smoke).
      if (NO_BROWSER && plainErr.status === 403) { CF_BLOCKED = true; plainErr.blocked = true; plainErr.message += " (Cloudflare block, browser disabled; not retrying)"; throw plainErr; }
      // A 429 on either path is a rate limit; keep the server's Retry-After if it sent one.
      if (plainErr.status === 429 && !e.status) { e.status = 429; }
      if (e.status === 429 && plainErr.retryAfter != null) e.retryAfter = plainErr.retryAfter;
      throw e;
    }
  }

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  // No __NEXT_DATA__ means the SSR contract changed. Fail loudly: a silent zero here is
  // indistinguishable from a quiet market, which is the exact failure mode the LinkedIn lane
  // spent two days in.
  if (!m) throw new Error(`no __NEXT_DATA__ for "${searchQuery}" page ${page} — SSR contract changed?`);
  const p = JSON.parse(m[1]).props.pageProps;
  if (p.ssrError) throw new Error(`hiringcafe error for "${searchQuery}": ${p.ssrError}`);
  return { hits: p.ssrHits || [], last: p.ssrIsLastPage, total: p.ssrTotalCount, page: p.ssrPage };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 3000 + Math.floor(Math.random() * 3000); // 3-6s between requests

// Retry-After is either delta-seconds or an HTTP date. Returns seconds or null.
function parseRetryAfter(v) {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, (t - Date.now()) / 1000);
}

// Global wall-clock budget: the whole run must finish in < 3 min, worst case.
const STARTED = Date.now();
const BUDGET_MS = 170_000;
const remaining = () => BUDGET_MS - (Date.now() - STARTED);
const BACKOFF_S = [15, 30, 60];

// Retry 429s (Retry-After, else 15/30/60s) and transient errors, within the budget.
// Throws after the last attempt; the error carries .status (429 = rate-limited).
async function collectWithRetry(searchQuery) {
  for (let i = 0; ; i++) {
    if (CF_BLOCKED) { const e = new Error("HTTP 403 (Cloudflare block, browser disabled; skipped)"); e.status = 403; throw e; }
    try { return await collect(searchQuery); }
    catch (e) {
      if (e.blocked || i >= BACKOFF_S.length) throw e;
      const base = e.status === 429 && e.retryAfter != null ? e.retryAfter : BACKOFF_S[i];
      const wait = Math.min(base, 120) * 1000;
      if (wait > remaining() - 5000) { e.message += ' (runtime budget exhausted)'; throw e; }
      if (!QUIET) console.error(`hiringcafe: "${searchQuery}" ${e.message}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

async function collect(searchQuery) {
  const out = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(jitter());
    const r = await fetchPage(searchQuery, page);
    out.push(...r.hits);
    if (r.last || r.hits.length === 0) return { hits: out, total: r.total, truncated: false };
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { hits: out, total: null, truncated };
}

// ---------------------------------------------------------------------------

const NOISE = loadNoise();

function alreadyKnown() {
  const urls = new Set();
  for (const f of ['data/scored-jobs.tsv', 'data/_candidates.tsv', WEB_ROLES]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      for (const tok of line.split('\t')) {
        const t = tok.trim().toLowerCase();
        if (t.startsWith('http')) urls.add(t.replace(/[?#].*$/, ''));
      }
    }
  }
  return urls;
}

function indexedBoards() {
  const roots = new Set();
  if (!existsSync('data/company-index.tsv')) return roots;
  for (const line of readFileSync('data/company-index.tsv', 'utf-8').split('\n')) {
    const c = line.split('\t');
    if (c[2]) roots.add(c[2].trim().toLowerCase().replace(/\/+$/, ''));
  }
  return roots;
}

const stats = {
  raw: 0, expired: 0, notInternal: 0, noise: 0, dealbreaker: 0, leadership: 0, offArchetype: 0,
  yoe: 0, stretch: 0, remote: 0, multiCountry: 0, nonLocal: 0, dup: 0, kept: 0,
};
const failed = [];
const sourceHist = {};
const rows = [];
const sidecar = [];
const newBoards = new Map();
const seen = new Set();
const seenRoles = new Set();

const known = alreadyKnown();
const indexed = indexedBoards();
const TODAY = new Date().toISOString().slice(0, 10);

let rateLimited = 0;
let tripped = false;
for (const [qi, q] of QUERIES.entries()) {
  if (qi > 0) {
    if (remaining() < 10_000) { failed.push(`"${q}": skipped (runtime budget exhausted)`); continue; }
    await sleep(jitter());
  }
  let res;
  try {
    res = await collectWithRetry(q);
  } catch (e) {
    console.error(`hiringcafe: "${q}" FAILED after retries: ${e.message}`);
    failed.push(`"${q}": ${e.message}`);
    if (e.status === 429 && qi < 2) rateLimited++;
    // Circuit breaker: the first two queries both rate-limited means every other query will be too.
    if (qi === 1 && rateLimited === 2) { tripped = true; break; }
    continue;
  }
  if (res.truncated) {
    // Never let a cap look like a complete sweep.
    console.error(`hiringcafe: "${q}" hit the ${MAX_PAGES}-page cap — results TRUNCATED, not exhausted`);
  }
  if (!QUIET) console.log(`hiringcafe "${q}": ${res.hits.length} raw hit(s)`);

  for (const h of res.hits) {
    stats.raw++;
    const v5 = h.v5_processed_job_data || {};
    const src = (h.source || '').toLowerCase();
    sourceHist[src] = (sourceHist[src] || 0) + 1;

    if (SOURCES_MODE) continue;

    const title = (h.job_information?.title || v5.core_job_title || '').trim();
    const company = (v5.company_name || h.enriched_company_data?.name || h.board_token || '').trim();
    const url = (h.apply_url || '').trim();
    if (!title || !company || !/^https?:\/\//i.test(url)) { continue; }

    const key = url.toLowerCase().replace(/[?#].*$/, '');
    if (seen.has(key)) { stats.dup++; continue; }
    seen.add(key);
    const roleKey = `${company.toLowerCase()}::${normTitle(title)}`;
    if (seenRoles.has(roleKey)) { stats.dup++; continue; }
    seenRoles.add(roleKey);

    if (h.is_expired) { stats.expired++; continue; }

    // "Internal Position" = the employer posted its own req. Anything else is a staffing
    // intermediary or a relister, which otherwise has to be identified by hand.
    if (v5.position_employer_type && v5.position_employer_type !== 'Internal Position') {
      stats.notInternal++; continue;
    }

    const co = company.toLowerCase();
    if (NOISE.some((n) => co.includes(n))) { stats.noise++; continue; }
    if (dealbreakerHit(company, title)) { stats.dealbreaker++; continue; }
    if (!titleMatches(title) || titleDropped(title)) { stats.offArchetype++; continue; }
    // A people-manager req that passed the title gate is dropped only when the profile opts
    // out of management roles (targets.include_management: false).
    if (v5.role_type === 'People Manager' && !INCLUDE_MGMT) { stats.leadership++; continue; }

    const minYoe = v5.is_min_industry_and_role_yoe_not_mentioned ? '' : (v5.min_industry_and_role_yoe ?? '');
    const fit = yoeFit(minYoe);
    if (fit === 'drop') { stats.yoe++; continue; }

    const loc = (v5.formatted_workplace_location || (v5.workplace_cities || []).join('; ') || '').trim();
    const wt = v5.workplace_type || '';
    const isRemote = /remote/i.test(wt);
    // A req listing workplaces in several COUNTRIES is a globally-distributed posting that
    // happens to name a local city, not a local job ("Japan or <your city> or Dublin or
    // Tokyo" is the shape this catches).
    if ((v5.number_of_workplace_countries || 0) > 1) { stats.multiCountry++; continue; }
    if (!workplaceAllowed(wt, loc, title)) {
      if (isRemote || /\bremote\b/i.test(`${title} ${loc}`)) stats.remote++; else stats.nonLocal++;
      continue;
    }

    if (known.has(key)) { stats.dup++; continue; }

    const claimed = v5.estimated_publish_date || '';
    rows.push([TODAY, company, title, loc, `hiringcafe-claim:${claimed}`, url, 'hiringcafe'].join('\t'));

    // The sidecar carries what the 7-column contract has no room for. The years gate is the
    // reason this file exists: it is the single field that decides many roles.
    sidecar.push([
      TODAY, company, title, url,
      v5.is_min_industry_and_role_yoe_not_mentioned ? 'none' : minYoe,
      v5.seniority_level || '', v5.role_type || '', wt,
      v5.yearly_min_compensation ?? '', v5.yearly_max_compensation ?? '',
      v5.bachelors_degree_requirement || '', v5.security_clearance || '',
      `${src}/${h.board_token || ''}`, claimed, fit === 'stretch' ? 'STRETCH' : '',
    ].join('\t'));
    if (fit === 'stretch') stats.stretch++;

    // Grow the index. A board we already have is not news; a family we cannot parse is.
    const root = BOARD_ROOT[src]?.(h.board_token);
    if (root && h.board_token && !indexed.has(root.toLowerCase())) {
      newBoards.set(root.toLowerCase(), `${company}\t${root}`);
    }
    stats.kept++;
  }
}

if (tripped) {
  console.log('hiringcafe rate-limited (HTTP 429) — try again later');
  process.exit(3);
}

if (SOURCES_MODE) {
  const rowsOut = Object.entries(sourceHist).sort((a, b) => b[1] - a[1]);
  console.log(`\nATS family histogram across ${stats.raw} hit(s), ${DAYS}-day window:`);
  for (const [s, n] of rowsOut) {
    console.log(`  ${String(n).padStart(4)}  ${s}${BOARD_ROOT[s] ? '' : '   <-- NOT PARSEABLE by scan-core.mjs'}`);
  }
  process.exit(0);
}

const summary =
  `hiringcafe: raw ${stats.raw} -> kept ${stats.kept} ` +
  `(expired ${stats.expired}, non-employer ${stats.notInternal}, noise ${stats.noise}, ` +
  `dealbreaker ${stats.dealbreaker}, management ${stats.leadership}, off-archetype ${stats.offArchetype}, ` +
  `yoe>${MAX_YOE_OVER} over ${stats.yoe}, remote ${stats.remote}, ` +
  `multi-country ${stats.multiCountry}, non-local (${areaLabel()}) ${stats.nonLocal}, dup ${stats.dup}) ` +
  `| stretch ${stats.stretch} | new boards ${newBoards.size}` +
  (failed.length ? ` | FAILED ${failed.length} query(ies): ${failed.join('; ')}` : '');

if (DRY) {
  console.log(summary + '  [DRY RUN — nothing written]');
  for (const r of rows) console.log('  ' + r);
  for (const s of sidecar) console.log('  meta: ' + s);
  process.exit(failed.length ? 3 : 0);
}

if (rows.length) {
  if (!existsSync(WEB_ROLES)) writeFileSync(WEB_ROLES, 'date\tcompany\trole\tlocation\tposted\turl\tsource\n');
  appendFileSync(WEB_ROLES, rows.join('\n') + '\n');
}
if (sidecar.length) {
  if (!existsSync(SIDECAR)) {
    writeFileSync(SIDECAR, [
      'date', 'company', 'role', 'url', 'min_yoe', 'seniority', 'role_type', 'workplace_type',
      'comp_min', 'comp_max', 'bachelors', 'clearance', 'ats', 'hiringcafe_claimed_date', 'fit',
    ].join('\t') + '\n');
  } else {
    // Older sidecars predate the fit column; extend the header in place.
    const cur = readFileSync(SIDECAR, 'utf-8');
    const nl = cur.indexOf('\n');
    const head = nl === -1 ? cur : cur.slice(0, nl);
    if (!head.split('\t').includes('fit')) writeFileSync(SIDECAR, head + '\tfit' + (nl === -1 ? '\n' : cur.slice(nl)));
  }
  appendFileSync(SIDECAR, sidecar.join('\n') + '\n');
}
if (newBoards.size) {
  appendFileSync(DISCOVERED, [...newBoards.values()].join('\n') + '\n');
}

console.log(summary);
if (failed.length) process.exit(3);
