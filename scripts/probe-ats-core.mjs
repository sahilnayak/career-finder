/**
 * probe-ats-core.mjs — the ATS-board probing logic, importable.
 *
 * Extracted from probe-ats.mjs on 2026-09-03 for the same reason scan-core.mjs was extracted
 * from scan.mjs: probe-ats.mjs is a CLI whose `main()` runs unconditionally on import (and
 * exits 1 when no mode flag is present), so nothing else could reuse `probeCompany()` without
 * spawning a child process. Callers can use it in-process to resolve boards for
 * companies the index does not know. probe-ats.mjs now imports from here; its behaviour is
 * unchanged.
 *
 * Zero LLM cost — plain HTTP against public endpoints. See probe-ats.mjs for the history.
 */

import { record as recordRequest } from './request-ledger.mjs';
import { detectApi, detectEnterprise, SUPPORTED_FAMILIES } from './scan-core.mjs';

// Corporate suffixes dropped to form the "core" name. Order of variants returned (most specific
// first, deduped, capped at 7 so the Workday matrix per slug stays bounded):
//   full name (compact, dashed) -> without legal suffixes (Inc/LLC/Corp) -> without any suffixes (compact, dashed) -> first word.
// "Acme Health Inc" -> acmehealthinc, acme-health-inc, acme, ... ; "Tempus Labs" -> tempuslabs,
// tempus-labs, tempus. The first word is tried LAST: it is the loosest guess, and verify() checks
// the board's own org name where the family exposes one.
export const SLUG_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|tech|labs|lab|software|ai|health|healthcare|hq|io|group|systems|holdings|the)\b/g;
export function slugs(name) {
  const lower = String(name || '').toLowerCase().trim().replace(/&/g, ' and ').replace(/[.,'’]/g, '');
  const compact = (s) => s.replace(/[^a-z0-9]/g, '');
  const dashed = (s) => s.trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const legal = lower.replace(/\b(inc|llc|ltd|corp|corporation|co|company|holdings)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const core = lower.replace(SLUG_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  const first = (core || lower).split(/[\s-]+/)[0] || '';
  const out = [compact(lower), dashed(lower), compact(legal), dashed(legal), compact(core), dashed(core), compact(first)];
  return [...new Set(out.filter((s) => s && s.length > 1))].slice(0, 7);
}

/**
 * Probe definitions. Each returns a candidate {family, api, careers} for a slug.
 * `count` reads the posting count out of a successful response so a 200 that is
 * really an empty placeholder board doesn't get indexed as a live employer.
 */
export const FAMILIES = [
  {
    family: 'smartrecruiters',
    api: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=10`,
    careers: (s) => `https://careers.smartrecruiters.com/${s}`,
    count: (j) => (j && (j.totalFound ?? (j.content || []).length)) || 0,
  },
  {
    family: 'workable',
    api: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    careers: (s) => `https://apply.workable.com/${s}`,
    count: (j) => ((j && j.jobs) || []).length,
  },
  {
    family: 'recruitee',
    api: (s) => `https://${s}.recruitee.com/api/offers/`,
    careers: (s) => `https://${s}.recruitee.com`,
    count: (j) => ((j && j.offers) || []).length,
  },
  {
    // teamtailor serves RSS, not JSON — which is why it was skipped when the other families were
    // added, and why probe-ats's own docstring has been promising coverage it did not have.
    // scan-core.mjs already parses this feed (parseTeamtailorRss); the prober just needed a
    // text-mode branch. Verified live 2026-08-24: sullyai.teamtailor.com/jobs.rss -> HTTP 200,
    // application/rss+xml, 5 <item> entries.
    family: 'teamtailor',
    api: (s) => `https://${s}.teamtailor.com/jobs.rss`,
    careers: (s) => `https://${s}.teamtailor.com/jobs.rss`,
    text: true,
    count: (t) => (String(t).match(/<item>/g) || []).length,
  },
  {
    // Regional infix. Verified: zignallabs.na.teamtailor.com and swishanalytics.na.teamtailor.com
    // are both live while the bare slug.teamtailor.com form 404s for them.
    family: 'teamtailor',
    api: (s) => `https://${s}.na.teamtailor.com/jobs.rss`,
    careers: (s) => `https://${s}.na.teamtailor.com/jobs.rss`,
    text: true,
    count: (t) => (String(t).match(/<item>/g) || []).length,
  },
  {
    // iCIMS: name-derived host, HTML listing. Supported by scan-core since 2026-10-04
    // (was detect-only). Count = distinct /jobs/{id}/ links on page 1.
    family: 'icims',
    api: (s) => `https://careers-${s}.icims.com/jobs/search?ss=1&in_iframe=1`,
    careers: (s) => `https://careers-${s}.icims.com/jobs`,
    text: true,
    count: (t) => new Set(String(t).match(/\/jobs\/\d+\//g) || []).size,
  },
  {
    family: 'rippling',
    api: (s) => `https://api.rippling.com/platform/api/ats/v1/board/${s}/jobs`,
    careers: (s) => `https://ats.rippling.com/${s}/jobs`,
    count: (j) => (Array.isArray(j) ? j.length : 0),
  },
];

/**
 * The three families the company index already knows how to guess (ashby / greenhouse / lever).
 * probe-ats.mjs deliberately skips them because linkedin-crawl.mjs already tries them; the
 * A standalone caller has no such upstream, so it asks for them explicitly via `probeCompany(name,
 * { includeCore: true })`. Ashby's board API 200s with `jobs: []` for a wrong slug only rarely;
 * greenhouse and lever 404. `count` guards the placeholder case either way.
 */
export const CORE_FAMILIES = [
  {
    family: 'ashby',
    api: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    careers: (s) => `https://jobs.ashbyhq.com/${s}`,
    count: (j) => ((j && j.jobs) || []).length,
  },
  {
    family: 'greenhouse',
    api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    careers: (s) => `https://job-boards.greenhouse.io/${s}`,
    count: (j) => ((j && j.jobs) || []).length,
  },
  {
    family: 'lever',
    api: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    careers: (s) => `https://jobs.lever.co/${s}`,
    count: (j) => (Array.isArray(j) ? j.length : 0),
  },
];

// Workday needs a tenant AND a site name, neither guessable from the company name
// alone, so it gets a small explicit matrix instead of one URL. Shards and site
// names are the handful that actually occur in the wild; this is deliberately not
// exhaustive — a miss here costs nothing, a false positive costs index pollution.
// Calibrated against live tenants 2026-07-29: nvidia.wd5/NVIDIAExternalCareerSite
// (2000 postings) and salesforce.wd12/External_Career_Site (1478). The
// "{Company}ExternalCareerSite" shape is common enough to be worth deriving from the
// slug rather than hard-coding. Every shard×site combination must be tried — see
// tryUrl for why the HTTP status cannot be used to shortcut the search.
export const WD_SHARDS = ['wd1', 'wd5', 'wd3', 'wd12'];
export function wdSites(slug) {
  const up = slug.toUpperCase();
  const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
  return [
    'External', 'External_Career_Site', 'careers', 'Careers',
    `${up}ExternalCareerSite`, `${cap}ExternalCareerSite`, `${slug}ExternalCareerSite`,
    `${cap}Careers`, `${up}_External_Career_Site`, 'External_Careers',
    // UNDERSCORED {TENANT}_Careers (added 2026-08-24). The list above had the CONCATENATED form
    // (`CiscoCareers`) but never the underscored one, and the underscored one is what large
    // enterprises actually use. Verified live the same day:
    //     cisco.wd5/CISCO_Careers -> 1,165 jobs
    //     spgi.wd5/SPGI_Careers   ->   313 jobs
    // Both were invisible to this prober purely for want of an underscore. The site name, not the
    // tenant, is the harder half of a Workday address: `cisco` is derivable from "Cisco", so that
    // board was reachable all along and the matrix simply never asked for the right site.
    // Workday treats the site name case-insensitively (CISCO_Careers, cisco_careers and
    // Cisco_Careers all resolve), so one casing per shape is enough.
    `${up}_Careers`, `${cap}_Careers`, `${slug}_careers`,
  ];
}

export function workdayProbes(slug) {
  const out = [];
  for (const shard of WD_SHARDS) {
    for (const site of wdSites(slug)) {
      out.push({
        family: 'workday',
        api: `https://${slug}.${shard}.myworkdayjobs.com/wday/cxs/${slug}/${site}/jobs`,
        careers: `https://${slug}.${shard}.myworkdayjobs.com/${site}`,
        post: true,
        shard, site,
      });
    }
  }
  return out;
}

/**
 * ATS families the prober can DETECT but scan-core cannot parse yet. A hit here is still worth
 * recording in the index (ats_type = family, no api url) so scan-core / discover-companies can log
 * "unsupported family" instead of the employer being invisible. Oracle HCM (careers-*.oraclecloud.com,
 * Taleo's successor) and SuccessFactors need a tenant id that is not derivable from the name, so
 * they are URL-detection only; iCIMS and Jobvite have name-derived hosts and get a light HTML probe.
 */
// iCIMS, Oracle HCM (with a siteNumber) and Taleo Enterprise moved to scan-core on 2026-10-04.
// 'oracle-hcm' stays here for the case detectApi cannot resolve: an oraclecloud host with no
// siteNumber that probeCareersUrl() could not recover either. 'taleo-business' (*.tbe.taleo.net)
// is a different product with no parser.
export const UNSUPPORTED_FAMILIES = [
  { family: 'oracle-hcm', re: /oraclecloud\.com/i },
  { family: 'taleo-business', re: /\.tbe\.taleo\.net/i },
  { family: 'successfactors', re: /successfactors\.(com|eu)|\.sapsf\.com|career\d*\.successfactors/i },
  { family: 'jobvite', re: /jobs\.jobvite\.com|\.jobvite\.com/i },
  { family: 'paycor', re: /recruitingbypaycor\.com|paycor\.com\/career/i },
];
/** Detect-only family for a URL scan-core cannot parse (null when it CAN, or when unknown). */
export function detectFamily(url) {
  const u = String(url || '');
  if (detectApi({ careers_url: u })) return null;
  return UNSUPPORTED_FAMILIES.find((f) => f.re.test(u))?.family || null;
}
export const DETECT_ONLY_PROBES = [
  {
    family: 'jobvite',
    api: (s) => `https://jobs.jobvite.com/${s}/jobs`,
    careers: (s) => `https://jobs.jobvite.com/${s}/jobs`,
    text: true,
    count: (t) => new Set(String(t).match(/\/job\/o[A-Za-z0-9]+/g) || []).size,
  },
];

// Employer name as the board itself reports it, where the payload carries one. Used for the
// identity check: a live board whose org name doesn't match the requested company is a slug
// collision (the Nooks -> SCIF-company case), not a find.
export function payloadOrgName(family, j) {
  try {
    if (family === 'greenhouse') return j.jobs?.[0]?.company_name || null;
    if (family === 'smartrecruiters') return j.content?.[0]?.company?.name || null;
    if (family === 'workable') return j.name || null;
    if (family === 'recruitee') return j.offers?.[0]?.company_name || null;
  } catch { /* fallthrough */ }
  return null;
}
const normName = (s) => String(s || '').toLowerCase()
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|labs|hq|the)\b\.?/g, '')
  .replace(/[^a-z0-9]/g, '');
export function namesMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

export async function tryUrl({ api, post, text }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(api, {
      method: post ? 'POST' : 'GET',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 career-finder/probe-ats' },
      body: post ? JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }) : undefined,
      signal: ctl.signal,
    });
    recordRequest(api, { status: res.status });
    // Workday status codes carry NO usable tenant signal — verified 2026-07-29:
    // nvidia.wd5/External returns 404 even though wd5 IS nvidia's real shard (the
    // site name is just wrong), while the wrong shard nvidia.wd1 returns 422. An
    // earlier version treated 422 as "tenant exists" and skipped a shard on 404,
    // which made it miss NVIDIA and Salesforce outright. Only a 200 with postings
    // counts; every combination gets probed.
    if (!res.ok) return null;
    // MUST be awaited inside the try. `return res.json()` hands back a pending promise,
    // so the try block has already exited by the time it rejects and the catch never
    // fires — a careers page that answers 200 with HTML then crashed the whole run with
    // an unhandled SyntaxError partway through (observed at 75/308 on 2026-07-29).
    // RSS/XML families (teamtailor) need the raw body; everything else is JSON.
    if (text) return await res.text();
    return await res.json();
  } catch (e) { if (e?.name === 'AbortError' || e?.name === 'TypeError') recordRequest(api, { status: e.name === 'AbortError' ? 'timeout' : 'error' }); return null; }
  finally { clearTimeout(t); }
}

/**
 * Find a live board for a company name. Returns {name, family, slug, careers, postings} or null.
 * `includeCore` also tries ashby/greenhouse/lever first (off by default to keep probe-ats.mjs's
 * behaviour identical). `skipWorkday` skips the 4x13 Workday matrix when the caller only wants
 * the cheap single-GET families.
 */
// Identity check. `verified:false` + `reason` means the board is live but we cannot trust that
// it belongs to `name`: the payload names a different employer, or it carries <=1 posting (a
// placeholder, or a big employer whose real board lives elsewhere). Callers log these as
// 'unverified' and do not index them.
function verify(hit, org) {
  if (org && !namesMatch(hit.name, org)) return { ...hit, org, verified: false, reason: `payload names "${org}"` };
  if (hit.postings <= 1) return { ...hit, org, verified: false, reason: `only ${hit.postings} posting` };
  return { ...hit, org, verified: true };
}

export async function probeCompany(name, { includeCore = false, skipWorkday = false } = {}) {
  const fams = includeCore ? [...CORE_FAMILIES, ...FAMILIES] : FAMILIES;
  for (const slug of slugs(name)) {
    // Non-Workday families first: single cheap GET each.
    for (const f of fams) {
      const j = await tryUrl({ api: f.api(slug), text: f.text });
      if (!j) continue;
      const n = f.count(j);
      if (n > 0) return verify({ name, family: f.family, slug, careers: f.careers(slug), postings: n }, payloadOrgName(f.family, j));
    }
    if (includeCore) {
      for (const f of DETECT_ONLY_PROBES) {
        const t = await tryUrl({ api: f.api(slug), text: true });
        const n = t ? f.count(t) : 0;
        if (n > 0) return verify({ name, family: f.family, slug, careers: f.careers(slug), postings: n, unsupported: true }, null);
      }
    }
    if (skipWorkday) continue;
    // Workday last, and the whole shard×site matrix has to be tried (see tryUrl).
    // Run it concurrently so ~40 combinations cost about one round-trip of wall time
    // instead of forty, and take the first live board.
    const probes = workdayProbes(slug);
    for (let i = 0; i < probes.length; i += 10) {
      const batch = probes.slice(i, i + 10);
      const results = await Promise.all(batch.map(async (p) => {
        const j = await tryUrl(p);
        const n = j && (j.total ?? (j.jobPostings || []).length);
        return n > 0 ? verify({ name, family: 'workday', slug, careers: p.careers, postings: n }, null) : null;
      }));
      const hit = results.find(Boolean);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Careers URL -> family + board id ────────────────────────────────
// Matches every ATS URL embedded in an employer's own careers page (vanity domains like
// careers.oracle.com or jobs.example.com that front an enterprise ATS).
const EMBED_RE = /https?:\/\/[a-z0-9.-]+\.(?:icims\.com|oraclecloud\.com|taleo\.net|myworkdayjobs\.com|greenhouse\.io|ashbyhq\.com|lever\.co|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com|teamtailor\.com|rippling\.com|successfactors\.(?:com|eu)|sapsf\.com|jobvite\.com)[^"'\s<>)]*/gi;
const ORACLE_SITE_GUESSES = ['CX_1', 'CX_1001', 'CX', 'CX_2', 'CX_3'];

async function oracleSiteLive(host, site) {
  const j = await tryUrl({ api: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1` });
  return j?.items?.[0]?.TotalJobsCount || 0;
}
function shape(api, url, via) {
  return { family: api.type, board: api.board || api._slug || api.url, api_url: api.url, careers_url: url, supported: SUPPORTED_FAMILIES.includes(api.type), via };
}

/**
 * Resolve ANY careers URL to {family, board, api_url, careers_url, supported, via} or
 * {family, supported:false, via:'detect-only'} for a recognised-but-unparsed ATS, or null.
 *  1. the URL itself is an ATS URL (detectApi)
 *  2. an Oracle host with no siteNumber: try CX_1 / CX_1001 / ... against the REST endpoint
 *  3. fetch the page and look for an embedded ATS URL (iframe src, apply links, siteNumber)
 */
/**
 * Greenhouse / Lever / Ashby boards embedded in a careers page's HTML. Returns canonical careers
 * URLs (detectApi-ready), most-specific first. Catches what the generic EMBED_RE missed:
 *   - Greenhouse embeds: boards.greenhouse.io/embed/job_board?for=<slug> (and /js?for=), where
 *     the path segment is "embed", not the board; boards-api.greenhouse.io/v1/boards/<slug>
 *   - gh_jid=<id> links (company-hosted Greenhouse job pages): board token taken from a
 *     `for=` / grnhse script on the same page; gh_jid alone = detect-only greenhouse
 *   - jobs.lever.co/<slug>, api.lever.co/v0/postings/<slug>
 *   - jobs.ashbyhq.com/<slug> (incl. /embed), api.ashbyhq.com/posting-api/job-board/<slug>
 * @returns {{boards: string[], ghJid: boolean}}
 */
export function embeddedBoards(html) {
  const h = String(html || '').replace(/&amp;/g, '&').replace(/\\\//g, '/');
  const boards = [];
  const add = (u) => { if (!boards.includes(u)) boards.push(u); };
  const BAD = /^(embed|v1|api|jobs|job_board|js)$/i;
  for (const m of h.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s<>]*&)?for=([a-z0-9_-]+)/gi)) add(`https://job-boards.greenhouse.io/${m[1].toLowerCase()}`);
  for (const m of h.matchAll(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi)) add(`https://job-boards.greenhouse.io/${m[1].toLowerCase()}`);
  for (const m of h.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/gi)) if (!BAD.test(m[1])) add(`https://job-boards.greenhouse.io/${m[1].toLowerCase()}`);
  const ghJid = /[?&]gh_jid=\d+/i.test(h);
  if (ghJid) { const f = h.match(/grnhse[^<]*?for=([a-z0-9_-]+)|[?&]for=([a-z0-9_-]+)[^"'<>]*greenhouse/i); if (f) add(`https://job-boards.greenhouse.io/${(f[1] || f[2]).toLowerCase()}`); }
  for (const m of h.matchAll(/(?:jobs\.lever\.co|api\.lever\.co\/v0\/postings)\/([a-z0-9_.-]+)/gi)) if (!BAD.test(m[1])) add(`https://jobs.lever.co/${m[1].toLowerCase()}`);
  for (const m of h.matchAll(/(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([a-z0-9_.%-]+)/gi)) if (!BAD.test(m[1])) add(`https://jobs.ashbyhq.com/${m[1]}`);
  return { boards, ghJid };
}

export async function probeCareersUrl(url) {
  const direct = detectApi({ careers_url: url });
  if (direct) return shape(direct, url, 'url');
  const oh = String(url).match(/\/\/([a-z0-9.-]+\.oraclecloud\.com)/i);
  if (oh) {
    for (const site of ORACLE_SITE_GUESSES) {
      if (await oracleSiteLive(oh[1], site)) {
        const u = `https://${oh[1]}/hcmUI/CandidateExperience/en/sites/${site}/requisitions`;
        return shape(detectEnterprise(u), u, `oracle-site-guess:${site}`);
      }
    }
  }
  const html = await tryUrl({ api: url, text: true });
  if (html) {
    // Greenhouse/Lever/Ashby embeds first: their canonical board, not whatever URL appears first.
    const emb = embeddedBoards(html);
    for (const u of emb.boards) { const a = detectApi({ careers_url: u }); if (a) return shape(a, u, 'embedded'); }
    if (emb.ghJid) return { family: 'greenhouse', board: null, api_url: '', careers_url: url, supported: false, via: 'detect-only (gh_jid, no board token on page)' };
    const found = [...new Set(String(html).replace(/&amp;/g, '&').replace(/\\\//g, '/').match(EMBED_RE) || [])];
    for (const u of found) { const a = detectApi({ careers_url: u }); if (a) return shape(a, u, 'embedded'); }
    // Oracle CE pages carry siteNumber in inline JS even when no full URL is present.
    const site = String(html).match(/siteNumber["':=\s]+["']?(CX_?\d*)/)?.[1];
    const host = found.map(u => u.match(/\/\/([a-z0-9.-]+\.oraclecloud\.com)/i)?.[1]).find(Boolean) || oh?.[1];
    if (site && host) { const u = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/requisitions`; return shape(detectEnterprise(u), u, 'embedded-site'); }
    const fam = found.map(detectFamily).find(Boolean) || detectFamily(url);
    if (fam) return { family: fam, board: null, api_url: '', careers_url: found.find(u => detectFamily(u) === fam) || url, supported: false, via: 'detect-only' };
  }
  const fam = detectFamily(url);
  return fam ? { family: fam, board: null, api_url: '', careers_url: url, supported: false, via: 'detect-only' } : null;
}
