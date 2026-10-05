#!/usr/bin/env node

/**
 * linkedin-crawl.mjs — crawl the LOGGED-IN LinkedIn job search, then verify every hit
 * against the employer's ATS before writing a row.
 *
 * WHY IT EXISTS. `speed-linkedin.mjs` uses LinkedIn's anonymous guest API. Same day,
 * same titles, same geo, the guest API returns a handful of cards (often staffing shells)
 * while the logged-in search returns dozens of real employer cards. The logged-in surface
 * is simply a different, far better index.
 *
 * THE TRAP THIS SCRIPT EXISTS TO NEUTRALISE. LinkedIn's "Posted N hours ago" is when the
 * req was **promoted to LinkedIn**, NOT when it opened — and the location chip can be
 * wrong too. Typical outcomes once checked against the employer's ATS:
 *   "<Role>, <local city>, 7h ago"  -> ATS publishedAt 11 months ago
 *   "<Role>, <local city>, 6h ago"  -> no local req exists at all
 *   "<Role>, <local city>, 6h ago"  -> the req is in a different city
 * Only a small fraction of cards survive ATS verification.
 *
 * So: LinkedIn is used for DISCOVERY ONLY — which employers are hiring right now. Dates
 * and locations come from the ATS posting-API or the row is not written. A LinkedIn
 * timestamp must never reach scored-jobs.tsv.
 *
 * DOM NOTE. LinkedIn ships obfuscated hashed class names (`fc68ff10 _44255535 …`) and
 * almost no `/jobs/view/` anchors in the results list, so class/anchor selectors return
 * zero. The results pane is parsed from `innerText` as repeated
 * "Title / Company / Location / Posted N ago" blocks.
 *
 * Re-measured 2026-08-20 and still true, with the exact numbers: on a 25-card page there was
 * ONE `/jobs/view/` anchor (the auto-selected card) and ZERO `data-occludable-job-id`,
 * `data-job-id` or `data-entity-urn` attributes. This is why "just open every card" is not
 * available: 24 of 25 cards have no address you can navigate to, and reaching them would
 * mean synthesising real mouse events, which is what automation detection looks for.
 * Job IDs are obtained from the logged-out guest API instead — see linkedin-applyurl.mjs.
 *
 * Needs the logged-in debug Chrome (scripts/chrome-debug.mjs start) and honours the
 * LinkedIn kill-switch + the shared action budget.
 *
 * BROWSER TRANSPORT (changed 2026-08-06). This used to drive Playwright's
 * `chromium.connectOverCDP`. Chrome auto-updated to 150 and that call started failing with
 * "Browser.setDownloadBehavior: Browser context management is not supported" — Playwright
 * issues browser-context commands on connect that a CDP-attached Chrome 150 refuses. The
 * crawl exited 1 on every run from that moment and, because the cron step ended in
 * `|| true`, the pipeline reported a quiet market instead of a dead crawler for two days.
 * It now speaks raw CDP via ./cdp.mjs (Page/Runtime/Network only, zero dependencies), which
 * is the same protocol the chrome-devtools MCP uses and cannot drift with a browser release.
 *
 * Usage:
 *   node scripts/linkedin-crawl.mjs                     # crawl, verify, print
 *   node scripts/linkedin-crawl.mjs --write             # also append verified rows to _web-roles.tsv
 *   node scripts/linkedin-crawl.mjs --keywords "<role a>,<role b>"   # default: targets.roles
 *   node scripts/linkedin-crawl.mjs --geo <linkedinGeoId>   # default: location.linkedin_geo_id
 *   node scripts/linkedin-crawl.mjs --pages 3           # result pages per keyword (default 2)
 *   node scripts/linkedin-crawl.mjs --no-rescue         # skip the tier-3 Apply-href resolution
 */

// Request ledger: logged-in traffic is counted from li-budget claim() events; importing it
// registers the exit-time flush to data/_request-ledger.tsv.
import './request-ledger.mjs';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { cdpAlive, newPage, DEFAULT_PORT } from './cdp.mjs';
import { parseCards, SCROLL_AND_READ, htmlToText } from './linkedin-parse.mjs';
import { canonicalCompany } from './company-alias.mjs';
import { claim, cooldown, inCooldown, sleep, jitterMs } from './li-budget.mjs';
import { parallelFetch, taskHost, firstSeen } from './scan-core.mjs';
import { guestJobIds, guestJobIdFor, applyUrlForJob, _norm } from './linkedin-applyurl.mjs';
import { verifyCareersPage, workdayApiFromUrl } from './verify-careers-page.mjs';
import { requireTargets, SEARCH_KEYWORDS, titleDropped, titleMatches, loadNoise, LOCAL, LEADERSHIP_HARD, locationMatches, areaLabel, dealbreakerHit } from './role-filters.mjs';
import { classifyLocation, remoteAllowed } from './targets.mjs';
import { liSearchGeos } from './li-geo.mjs';
import { tracked as trackedFetch } from './request-ledger.mjs'; // every outbound request is counted

requireTargets();

const ROOT = new URL('..', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');
// Tier-3 Apply-href rescue is ON by default; --no-rescue disables it for a pure guess-only run.
const RESCUE = !process.argv.includes('--no-rescue');
// --rescue-max N caps the tier-3 Apply-href rescue (each is one logged-in page load). Default 20.
const RESCUE_MAX = (() => { const i = process.argv.indexOf('--rescue-max'); const n = i >= 0 ? Number(process.argv[i + 1]) : 20; return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20; })();
// A flag's value must not be another flag: `--pages --write` used to yield Number('--write')
// = NaN, and `Math.max(1, NaN)` is NaN, so the page loop never ran and the crawl reported zero
// cards. Loud (it exits 2) but for entirely the wrong reason.
const val = (f, d) => {
  const i = process.argv.indexOf(f);
  const next = i > -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : d;
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
// targets.roles, primary first, CAPPED AT 4 — the morning budget is 3 searches x 4 roles.
const MAX_ROLES = 4;
const KEYWORDS = val('--keywords', SEARCH_KEYWORDS.join(',')).split(',').map(s => s.trim()).filter(Boolean).slice(0, MAX_ROLES);
const GEO_ID = val('--geo', '');                 // explicit LinkedIn geoId override
// LOCAL geo only (location.linkedin_geo_id → li-geo cache → free text). The remote-country
// variant (country geoId + f_WT=2) is searched ONCE per role by linkedin-jobsearch.mjs's faceted
// form, not crossed with every form — crossing it doubled the crawl's page budget.
const GEOS = liSearchGeos(GEO_ID).filter(g => g.tag === 'local');
// --fixture <file>: parse a saved results page (HTML or innerText) instead of the live browser.
// Offline: no Chrome, no budget, no ATS calls, no files written; prints the prefilter verdicts.
const FIXTURE = val('--fixture', '');
const HOURS = num(val('--hours', 24), 24);   // 24 → f_TPR=r86400
const searchUrl = (kw, g, pg) => `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(kw)}` +
  `&f_TPR=r${HOURS * 3600}${g.param ? `&${g.param}` : ''}&sortBy=DD${pg ? `&start=${pg * 25}` : ''}`;
// DISCOVERY window (LinkedIn f_TPR) and TRUTH window (ATS publishedAt) are decoupled.
// They were the same number, which quietly lost jobs: LinkedIn's listing date drifts from
// the ATS date in BOTH directions, so a req opened yesterday can have been listed on
// LinkedIn four days ago and a 48h f_TPR filter never surfaces it at all. Cast the LinkedIn
// net wide (it is only a candidate feed) and keep the ATS gate strict (it is the truth).
//
// ATS_HOURS IS NO LONGER A GATE (user-set 2026-08-24). The flag is still parsed so existing
// cron invocations and scripts keep working, and the value is still used to LABEL rows, but
// nothing is dropped or diverted for being older than it. A req that LinkedIn is re-promoting
// is one the employer is still hiring for; `publishedAt` answers "when was this created", not
// "do they want applicants". The ATS remains mandatory for existence, canonical JD, location
// and comp — see the verify block for the full statement of what it is still for.
const ATS_HOURS = num(val('--ats-hours', HOURS * 2), HOURS * 2);
// RESULT PAGES per keyword. Was implicitly 1 — there was no `start=` param at all, so half
// of every search was never read. When measured, page 2 held 25 MORE
// cards, most of them employers or reqs that had never been scored.
const PAGES = Math.max(1, num(val('--pages', 2), 2));

// STATUS FILE. The crawl failing has to be visible to something other than a human reading
// a log. Written on every exit path, success or failure, so the pipeline can assert that
// the LinkedIn lane actually ran rather than inferring a quiet market from zero rows.
const STATUS = `${ROOT}data/_linkedin-crawl-status.json`;
function writeStatus(o) {
  if (FIXTURE) return;   // an offline fixture run must never overwrite the live lane's status
  try {
    writeFileSync(STATUS, JSON.stringify({ ran_at: new Date().toISOString(), ...o }, null, 2) + '\n');
  } catch { /* status is diagnostics; never let it break the run */ }
}
function die(code, error, extra = {}) {
  writeStatus({ ok: false, error, ...extra });
  console.error(`linkedin-crawl: ${error}`);
  process.exit(code);
}

// --urls: print the exact search URLs (proves the 24h facet + geo variants) and exit. Spends nothing.
if (process.argv.includes('--urls')) {
  console.log(JSON.stringify(KEYWORDS.flatMap(kw => GEOS.map(g => ({ kw, geo: g.tag, url: searchUrl(kw, g, 0) }))), null, 2));
  process.exit(0);
}

if (!FIXTURE && existsSync(`${ROOT}data/LINKEDIN_OFF`)) {
  // Deliberately OFF is not a failure — ok:true so the pipeline does not raise an alarm.
  writeStatus({ ok: true, skipped: 'kill-switch (data/LINKEDIN_OFF)' });
  console.error('linkedin-crawl: LinkedIn activity is OFF (data/LINKEDIN_OFF). Not crawling.');
  process.exit(0);
}
const cd = FIXTURE ? null : inCooldown();
if (cd) {
  writeStatus({ ok: true, skipped: `cooldown until ${cd.until} (${cd.reason})` });
  console.error(`linkedin-crawl: COOLDOWN until ${cd.until} (${cd.reason}).`);
  process.exit(0);
}

// ── filters (shared vocabulary with role-filters.mjs) ──────────────────────
// Title and geography come from config/profile.yml via targets.mjs — one definition shared
// with every other lane (scan-core, hiringcafe, speed-linkedin), so they cannot drift apart.
const TITLE_OK = { test: (t) => titleMatches(t) };
// Hard negatives (`!term` in targets.title_negatives) — seniority/leadership the user never wants.
const TITLE_DROP = LEADERSHIP_HARD;
const REMOTE = /\b(remote|anywhere|distributed|wfh)\b/i;
const BAY = LOCAL;   // legacy name: the profile's local area (city, metro, cities[])
// Staffing shells and anonymised posters seen repeatedly on LinkedIn job search.
// SHARED vocabulary (data/_speed-noise.txt + role-filters titleDropped()), consulted alongside
// the local AGENCY regex below, so a lane never re-imports agencies blocked elsewhere.
const NOISE_LIST = loadNoise();
const sharedNoise = (co) => { const l = String(co || '').toLowerCase(); return NOISE_LIST.some(n => l.includes(n)); };
const sharedTitleDrop = (t) => { try { return titleDropped(t); } catch { return false; } };
const AGENCY = /(jack ?& ?jill|hartleyco|allohire|smrti|dot_?dot|stealth startup|scout global|corissa|andrew & brothers|talentry|robert half|motion recruitment|jobot|crossover|insight global|apex systems|talent partners|staffing|recruit)/i;

const ATS = [
  { type: 'ashby', url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}`, jobs: j => j?.jobs || [],
    map: x => ({ title: x.title, loc: x.location, pub: x.publishedAt, url: x.jobUrl, remote: x.isRemote }) },
  { type: 'greenhouse', url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`, jobs: j => j?.jobs || [],
    map: x => ({ title: x.title, loc: x.location?.name, pub: x.first_published || x.updated_at, url: x.absolute_url, remote: null }) },
  { type: 'lever', url: s => `https://api.lever.co/v0/postings/${s}?mode=json`, jobs: j => (Array.isArray(j) ? j : []),
    map: x => ({ title: x.text, loc: x.categories?.location, pub: x.createdAt, url: x.hostedUrl, remote: null }) },
];

// ── ATS board resolution ───────────────────────────────────────────────────
// Measured 2026-07-29: 29 of 34 rejects (85%) were "no public ATS board", and at least two were
// FALSE negatives — Hex's real Greenhouse slug is `hextechnologies` and Sigma's is `sigmacomputing`,
// neither of which name-guessing can reach. Meanwhile data/company-index.tsv ALREADY stored both,
// with the resolved ats_type and api_url, because scan-index maintains it. The crawl was inventing
// slugs while the answer sat on disk. Consult the index FIRST, then guess.
const INDEX = (() => {
  const map = new Map();
  try {
    const rows = readFileSync('data/company-index.tsv', 'utf-8').split('\n').slice(1);
    for (const line of rows) {
      const f = line.split('\t');
      if (f.length < 5 || !f[0]) continue;
      const [company, , careers, atsType, apiUrl] = f;
      if (!atsType || !apiUrl) continue;
      const key = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!map.has(key)) map.set(key, { atsType: atsType.trim(), apiUrl: apiUrl.trim(), company, careers });
    }
  } catch { /* index absent is survivable — fall through to guessing */ }
  return map;
})();

/** Look the employer up in the maintained index. Exact key first, then a guarded prefix match
 *  so a card reading "Sigma" finds the "Sigma Computing" row. A wrong match is self-correcting:
 *  verify() still requires a title match on that board, so it degrades to notFound, never to a
 *  false positive. */
function indexedBoard(company) {
  const key = canonicalCompany(company).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!key) return null;
  if (INDEX.has(key)) return INDEX.get(key);
  if (key.length < 4) return null;           // "hex"/"exa" are too short to prefix-match safely
  let best = null;
  for (const [k, v] of INDEX) {
    if (k.startsWith(key) && (!best || k.length < best[0].length)) best = [k, v];
  }
  return best ? best[1] : null;
}

function slugs(company) {
  const n = canonicalCompany(company).toLowerCase().trim();
  const bare = n.replace(/[^a-z0-9]+/g, ''), dashed = n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Suffixes real companies actually register their boards under (hextechnologies, sigmacomputing…).
  const suffixed = ['technologies', 'computing', 'labs', 'tech', 'software', 'hq', 'inc', 'io', 'app']
    .flatMap(sx => [bare + sx, `${dashed}-${sx}`]);
  return [...new Set([bare, dashed, bare + 'ai', dashed + '-ai', bare.replace(/ai$/, ''), dashed.replace(/-ai$/, ''), ...suffixed])]
    .filter(s => s.length > 1).slice(0, 14);
}

/**
 * Parse an ATS `publishedAt` into epoch ms. Returns NaN for genuinely unusable values.
 *
 * Not every board serves ISO 8601. Observed live 2026-08-06: Aircall's board returned the
 * NUMBER 1764624711 (Unix SECONDS) where Ashby/Lever return "2026-08-04T00:11:08.690Z", and
 * `Date.parse(1764624711)` is NaN. The row then failed the freshness gate with
 * "publishedAt 1764624711 = NaNh old" — indistinguishable in the log from a stale req, so a
 * potentially fresh job was dropped for a units mismatch. Seconds vs milliseconds is decided
 * by magnitude: anything below ~1e11 cannot be a plausible date in ms (1e11 ms = 1973).
 */
function parsePub(pub) {
  if (pub == null) return NaN;
  if (typeof pub === 'number' || /^\d+$/.test(String(pub))) {
    const n = Number(pub);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return n < 1e11 ? n * 1000 : n;
  }
  return Date.parse(pub);
}

async function getJson(url) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 9000);
    const r = await trackedFetch(url, { signal: c.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * Fetch an indexed board on a family this script does not implement natively.
 *
 * The local ATS table speaks ashby/greenhouse/lever. data/company-index.tsv holds five MORE
 * families (workday, smartrecruiters, rippling, recruitee, teamtailor) because scan-core has
 * always parsed nine — so a company could be fully indexed and the crawl would still reject
 * its reqs as "no public ATS board". Those rows grow every morning as probe-ats resolves more.
 *
 * scan-core's parsers already normalise to {title,url,location,postedAt}, so this reuses them
 * rather than reimplementing five APIs. Guarded: any failure returns null and the caller falls
 * through to the existing slug-guessing path, so this can only add coverage, never remove it.
 *
 * NOTE on Workday: its date comes from a relative string ("Posted 3 Days Ago") and is often
 * null. A null date fails the freshness gate as Infinity-hours-old, which is the correct
 * conservative outcome — this pipeline never claims a freshness it cannot prove.
 */
async function fetchIndexedBoard(idx) {
  try {
    const { detectApi, fetchProvider, PARSERS } = await import('./scan-core.mjs');
    const api = detectApi({ api: idx.apiUrl });
    if (!api || !PARSERS[api.type]) return null;
    const raw = await fetchProvider(api);
    const jobs = PARSERS[api.type](raw, idx.company, api) || [];
    // Normalise onto this script's shape: {title, loc, pub, url, remote}.
    return jobs.map(j => ({
      title: j.title, loc: j.location, url: j.url, remote: null,
      pub: j.postedAt instanceof Date ? j.postedAt.toISOString() : (j.postedAt || j.updatedAt || null),
    }));
  } catch { return null; }
}

/**
 * Employers a PREVIOUS run already queued as unresolvable — i.e. slug-guessing against
 * ashby/greenhouse/lever has already failed for them at least once.
 *
 * Slug-guessing costs up to 14 slugs x 3 families = 42 requests per company with a 9s timeout
 * each. Reading two result pages instead of one roughly doubled the number of unresolvable
 * employers per run, and Ashby has already been rate-limited once by over-eager sweeping
 * (RATE-LIMIT-01, 2026-07-29: 610 errors vs 51, truncated JSON). Re-guessing slugs we know
 * do not exist is pure cost, so skip straight to the index-discovery path for them.
 *
 * Safe because it only skips GUESSING: `indexedBoard()` is still consulted first, so the
 * moment probe-ats resolves one of these into the index, it verifies normally again.
 */
const KNOWN_UNRESOLVABLE = (() => {
  const s = new Set();
  try {
    for (const line of readFileSync(`${ROOT}data/_discovered-companies.tsv`, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [company, url] = t.split('\t').map(x => (x || '').trim());
      if (company && !/^https?:\/\//.test(url)) s.add(company.toLowerCase().replace(/[^a-z0-9]+/g, ''));
    }
  } catch { /* absent queue is fine */ }
  return s;
})();

/**
 * Evaluate ONE probe: fetch the board and fuzzy-match the card title against it.
 * null = board empty/unreachable (fall through to the next probe); otherwise the decision —
 * a hit, or {notFound} when the board answered but holds no matching req.
 */
async function probeOne({ p, url, slug: s, generic }, cardTitle) {
      let list;
      if (generic) {
        list = await fetchIndexedBoard(generic);
        if (!list?.length) return null;
      } else {
        const j = await getJson(url);
        list = j ? p.jobs(j).map(p.map) : [];
      }
      if (!list.length) return null;
      const key = cardTitle.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 3);
      // Score every candidate rather than taking any that clears 0.6. An employer may run
      // both "Commercial <Role>, <City>" and "Mid-Market <Role>, <City>"; they share most
      // words, so both cards cleared the threshold against the SAME req and two distinct jobs
      // resolved to one URL. Overlap is now symmetric — it penalises words the posting has
      // that the card does NOT — so "Commercial" vs "Mid-Market" separates them.
      const matches = list.map(x => {
        const tWords = String(x.title || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 3);
        const inter = key.filter(w => tWords.includes(w)).length;
        const union = new Set([...key, ...tWords]).size || 1;
        return { ...x, _score: inter / union };            // Jaccard, not one-way containment
      }).filter(x => x._score >= 0.45);
      // SIBLING RULE (same failure the scorer's EXACT-POSTING rule guards against):
      // one title often has many geo variants — the same role posted for Paris, New York AND
      // your city on one board. Taking the first fuzzy match rejected the genuinely-local req
      // because it landed on Paris. Prefer a local sibling, then the freshest.
      const ranked = matches.sort((a, b) => {
        if (Math.abs(a._score - b._score) > 0.08) return b._score - a._score;  // title fit wins
        const ab = BAY.test(a.loc || '') ? 1 : 0, bb = BAY.test(b.loc || '') ? 1 : 0;
        if (ab !== bb) return bb - ab;
        return (parsePub(b.pub) || 0) - (parsePub(a.pub) || 0);
      });
      const hit = ranked[0];
      const atsType = generic ? generic.atsType : p.type;
      if (hit) return { ...hit, ats: atsType, slug: s, siblings: matches.length };
      return { notFound: true, ats: atsType, slug: s, boardSize: list.length };
}

/** The whole point: confirm the req on the employer's own board. */
async function verify(company, cardTitle) {
  // Phase 1 — the maintained index (authoritative slug). Kept as its own serial step so an
  // indexed company still costs exactly ONE request, never a parallel cascade.
  const idx = indexedBoard(company);
  if (idx) {
    const p = ATS.find(a => a.type === idx.atsType);
    const probe = p
      ? { p, url: idx.apiUrl, slug: `${idx.atsType}:${idx.company} (index)` }
      : { generic: idx, slug: `${idx.atsType}:${idx.company} (index, via scan-core)` };
    const r = await probeOne(probe, cardTitle).catch(() => null);
    if (r) return r;
  }
  if (!idx && KNOWN_UNRESOLVABLE.has(canonicalCompany(company).toLowerCase().replace(/[^a-z0-9]+/g, ''))) {
    return null;   // already known to have no guessable board — do not spend 42 requests re-proving it
  }
  // Phase 2 — guessed slugs across the ATS families. The serial loop walked up to 42 probes
  // one 9s-timeout at a time and short-circuited on the first non-empty board. Here every
  // guess fires concurrently (8 workers, ≤3 per host — Ashby has rate-limited over-eager
  // sweeps before, RATE-LIMIT-01) and the FIRST IN PROBE ORDER with a non-empty board
  // decides: identical semantics, roughly one round-trip of wall-clock.
  const probes = [];
  for (const s of slugs(company)) for (const p of ATS) probes.push({ p, url: p.url(s), slug: s });
  const tasks = probes.map(pr => {
    const t = () => probeOne(pr, cardTitle).catch(() => null);
    t.host = taskHost(pr.url);
    return t;
  });
  const outcomes = await parallelFetch(tasks, 8, { perHost: 3 });
  return outcomes.find(Boolean) || null;
}

/**
 * Fetch the ONE req an Apply href named, rather than fuzzy-matching a whole board.
 * This sidesteps both failure modes of the guess path: the wrong board, and the right board
 * with the wrong sibling (the Paris vs local copy of the same title).
 */
async function fetchExactReq(a) {
  try {
    const r = await trackedFetch(a.apiUrl, { headers: { 'User-Agent': 'career-finder/1.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (a.atsType === 'greenhouse')
      return { title: j.title, loc: j.location?.name, pub: j.first_published || j.updated_at, url: j.absolute_url, employer: a.slug };
    if (a.atsType === 'lever')
      return { title: j.text, loc: j.categories?.location, pub: j.createdAt, url: j.hostedUrl, employer: a.slug };
    if (a.atsType === 'ashby') {
      const hit = (j?.jobs || []).find(x => String(x.id) === String(a.jobId) || String(x.jobUrl || '').includes(a.jobId));
      return hit ? { title: hit.title, loc: hit.location, pub: hit.publishedAt, url: hit.jobUrl, employer: a.slug } : null;
    }
  } catch { /* unreachable board is a miss, not a crash */ }
  return null;
}

// ── crawl ──────────────────────────────────────────────────────────────────
// The page does only what a page must (scroll to force lazy-load, hand back innerText);
// ALL parsing happens in Node via linkedin-parse.mjs, which scripts/test-linkedin-parse.mjs
// covers offline. Parsing used to live inside the evaluate() closure, which meant it could
// only run against a live logged-in LinkedIn and could not be tested at all — that is how a
// bug that destroyed one card per page survived for months.
// A DEAD BROWSER IS RECOVERABLE, NOT FATAL (2026-09-12). This used to die() outright, so any
// morning where Chrome had been closed or had crashed cost the ENTIRE LinkedIn lane for the day,
// and the board looked like a quiet market rather than a broken lane. Start it once and re-check.
const cards = new Map();
const pageCounts = [];
let stopped = null;
let page = null;

if (FIXTURE) {
  const found = parseCards(htmlToText(readFileSync(FIXTURE, 'utf8')));
  for (const f of found) {
    const k = `${canonicalCompany(f.company)}|${f.title}`.toLowerCase();
    if (!cards.has(k)) cards.set(k, f);
  }
  pageCounts.push({ kw: '(fixture)', geo: '-', page: 1, cards: found.length, new: cards.size });
} else {
  let chrome = await cdpAlive();
  if (!chrome) {
    console.error(`crawl: no debug Chrome on :${DEFAULT_PORT} — attempting to start it`);
    try { execFileSync('node', [`${ROOT}scripts/chrome-debug.mjs`, 'start'], { stdio: 'ignore', timeout: 45000 }); }
    catch (e) { console.error(`crawl: chrome-debug start failed — ${e.message}`); }
    await sleep(5000);
    chrome = await cdpAlive();
    if (chrome) console.error('crawl: debug Chrome recovered');
  }
  if (!chrome) die(1, `no debug Chrome on :${DEFAULT_PORT} and auto-start failed — run \`node scripts/chrome-debug.mjs start\``);

  page = null;
  try { page = await newPage(); }
  catch (e) { die(1, `could not open a tab over CDP — ${e.message}`); }

  outer:
  for (const kw of KEYWORDS) {
   for (const g of GEOS) {
    for (let pg = 0; pg < PAGES; pg++) {
      const c = claim('jobsearch', `linkedin-crawl "${kw}" ${g.tag} p${pg + 1}`);
      if (!c.ok) { stopped = `budget: ${c.reason}`; console.error(`linkedin-crawl: stopping — ${c.reason}`); break outer; }

      // `start` is LinkedIn's own offset param, 25 results per page.
      const url = searchUrl(kw, g, pg);
      console.log(`crawl: "${kw}" [${g.tag}] page ${pg + 1}`);

      // ONE TRANSIENT TIMEOUT MUST NOT KILL THE WHOLE CRAWL (2026-09-12). This used to break outer
      // on the first exception, so a single slow page discarded every remaining keyword and page --
      // that is exactly how 2026-09-11 produced 'LINKEDIN LANE FAILED' and a 0-qualifier board while
      // the account was perfectly healthy (verified: same URL navigated in 8.3s, no authwall).
      // Retry ONCE with a longer settle. This is a TIMEOUT retry only; a 999/429 throttle is handled
      // below and is NEVER retried, because answering a soft throttle with a retry earns a hard block.
      let nav;
      try { nav = await page.navigate(url, { waitMs: 4500 }); }
      catch (e) {
        console.error(`crawl: navigate failed (${e.message}) — one retry with a longer settle`);
        await sleep(6000 + jitterMs(3000));
        try { nav = await page.navigate(url, { waitMs: 9000 }); }
        catch (e2) { stopped = `navigation failed twice: ${e2.message}`; console.error(`STOP: ${stopped}`); break outer; }
      }

      // 999 is LinkedIn's own throttle code. NEVER retry it — a soft throttle answered with a
      // retry is how an account earns a hard block.
      if (nav.status === 999 || nav.status === 429) {
        cooldown(`HTTP ${nav.status} from LinkedIn`, 6);
        stopped = `HTTP ${nav.status} — cooldown tripped`;
        console.error(`STOP: ${stopped}`);
        break outer;
      }
      if (/\/authwall|\/checkpoint\//.test(nav.url || '')) {
        cooldown('authwall/checkpoint', 12);
        stopped = 'authwall/checkpoint — the debug profile is logged out';
        console.error('STOP: authwall — log the debug profile in.');
        break outer;
      }

      let found = [];
      try {
        const text = await page.evaluate(SCROLL_AND_READ);
        found = parseCards(text);
      } catch (e) { console.error(`  extract failed: ${e.message}`); }
      found = Array.isArray(found) ? found : [];

      let fresh = 0;
      for (const f of found) {
        const k = `${canonicalCompany(f.company)}|${f.title}`.toLowerCase();
        if (!cards.has(k)) { cards.set(k, f); fresh++; }
      }
      pageCounts.push({ kw, geo: g.tag, page: pg + 1, cards: found.length, new: fresh });
      console.log(`  ${found.length} cards (${fresh} new)`);

      // A short page means the result set is exhausted — do not spend budget on the next one.
      if (found.length < 20) { if (pg + 1 < PAGES) console.log('  (short page — no further pages for this keyword)'); break; }
      await sleep(jitterMs('jobsearch'));
    }
   }
  }
  await page.close();
}

if (!cards.size && !stopped) stopped = 'zero cards parsed across every keyword — check the DOM parser against a live page';

// ── filter, then VERIFY against the ATS ────────────────────────────────────
//
// PER-CARD REJECT LOG (added 2026-08-20). The prefilter used to be an anonymous .filter():
// 585 cards went in, 59 came out, and the 526 dropped left NO record of themselves. When the
// user asked "why wasn't THIS job analysed?", the honest answer was that the system could not
// say — the only surviving evidence was an aggregate count. Every drop now names the card AND
// the rule that killed it, so the question is a grep instead of an investigation.
const REJECT_LOG = `${ROOT}data/_linkedin-rejects.tsv`;
const rejectRows = [];
function logReject(c, stage, rule, detail = '') {
  rejectRows.push([new Date().toISOString().slice(0, 10), c.company || '', c.title || '', c.loc || '',
    c.age || '', stage, rule, detail].join('\t'));
}

const prefiltered = [];
for (const c of cards.values()) {
  // Order matters only for which rule gets the blame; each is checked explicitly so the
  // reason recorded is the REAL one, not "failed the composite predicate".
  if (!TITLE_OK.test(c.title))        { logReject(c, 'prefilter', 'title-not-on-archetype'); continue; }
  if (TITLE_DROP.test(c.title))       { logReject(c, 'prefilter', 'title-seniority-or-leadership'); continue; }
  if (sharedTitleDrop(c.title))       { logReject(c, 'prefilter', 'title-off-archetype-shared', 'role-filters titleDropped()'); continue; }
  if (AGENCY.test(c.company))         { logReject(c, 'prefilter', 'staffing-agency-or-shell'); continue; }
  if (sharedNoise(c.company))         { logReject(c, 'prefilter', 'blocklisted-employer', 'data/_speed-noise.txt'); continue; }
  { const db = dealbreakerHit(c.company, c.title);
    if (db) { logReject(c, 'prefilter', 'dealbreaker', db); continue; } }
  if (!locationMatches(c.loc, c.title)) {
    const remote = REMOTE.test(c.loc);
    logReject(c, 'prefilter', remote ? 'remote' : 'not-local-area', `card location "${c.loc}"`); continue;
  }
  prefiltered.push(c);
}

console.log(`\n${cards.size} unique cards → ${prefiltered.length} pass title/geo/agency prefilter (${rejectRows.length} logged to _linkedin-rejects.tsv)\n`);

// Fixture runs stop here: everything past this point calls employer ATS APIs (network).
if (FIXTURE) {
  const rejects = rejectRows.map(r => { const f = r.split('\t'); return { company: f[1], title: f[2], loc: f[3], stage: f[5], rule: f[6], detail: f[7] }; });
  for (const c of prefiltered) console.log(`  KEEP  ${c.company} | ${c.title} | ${c.loc} | ${c.age}`);
  for (const r of rejects) console.log(`  DROP  ${r.company} | ${r.title} | ${r.loc} | ${r.rule}`);
  console.log('JSON ' + JSON.stringify({ cards: cards.size, kept: prefiltered, rejects }));
  process.exit(0);
}


// Queue an employer LinkedIn surfaced but we could not resolve, for discover-companies.mjs to
// resolve later. Deduped against the index and the existing queue so the file cannot balloon.
const DISCOVERED = 'data/_discovered-companies.tsv';
const knownCos = new Set();
try {
  for (const l of readFileSync('data/company-index.tsv', 'utf-8').split('\n').slice(1)) {
    const c = l.split('\t')[0]; if (c) knownCos.add(c.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  }
} catch {}
try {
  for (const l of readFileSync(DISCOVERED, 'utf-8').split('\n')) {
    const c = l.split('\t')[0]; if (c) knownCos.add(c.toLowerCase().replace(/[^a-z0-9]+/g, ''));
  }
} catch {}
const queuedForIndex = [];
function noteForIndex(rawCompany) {
  const company = canonicalCompany(rawCompany);
  const key = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!key || knownCos.has(key)) return;
  knownCos.add(key);
  queuedForIndex.push(company);
  try { appendFileSync(DISCOVERED, `${company}\t\n`); } catch {}
}

const verified = [], rejected = [], aged = [];
// Fan-out: verify candidates 3 at a time (each verify may run its own probe cascade — the
// per-host caps inside parallelFetch keep the combined pressure polite), then fan back in
// and classify SERIALLY so verified/rejected/discovery-queue ordering stays deterministic.
const vResults = await parallelFetch(prefiltered.map(c => () => verify(c.company, c.title).catch(() => null)), 3);
for (let ci = 0; ci < prefiltered.length; ci++) {
  const c = prefiltered[ci];
  const v = vResults[ci];
  if (!v) {
    // LINKEDIN AS AN EMPLOYER-DISCOVERY FEED (user-set 2026-07-31, "search LinkedIn first").
    // This is the single biggest bucket: 46 of 56 rejects across all runs were "no public ATS
    // board", and they were being DISCARDED. But an unresolvable employer is not worthless — it is
    // a company that is hiring for our exact titles in our exact geo and is simply not in the index
    // yet. Meanwhile discover-companies.mjs reported 0 new companies because its queue was empty.
    // So: hand every unresolvable employer to the index builder. LinkedIn's real value is telling
    // us WHICH EMPLOYERS ARE HIRING; the ATS still has to tell us when and whether the req is real.
    noteForIndex(c.company);
    rejected.push({ ...c, why: 'no public ATS board — queued for index discovery' });
    logReject(c, 'verify', 'no-public-ats-board', 'queued for index discovery');
    continue;
  }
  if (v.notFound) {
    rejected.push({ ...c, why: `not on ${v.ats} board (${v.boardSize} jobs) — LinkedIn location/title unreliable` });
    logReject(c, 'verify', 'not-on-ats-board', `${v.ats}, ${v.boardSize} jobs`);
    continue;
  }
  const pubMs = parsePub(v.pub);
  // DATELESS BOARDS (fix 2026-08-20). Rippling exposes no date field, so parsePub → NaN and
  // every one of its reqs aged to Infinity and was reported as stale. Fall back to the
  // first-seen registry: a req we are observing for the first time appeared within this
  // cycle. Labelled `first-seen` so nothing downstream mistakes it for an ATS timestamp.
  let dateBasis = 'ats-published';
  let ageH;
  if (Number.isFinite(pubMs)) {
    ageH = (Date.now() - pubMs) / 3.6e6;
  } else {
    const seenIso = firstSeen(v.url || c.url || `${c.company}::${c.title}`);
    ageH = seenIso ? (Date.now() - Date.parse(seenIso)) / 3.6e6 : Infinity;
    dateBasis = 'first-seen';
  }
  // Re-apply the leadership/seniority filter to the RESOLVED ATS title, not just the card.
  // A card "<Role> - <City>" can match the employer's "Manager, <Role>, <Team>" — a manager
  // req — and sail past TITLE_DROP because that only ever saw the card. The ATS title is the
  // real one.
  if (TITLE_DROP.test(v.title || '')) {
    rejected.push({ ...c, why: `ATS title is "${v.title}" — leadership/off-archetype, card title was misleading` });
    logReject(c, 'verify', 'ats-title-leadership', `ATS title "${v.title}"`);
    continue;
  }
  // LOCATION. A plain regex reported anything it did not recognise as "not local", including
  // strings carrying no geography at all ("Hybrid", "<Company> HQ"). classifyLocation
  // separates "proves elsewhere" from "proves nothing"; only the former is a rejection. When
  // the ATS string proves nothing we fall back to the LinkedIn card location, which already
  // passed the local-area prefilter — and we record that the geo is card-derived, not ATS-proven.
  const locClass = classifyLocation(v.loc);
  let locBasis = 'ats';
  if (locClass === 'remote' && !remoteAllowed(v.loc, v.title || c.title)) {
    rejected.push({ ...c, why: `ATS location "${v.loc}" is REMOTE (LinkedIn said "${c.loc}")` });
    logReject(c, 'verify', 'remote-on-ats', `ATS location "${v.loc}"`);
    continue;
  }
  if (locClass === 'elsewhere') {
    rejected.push({ ...c, why: `ATS location "${v.loc}" is not in ${areaLabel()} (LinkedIn said "${c.loc}")` });
    logReject(c, 'verify', 'not-local-on-ats', `ATS location "${v.loc}"`);
    continue;
  }
  if (locClass === 'unknown') locBasis = 'linkedin-card-fallback';

  // THE ATS DATE IS NOT A GATE ON THIS LANE (user-set 2026-08-24).
  //
  // History of this line: age was a hard REJECT until 2026-08-20, when it became a ROUTE to
  // _aged-roles.tsv. As of 2026-08-24 it is neither. The user's reasoning, and it is sound:
  // a role surfaced by LinkedIn or HiringCafe is being actively re-promoted, and an employer
  // paying to re-promote a req is still hiring for it. The ATS `publishedAt` records when the
  // requisition was CREATED. That is a different question from whether they want applicants
  // today, and it is the second question that decides whether to apply.
  //
  // WHAT THE ATS IS STILL FOR — do not confuse this rule with "skip the ATS". Every row here
  // has already been ATS-resolved, and that resolution is still mandatory, for four things:
  //   1. the req still EXISTS and is open (a 404 or is_expired is still a hard reject)
  //   2. the canonical JD to score against — never score from a LinkedIn snippet
  //   3. the real location — LinkedIn's Remote/SF chips and ATS isRemote flags both lie
  //   4. comp, and the tenure gate
  // Only the CLOCK stopped being a gate.
  //
  // The age is still RECORDED on the row and still reported, because it moves the legitimacy
  // tier and a year-old req deserves to be named as one before applying. It just no longer
  // decides whether the role is seen.
  const row = { ...c, ats: v.ats, atsUrl: v.url, atsPub: v.pub, atsLoc: v.loc, ageH: Math.round(ageH), dateBasis, locBasis };
  verified.push(row);
}

// ── TIER 3: rescue "no public ATS board" via LinkedIn's own Apply href ──────
// The largest reject bucket by far (15 of 55 on 2026-08-20; 85% historically) is an employer
// whose board name cannot be guessed from its brand. LinkedIn already stores the answer: the
// Apply button links straight at the employer's ATS. Reading that href turns a guess into a
// fact — no click, and it resolves cases slug-guessing CANNOT reach.
//
// Proof case, 2026-08-20: card company "Fin" → apply href → job-boards.greenhouse.io/intercom
// → the real req, first_published that same day. The guess-based
// pass had rejected it as "not on ashby board (8 jobs)" after landing on an unrelated board.
//
// Cost control: this runs ONLY over the already-rejected no-board set, never over all cards.
// Each rescue costs one `jobsearch` action (~15-20/day; the 20-rescue allowance is built into li-budget JOBSEARCH_DAY_CAP).
const rescued = [];
// Reqs Tier-4 proved are real and on-archetype but whose page states no post date. Surfaced
// for a human glance, never written as fresh — see the tier-4 no-date branch.
const needsReview = [];
if (RESCUE && RESCUE_MAX > 0 && rejected.length) {
  const targets = rejected.filter(r => /^no public ATS board/.test(r.why)).slice(0, RESCUE_MAX);
  if (targets.length) {
    console.log(`\nTIER 3 — resolving ${targets.length} unresolved employer(s) via LinkedIn Apply href…`);
    // Job IDs come from the LOGGED-OUT guest API: free, no account action, no jobsearch spend.
    // The results list itself exposes no per-card IDs (verified 2026-08-20: 1 anchor / 25 cards).
    const idMap = new Map();
    for (const kw of KEYWORDS) {
      try {
        const m = await guestJobIds({ keywords: kw, geoId: GEO_ID, hours: HOURS, pages: 4 });
        for (const [k, v] of m) if (!idMap.has(k)) idMap.set(k, v);
      } catch { /* guest lane is best-effort; a miss just means no rescue for that card */ }
    }
    console.log(`  guest API supplied ${idMap.size} job id(s)`);

    for (const t of targets) {
      const key = `${_norm(t.company)}|${_norm(t.title)}`;
      let hit = idMap.get(key);
      // The broad sweep almost never holds these employers (the guest index is a subset of
      // the logged-in one). Fall back to a search scoped to THIS company — one guest request,
      // off-account. Measured 2026-08-20: broad-map-only rescued 0 of 15.
      if (!hit) {
        try { hit = await guestJobIdFor(t.company, t.title, { geoId: GEO_ID, hours: HOURS }); }
        catch { /* best-effort */ }
        if (hit) console.log(`  targeted guest lookup resolved ${t.company} — ${t.title}`);
      }
      if (!hit) { t.why += ' [tier3: no guest job id]'; logReject(t, 'tier3', 'no-guest-job-id'); continue; }

      const c = claim('jobsearch', `applyurl ${t.company}`);
      if (!c.ok) { console.log(`  budget stop: ${c.reason}`); break; }

      const res = await applyUrlForJob(hit.id);
      if (res?.throttled) { cooldown('HTTP 999/429 during tier-3', 6); break; }
      if (res?.authwall) { console.log('  authwall during tier-3 — stopping'); break; }
      if (!res?.ats) { t.why += res?.easyApply ? ' [tier3: Easy Apply, no external board]' : ' [tier3: no apply href]'; continue; }

      const a = res.ats;
      // Record the real careers host for the index either way — even an unfetchable family
      // (workday, smartrecruiters) is a resolved employer identity the index wants.
      try {
        appendFileSync(`${ROOT}data/_linkedin-applyurl-resolved.tsv`,
          [new Date().toISOString(), canonicalCompany(t.company), t.title, a.atsType, a.slug || '', a.url].join('\t') + '\n');
      } catch {}

      // ── TIER 4: open the resolved apply URL in a real browser ────────────────────
      // Tier-3 hands back the employer's OWN posting URL. Discarding it here because the
      // family has no JSON API was giving up one step from the answer — we were holding the
      // exact link and never opening it (user, 2026-08-20: "you have the actual href, why
      // don't you open it"). These are ordinary career sites, not linkedin.com: no LinkedIn
      // budget, no stealth rules. They DO bot-wall plain fetch (careers.jacobs.com answers
      // curl with HTTP 202 and no body), which is why this uses the real browser.
      if (!a.apiUrl) {
        // A Workday apply URL carries tenant+site, which IS a queryable API — build it,
        // record it for the index, and this employer never needs the browser again.
        const wdApi = workdayApiFromUrl(a.url);
        if (wdApi) {
          try { appendFileSync(DISCOVERED, `${canonicalCompany(t.company)}\t${a.url.split('/job/')[0]}\n`); } catch {}
          console.log(`  tier4: ${t.company} is Workday → indexable ${wdApi}`);
        }
        const pg = await verifyCareersPage(a.url).catch(() => null);
        if (!pg || pg.error || !pg.title) {
          t.why += ` [tier4: could not read ${a.atsType} page]`;
          logReject(t, 'tier4', 'careers-page-unreadable', a.url);
          continue;
        }
        const cls = classifyLocation(pg.location);
        const remoteSaid = /remote|telecommute/i.test(String(pg.remoteFlag || ''));
        if ((remoteSaid || cls === 'remote') && !remoteAllowed(`${pg.location || ''} remote`, pg.title || t.title)) {
          t.why += ` [tier4: employer page says REMOTE (${pg.remoteFlag || pg.location})]`;
          logReject(t, 'tier4', 'remote-on-careers-page', `${pg.location || ''} / ${pg.remoteFlag || ''}`);
          continue;
        }
        if (cls === 'elsewhere') {
          t.why += ` [tier4: employer page location "${pg.location}" is not in ${areaLabel()}]`;
          logReject(t, 'tier4', 'not-local-on-careers-page', String(pg.location));
          continue;
        }
        if (TITLE_DROP.test(pg.title || '')) {
          t.why += ` [tier4: page title "${pg.title}" is leadership/off-archetype]`;
          logReject(t, 'tier4', 'leadership-on-careers-page', pg.title);
          continue;
        }
        // Freshness: only when the page STATES it. "Posted Today"/"Posted N Days Ago" and an
        // ISO date are both accepted; anything else stays unverified and must NOT be treated
        // as fresh — this pipeline never claims a freshness it cannot prove.
        const d = String(pg.datePosted || '');
        let t4Age = null;
        if (/^today$/i.test(d)) t4Age = 0;
        else if (/^\d{4}-\d{2}-\d{2}/.test(d)) t4Age = (Date.now() - Date.parse(d)) / 3.6e6;
        else { const m = d.match(/(\d+)\+?\s*(day|week|month)/i); if (m) t4Age = Number(m[1]) * ({ day: 24, week: 168, month: 720 }[m[2].toLowerCase()]); }
        const t4Basis = 'careers-page-date';
        // A MISSING DATE IS NO LONGER DISQUALIFYING (2026-08-24) — but a missing REQ still is.
        //
        // The old rule sent every dateless careers page to NEEDS REVIEW, reasoning that the
        // 24h board must not carry unfalsifiable rows. Since the ATS date stopped gating this
        // lane, the date is not what the decision turns on any more. What still matters is
        // whether we actually resolved a SPECIFIC REQUISITION or just landed on a careers index.
        //
        // The discriminator is the location. A real posting states where the job is; a careers
        // index does not — which is exactly why the rejects read "Harness — We're hiring" and
        // " Careers" with no location. So: location present and local, rescue it with the
        // age recorded as unknown. Location absent, we cannot name the req, and it stays NEEDS
        // REVIEW — a legitimacy problem, not a freshness one.
        if (t4Age === null && !pg.location) {
          firstSeen(a.url);
          needsReview.push({ company: canonicalCompany(t.company), title: pg.title || t.title,
            loc: `(page states none; LinkedIn said "${t.loc}")`, url: a.url, cardAge: t.age });
          t.why += ` [tier4: page states neither a location nor a post date — could not resolve a specific req, NEEDS REVIEW]`;
          logReject(t, 'tier4', 'no-req-identified-on-careers-page', `${pg.title}`);
          continue;
        }
        // No age gate (2026-08-24): a re-promoted req means they are still hiring. The age is
        // carried on the row and reported; it does not decide whether the role is seen.
        t.rescued = true;
        const t4Label = t4Age === null ? 'age unstated' : `${Math.round(t4Age)}h`;
        const t4Row = { ...t, company: canonicalCompany(t.company), title: pg.title, ats: a.atsType,
          atsUrl: a.url, atsPub: pg.datePosted || `date-not-stated:first-seen ${new Date().toISOString()}`,
          atsLoc: pg.location, ageH: t4Age === null ? null : Math.round(t4Age),
          dateBasis: t4Age === null ? 'careers-page-no-date' : t4Basis, via: 'tier4-careers-page' };
        rescued.push(t4Row);
        // ALSO push to `verified` — this was missing (fixed 2026-08-24). Tier 3 has always done
        // `rescued.push(row); verified.push(row);` and tier 4 only did the first half, so every
        // tier-4 rescue was printed, counted in the JSON summary, and then silently discarded:
        // only `verified` is written to _web-roles.tsv. The bug was invisible while the date gate
        // was in place, because tier 4 almost never rescued anything. The moment the gate came
        // off, one run rescued five real local roles, and none of them would have reached scoring.
        //
        // Safe to promote: tier 4 already applies the same gates as tier 3 above — remote,
        // not-local, leadership/off-archetype title — and the row carries the same field names the
        // writer reads (company, title, atsLoc, atsPub, atsUrl).
        verified.push(t4Row);
        console.log(`  ✅ tier4 rescued ${t.company} — ${pg.title} | ${pg.location} | ${t4Label} (${t4Age === null ? 'careers-page-no-date' : t4Basis})`);
        continue;
      }

      const exact = await fetchExactReq(a);
      if (!exact) { t.why += ` [tier3: ${a.atsType}/${a.slug} did not answer]`; continue; }

      const pubMs = parsePub(exact.pub);
      const ageH = Number.isFinite(pubMs) ? (Date.now() - pubMs) / 3.6e6 : Infinity;
      if (TITLE_DROP.test(exact.title || '')) { t.why += ` [tier3: ATS title "${exact.title}" is leadership/off-archetype]`; continue; }
      if (exact.loc && !locationMatches(exact.loc, exact.title || t.title)) { t.why += ` [tier3: ATS location "${exact.loc}" not in ${areaLabel()}]`; continue; }

      t.rescued = true;
      const row = { ...t, company: exact.employer || t.company, title: exact.title || t.title,
        ats: a.atsType, atsUrl: exact.url || a.url, atsPub: exact.pub, atsLoc: exact.loc,
        ageH: Math.round(ageH), via: 'tier3-applyurl' };
      rescued.push(row);
      verified.push(row);
    }
    // Rescued rows are no longer rejects.
    for (let i = rejected.length - 1; i >= 0; i--) if (rejected[i].rescued) rejected.splice(i, 1);
    console.log(`  rescued ${rescued.length} req(s) that the guess-based pass had discarded`);
  }
}

console.log(`VERIFIED (ATS-confirmed OPEN + ${areaLabel()}; age reported, not gated):`);
if (!verified.length) console.log('  (none)');
for (const v of verified) console.log(`  ✅ ${v.company} — ${v.title} | ${v.atsLoc} | ${v.ageH === null ? 'age unstated' : v.ageH + 'h'} | ${v.atsUrl}`);

if (needsReview.length) {
  console.log(`\nNEEDS REVIEW — on-archetype, but the employer page states no location, so no specific req could be identified (${needsReview.length}):`);
  for (const n of needsReview) console.log(`  ? ${n.company} — ${n.title} | ${n.loc} | LinkedIn claimed "${n.cardAge}" | ${n.url}`);
  try {
    writeFileSync(`${ROOT}data/_linkedin-needs-review.tsv`,
      'date\tcompany\ttitle\tlocation\tlinkedin_claimed_age\turl\n' +
      needsReview.map(n => [new Date().toISOString().slice(0, 10), n.company, n.title, n.loc, n.cardAge, n.url].join('\t')).join('\n') + '\n', 'utf-8');
  } catch { /* diagnostics only */ }
}

console.log('\nAGED (legacy bucket — nothing routes here since 2026-08-24; age no longer diverts a role):');
if (!aged.length) console.log('  (none)');
for (const a of aged) console.log(`  ~ ${a.company} — ${a.title} | ${a.atsLoc || a.loc} | ${a.ageH}h | ${a.atsUrl}`);

console.log('\nREJECTED at ATS verification:');
for (const r of rejected) console.log(`  ✗ ${r.company} — ${r.title}: ${r.why}`);

// Persist the per-card reject log. Truncated each run: this answers "why was THIS card not
// analysed in the latest crawl?", and a rolling append would make the newest run harder to
// read, not easier. The pipeline log keeps the historical narrative.
try {
  writeFileSync(REJECT_LOG,
    'date\tcompany\ttitle\tcard_location\tcard_age\tstage\trule\tdetail\n' +
    (rejectRows.length ? rejectRows.join('\n') + '\n' : ''), 'utf-8');
  console.log(`\nreject log: ${rejectRows.length} card(s) → data/_linkedin-rejects.tsv  (grep it: why was X skipped)`);
} catch (e) { console.error(`reject log write failed: ${e.message}`); }

if (WRITE && verified.length) {
  const today = new Date().toLocaleDateString('en-CA');
  for (const v of verified) {
    // Write the CANONICAL employer name, not LinkedIn's display name. Downstream dedup
    // (scored-jobs.tsv, merge-tracker, the company index) all key on the employer, and a row
    // filed under "Mendable" would not dedup against the Firecrawl rows already there — the
    // same req could be scored, reported and outreached twice under two names.
    appendFileSync(`${ROOT}data/_web-roles.tsv`,
      [today, canonicalCompany(v.company), v.title, v.atsLoc || v.loc, v.atsPub, v.atsUrl, 'linkedin-crawl'].join('\t') + '\n');
  }
  console.log(`\nwrote ${verified.length} verified row(s) → data/_web-roles.tsv`);
  const undated = verified.filter((v) => v.ageH === null).length;
  if (undated) {
    console.log(`  (${undated} of them state no post date at all — kept, because a date the ` +
      `employer never published is not evidence the req is closed. Their location resolved, ` +
      `which is what proves a specific requisition was identified rather than a careers index.)`);
  }
  const older = verified.filter((v) => v.ageH !== null && v.ageH > ATS_HOURS).length;
  if (older) {
    console.log(`  (${older} of them have an ATS publish date older than ${ATS_HOURS}h — kept, ` +
      `because a re-promoted req means they are still hiring. Age is reported per row above and ` +
      `moves the legitimacy tier, it no longer decides visibility.)`);
  }
  // Retained but now unreachable: `aged` is never populated. Kept so that a future lane which
  // DOES want a separate older-than feed has the writer already here and correct.
  if (aged.length) {
    for (const a of aged) {
      appendFileSync(`${ROOT}data/_aged-roles.tsv`,
        [today, canonicalCompany(a.company), a.title, a.atsLoc || a.loc, a.atsPub,
         a.atsUrl, 'linkedin-crawl-aged', a.ageH].join('\t') + '\n');
    }
    console.log(`wrote ${aged.length} aged row(s) → data/_aged-roles.tsv (still open, older than ${ATS_HOURS}h)`);
  }
} else if (WRITE) {
  console.log('\nnothing verified — no rows written (this is a valid, honest outcome).');
}
// The index feed is the point of the LinkedIn lane even when zero rows verify: LinkedIn tells us
// WHICH EMPLOYERS ARE HIRING, and every unresolvable one is a net-new company for the sweep.
if (queuedForIndex.length) {
  console.log(`\nindex feed: ${queuedForIndex.length} net-new employer(s) queued → ${DISCOVERED}`);
  console.log(`  ${queuedForIndex.slice(0, 15).join(', ')}${queuedForIndex.length > 15 ? ', …' : ''}`);
  // probe-ats FIRST. discover-companies needs `company<TAB>careers_url` and silently drops any
  // row without one (parseTsvPairs requires /^https?:\/\//), so queueing bare names resolved
  // exactly 0 of 55 employers between 2026-07-31 and 2026-08-06. probe-ats turns a bare name
  // into a careers_url across the six ATS families the crawl itself does not probe.
  console.log('  next: node scripts/probe-ats.mjs --unresolved --append && node scripts/discover-companies.mjs --from data/_discovered-companies.tsv');
}

writeStatus({
  ok: !stopped,
  stopped_because: stopped || null,
  keywords: KEYWORDS,
  pages_per_keyword: PAGES,
  page_counts: pageCounts,
  unique_cards: cards.size,
  prefiltered: prefiltered.length,
  verified: verified.length,
  rejected: rejected.length,
  queued_for_index: queuedForIndex.length,
  rescued_via_applyurl: rescued.length,
  aged_routed: aged.length,
  wrote_rows: WRITE ? verified.length : 0,
});

// A crawl that was STOPPED (budget, throttle, authwall, dead parser) is a failure and must
// exit non-zero so the pipeline can say so. Zero verified rows on a healthy crawl is NOT a
// failure — it is the honest answer on a quiet day.
if (stopped) { console.error(`\nlinkedin-crawl: FAILED — ${stopped}`); process.exit(2); }
process.exit(0);
