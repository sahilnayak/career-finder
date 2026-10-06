#!/usr/bin/env node

/**
 * scan-core.mjs — Shared ATS detection / fetch / parse / filter / dedup helpers.
 *
 * Extracted from scan.mjs so the company-index pipeline (build-company-index.mjs,
 * scan-index.mjs) can reuse the same battle-tested logic without duplicating it.
 * scan.mjs remains standalone; these are the canonical helpers for new code.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 */

import { record as recordRequest } from './request-ledger.mjs';
import { classifyLocation as targetsClassify, locationVerdict, titleMatches, hasTargets } from './targets.mjs';
import * as targetsMod from './targets.mjs';
import { readFileSync, existsSync, appendFileSync } from 'fs';

export const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
export const PIPELINE_PATH = 'data/pipeline.md';
export const APPLICATIONS_PATH = 'data/applications.md';
export const SCORED_JOBS_PATH = 'data/scored-jobs.tsv';

export const FETCH_TIMEOUT_MS = 10_000;
// Local timezone for date bucketing: CAREER_FINDER_TZ > profile location.timezone > machine zone.
function profileTimezone() {
  try {
    if (typeof targetsMod.timezone === 'function') return targetsMod.timezone();
    if (hasTargets()) return targetsMod.loadTargets().location?.timezone || '';
  } catch { /* no profile yet */ }
  return '';
}
export const TZ = process.env.CAREER_FINDER_TZ || profileTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** pipeline.scan_window_days from the profile (default 7). */
export function scanWindowDays() {
  try { return Number(targetsMod.loadTargets().pipeline?.scan_window_days) || 7; } catch { return 7; }
}

/** True when company+title hits a targets.dealbreakers word (case-insensitive substring). */
export function dealbreakerHit(company, title = '') {
  if (typeof targetsMod.dealbreakerHit === 'function') return targetsMod.dealbreakerHit(company, title);
  let words = [];
  try { words = (targetsMod.loadTargets().targets?.dealbreakers || []).map(w => String(w).toLowerCase().trim()).filter(Boolean); } catch { return false; }
  const hay = `${company || ''} ${title || ''}`.toLowerCase();
  return words.some(w => hay.includes(w));
}

export const MIN_COVERAGE_BOARDS = 20;
/** Loud stderr warning when the board index is too thin to find much. Returns a summary line or ''. */
export function coverageWarning(boardCount) {
  if (boardCount >= MIN_COVERAGE_BOARDS) return '';
  const msg = `WARNING: coverage low: only ${boardCount} boards, need ${MIN_COVERAGE_BOARDS}+. Next steps: `
    + `(1) add careers_url seeds for big employers to discovery.seed_companies in config/profile.yml or data/seed-companies.tsv `
    + `(Workday/Oracle/iCIMS careers URLs work) and run node scripts/discover-companies.mjs; `
    + `(2) until then, rely on the HiringCafe and LinkedIn lanes for coverage (onboarding step 7/8).`;
  console.error(msg);
  return msg;
}

// ── Date helpers ─────────────────────────────────────────────────────

export function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

export function localDateStr(d) {
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d) : null;
}

export function localTimeStr(d) {
  return d ? new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d) : '--:--';
}

export function dateOnly(d) {
  return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
}

/**
 * Returns a predicate `(date) => boolean` that is true when `date` falls within
 * the last `days` calendar days (local TZ). days=1 means "today only".
 */
export function makeRecencyPredicate(days = 1) {
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);
  return (d) => {
    if (days === 1) return localDateStr(d) === todayLocal;
    if (!d) return false;
    return d >= cutoff;
  };
}

// Rolling N-hour window (precise "just posted" — for speed-to-lead).
export function makeHoursPredicate(hours) {
  const ov = windowOverride();
  if (ov) return (d) => d instanceof Date && !isNaN(d) && d.getTime() >= ov.start.getTime() && d.getTime() <= ov.end.getTime();
  const cutoff = Date.now() - hours * 3600 * 1000;
  return (d) => d instanceof Date && !isNaN(d) && d.getTime() >= cutoff;
}

/**
 * CAREER_FINDER_WINDOW_START / _END (ISO): pin the rolling-hours window to a fixed interval. Set only by
 * discovery-audit --live so a rerun measures the truth window, not "the last H hours from when I started".
 */
export function windowOverride() {
  const s = process.env.CAREER_FINDER_WINDOW_START, e = process.env.CAREER_FINDER_WINDOW_END;
  if (!s || !e) return null;
  const start = new Date(s), end = new Date(e);
  return isNaN(start) || isNaN(end) ? null : { start, end };
}

// ── API detection ───────────────────────────────────────────────────

export function detectApi(company) {
  if (company.api) {
    // Enterprise families (added 2026-10-04). Checked first: their hosts never collide with the
    // startup families below, and the stored ats_api_url is re-run through the same URL detector.
    const ent = detectEnterprise(company.api);
    if (ent) return ent;
    if (company.api.includes('greenhouse')) return { type: 'greenhouse', url: company.api };
    if (company.api.includes('ashbyhq')) return { type: 'ashby', url: company.api };
    if (company.api.includes('api.lever.co')) return { type: 'lever', url: company.api };
    if (company.api.includes('smartrecruiters')) {
      // `_slug` was the ONLY family missing it (workable/bamboohr/rippling/recruitee/workday all
      // extract one). parseSmartRecruiters needs it to build the human apply URL
      // https://jobs.smartrecruiters.com/{slug}/{id}; without it the parser fell back to `j.ref`,
      // which is the API endpoint. Result: rows landed in scored-jobs.tsv carrying
      // `https://api.smartrecruiters.com/v1/companies/...` as the "apply" link — unopenable by a
      // human, and useless in a report or an outreach draft. Found 2026-08-06 via the LinkedIn
      // crawl surfacing two fresh Freshworks roles; 2 rows had already leaked.
      const m = company.api.match(/\/v1\/companies\/([^/?#]+)/);
      return { type: 'smartrecruiters', url: company.api, _slug: m?.[1] };
    }
    if (company.api.includes('bamboohr')) {
      const m = company.api.match(/\/\/([^.]+)\.bamboohr\.com/);
      return { type: 'bamboohr', url: company.api, _slug: m?.[1] };
    }
    if (company.api.includes('teamtailor')) return { type: 'teamtailor', url: company.api };
    if (company.api.includes('myworkdayjobs') || company.api.includes('myworkdaysite') || company.api.includes('/wday/cxs/')) {
      return { type: 'workday', url: company.api, _wd: parseWorkdayApiUrl(company.api) };
    }
    if (company.api.includes('apply.workable.com')) {
      const m = company.api.match(/\/accounts\/([^/?#]+)/);
      return { type: 'workable', url: company.api, _slug: m?.[1] };
    }
    if (company.api.includes('api.rippling.com')) {
      const m = company.api.match(/board\/([^/?#]+)/);
      return { type: 'rippling', url: company.api, _slug: m?.[1] };
    }
    if (company.api.includes('.recruitee.com')) {
      const m = company.api.match(/\/\/([^.]+)\.recruitee\.com/);
      return { type: 'recruitee', url: company.api, _slug: m?.[1] };
    }
  }

  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true` };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }

  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs` };
  }
  const ghMatch = url.match(/boards\.greenhouse\.io\/([^/?#]+)/);
  if (ghMatch && !company.api) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs` };
  }

  const wdMatch = url.match(/\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (wdMatch) {
    const [, tenant, shard, site] = wdMatch;
    return { type: 'workday', url: `https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, _wd: { tenant, shard, site, kind: 'jobs' } };
  }

  const wsMatch = url.match(/\/\/([^./]+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([^/?#]+)\/([^/?#]+)/);
  if (wsMatch) {
    const [, shard, tenant, site] = wsMatch;
    return { type: 'workday', url: `https://${shard}.myworkdaysite.com/wday/cxs/${tenant}/${site}/jobs`, _wd: { tenant, shard, site, kind: 'site' } };
  }

  const bhMatch = url.match(/\/\/([^.]+)\.bamboohr\.com/);
  if (bhMatch) {
    return { type: 'bamboohr', url: `https://${bhMatch[1]}.bamboohr.com/careers/list`, _slug: bhMatch[1] };
  }

  // Captures the whole host, not just the first label: some boards route through a region
  // infix (e.g. zignallabs.na.teamtailor.com) and the bare slug.teamtailor.com 404s for those —
  // a slug-only capture built a dead RSS URL. Found 2026-08-12 during company-index discovery.
  const ttMatch = url.match(/\/\/([^/?#]+\.teamtailor\.com)/);
  if (ttMatch) {
    return { type: 'teamtailor', url: `https://${ttMatch[1]}/jobs.rss` };
  }

  const srMatch = url.match(/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/);
  if (srMatch) {
    return { type: 'smartrecruiters', url: `https://api.smartrecruiters.com/v1/companies/${srMatch[1]}/postings?limit=100`, _slug: srMatch[1] };
  }

  const wkAppMatch = url.match(/apply\.workable\.com\/([^/?#]+)/);
  const wkSubMatch = url.match(/\/\/([^.]+)\.workable\.com/);
  const wkSlug = wkAppMatch?.[1] || wkSubMatch?.[1];
  if (wkSlug) {
    return { type: 'workable', url: `https://apply.workable.com/api/v1/widget/accounts/${wkSlug}?details=true`, _slug: wkSlug };
  }

  const ripMatch = url.match(/ats\.rippling\.com\/([^/?#]+)/) || url.match(/api\.rippling\.com\/platform\/api\/ats\/v1\/board\/([^/?#]+)/);
  if (ripMatch) {
    return { type: 'rippling', url: `https://api.rippling.com/platform/api/ats/v1/board/${ripMatch[1]}/jobs`, _slug: ripMatch[1] };
  }

  const rcMatch = url.match(/\/\/([^.]+)\.recruitee\.com/);
  if (rcMatch) {
    return { type: 'recruitee', url: `https://${rcMatch[1]}.recruitee.com/api/offers/`, _slug: rcMatch[1] };
  }

  return detectEnterprise(url);
}

/**
 * Enterprise ATS families: iCIMS, Oracle Recruiting Cloud (HCM), Taleo Enterprise.
 * Each returns {type, url, board} where `board` is the stable board id
 * (iCIMS host, Oracle host+siteNumber, Taleo host+careersection). Oracle needs the
 * siteNumber (CX_1, CX_1001, ...) — a bare *.oraclecloud.com host is NOT resolvable
 * here; probeCareersUrl() in probe-ats-core.mjs reads it off the careers page.
 * SuccessFactors / Jobvite / Paycor stay detect-only (see UNSUPPORTED_FAMILIES).
 */
export function detectEnterprise(url) {
  url = String(url || '');
  let m;
  // iCIMS: careers-{co}.icims.com, {co}.icims.com, uscareers-{co}.icims.com. Never the cdn/www hosts.
  if ((m = url.match(/\/\/([a-z0-9-]+\.icims\.com)/i)) && !/^(www|cdn\d*|images|login|api)\./i.test(m[1])) {
    const host = m[1].toLowerCase();
    return { type: 'icims', url: `https://${host}/jobs/search?ss=1&in_iframe=1`, board: host, _host: host };
  }
  // Oracle HCM: {pod}.fa.{dc}.oraclecloud.com — siteNumber from /sites/{CX_n}/ or siteNumber=CX_n.
  if ((m = url.match(/\/\/([a-z0-9.-]+\.oraclecloud\.com)/i))) {
    const host = m[1].toLowerCase();
    const site = (url.match(/\/sites\/([A-Za-z0-9_]+)/) || url.match(/siteNumber=([A-Za-z0-9_]+)/) || [])[1];
    if (!site) return null;
    return {
      type: 'oracle', board: `${host}/${site}`, _host: host, _site: site,
      url: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},limit=${ORACLE_PAGE},offset=0,sortBy=POSTING_DATES_DESC`,
    };
  }
  // Taleo Enterprise: {co}.taleo.net/careersection/{section}/... (TBE "*.tbe.taleo.net" is a different product).
  if ((m = url.match(/\/\/([a-z0-9-]+\.taleo\.net)\/careersection\/([^/?#]+)/i)) && !/\.tbe\./i.test(m[1])) {
    const host = m[1].toLowerCase(); const section = m[2];
    if (/^(rest|theme|\d{4}PRD.*)$/i.test(section)) return null;
    return { type: 'taleo', url: `https://${host}/careersection/${section}/jobsearch.ftl?lang=en`, board: `${host}/${section}`, _host: host, _section: section };
  }
  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

// `department` / `team` are the employer's OWN filing of the reporting line, published
// verbatim and for free. They are what the contact-discovery org graph addresses a
// hiring manager with, so carry them onto every parsed job rather than dropping them.
function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.absolute_url || '', company: companyName,
    // first_published is the creation date; updated_at moves on every edit, so it is NEVER used as a
    // posting date. A row with only updated_at is tagged dateSource 'updated_at' and kept out of the 24h view.
    location: j.location?.name || '', postedAt: toDate(j.first_published), updatedAt: toDate(j.updated_at),
    dateSource: j.first_published ? 'first_published' : (j.updated_at ? 'updated_at' : null),
    department: j.departments?.[0]?.name || '', team: j.departments?.[1]?.name || j.departments?.[0]?.name || '',
    offices: (j.offices || []).map(o => o.name).filter(Boolean),
  }));
}
function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '', url: j.jobUrl || '', company: companyName,
    location: j.location || '', postedAt: toDate(j.publishedAt), updatedAt: toDate(j.updatedAt || j.publishedAt),
    department: j.department || '', team: j.team || '',
    offices: [j.location, ...(j.secondaryLocations || []).map(l => l?.location || l)].filter(Boolean),
  }));
}
function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '', url: j.hostedUrl || '', company: companyName,
    location: j.categories?.location || '', postedAt: toDate(j.createdAt), updatedAt: toDate(j.updatedAt || j.createdAt),
    department: j.categories?.department || '', team: j.categories?.team || '',
    offices: [j.categories?.location].filter(Boolean),
  }));
}
function parseWorkdayPostedOn(s) {
  if (!s) return null;
  const low = s.toLowerCase(); const now = Date.now();
  if (low.includes('today')) return new Date(now);
  if (low.includes('yesterday')) return new Date(now - 86_400_000);
  const m = low.match(/(\d+)\+?\s*day/);
  if (m) return new Date(now - parseInt(m[1], 10) * 86_400_000);
  return null;
}
/** Numeric req id and its letter prefix from a Workday path: ".../Title_JR1998500-1" -> {prefix:'JR', num:1998500, suffix:1}. */
export function workdayReqId(externalPath = '') {
  const m = String(externalPath).match(/_((?:[A-Za-z]+)?[-_]?)(\d{4,})(?:-(\d+))?(?:[/?#]|$)/);
  return m ? { prefix: m[1].replace(/[-_]/g, '').toUpperCase(), num: Number(m[2]), suffix: m[3] ? Number(m[3]) : 0 } : null;
}
const slugNorm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Likely-repost flags from data already in the list response (no extra requests):
 *   req-suffix      path ends "_JR123-1": Workday appends -N when a req is reposted/copied
 *   slug-mismatch   the URL slug no longer matches the title (title edited after the req was created)
 *   jr-distance     a "fresh" row whose req number sits far below the tenant's fresh-row median
 *                   (a months-old requisition re-listed today)
 */
export function flagWorkdayReposts(rows) {
  const ids = rows.map((r) => workdayReqId(r.externalPath));
  const fresh = new Map();   // prefix -> [num] for rows posted today/yesterday
  rows.forEach((r, i) => { const a = workdayAgeDays(r.postedOn); if (ids[i] && a != null && a <= 1) { if (!fresh.has(ids[i].prefix)) fresh.set(ids[i].prefix, []); fresh.get(ids[i].prefix).push(ids[i].num); } });
  const median = new Map();
  for (const [k, v] of fresh) if (v.length >= 5) { v.sort((x, y) => x - y); median.set(k, v[Math.floor(v.length / 2)]); }
  return rows.map((r, i) => {
    const flags = []; const id = ids[i];
    if (id?.suffix) flags.push('req-suffix');
    const slug = String(r.externalPath || '').split('/').pop().replace(/_(?:[A-Za-z]+)?[-_]?\d{4,}(?:-\d+)?$/, '');
    if (slug && r.title && slugNorm(slug) !== slugNorm(r.title)) flags.push('slug-mismatch');
    const a = workdayAgeDays(r.postedOn);
    const med = id && median.get(id.prefix);
    if (med && a != null && a <= 1 && med - id.num > Math.max(5000, med * 0.05)) flags.push('jr-distance');
    return flags;
  });
}

/** Workday API URL -> { tenant, shard, site, kind }. kind 'jobs' = {tenant}.{shard}.myworkdayjobs.com; 'site' = {shard}.myworkdaysite.com (/recruiting/{tenant}/{site}). */
export function parseWorkdayApiUrl(apiUrl) {
  let m = String(apiUrl).match(/\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com\/wday\/cxs\/[^/]+\/([^/?#]+)/);
  if (m) return { tenant: m[1], shard: m[2], site: m[3], kind: 'jobs' };
  m = String(apiUrl).match(/\/\/([^./]+)\.myworkdaysite\.com\/wday\/cxs\/([^/]+)\/([^/?#]+)/);
  if (m) return { tenant: m[2], shard: m[1], site: m[3], kind: 'site' };
  return null;
}
/** Base for a posting's apply URL (externalPath is appended). */
export function workdayApplyBase(wd) {
  return wd.kind === 'site'
    ? `https://${wd.shard}.myworkdaysite.com/en-US/recruiting/${wd.tenant}/${wd.site}`
    : `https://${wd.tenant}.${wd.shard}.myworkdayjobs.com/en-US/${wd.site}`;
}

function parseWorkday(json, companyName, api) {
  const host = api._wd ? workdayApplyBase(api._wd) : '';
  const rows = json.jobPostings || [];
  const flags = flagWorkdayReposts(rows);
  return rows.map((j, i) => {
    if (flags[i].length) scanStats.workdayReposts++;
    return {
      title: j.title || '', url: j.externalPath ? (host + j.externalPath) : '', company: companyName,
      location: WORKDAY_LOC_PLACEHOLDER.test(j.locationsText || '') ? WORKDAY_LOC_UNRESOLVED : (j.locationsText || ''), postedAt: parseWorkdayPostedOn(j.postedOn), updatedAt: parseWorkdayPostedOn(j.postedOn),
      repostFlags: flags[i],
    };
  });
}
function parseBambooHR(json, companyName, api) {
  const slug = api._slug;
  return (json.result || []).map(j => {
    const loc = j.location || {}; const bits = [loc.city, loc.state, loc.country].filter(Boolean);
    if (j.isRemote === true || j.locationType === '1') bits.push('Remote');
    // NOTE: /careers/list publishes no posting date (datePosted is absent) -> postedAt null.
    return { title: j.jobOpeningName || '', url: j.jobOpeningShareUrl || `https://${slug}.bamboohr.com/careers/${j.id}/detail`,
      company: companyName, location: bits.join(', '), postedAt: toDate(j.datePosted), updatedAt: toDate(j.datePosted) };
  });
}
function parseTeamtailorRss(xml, companyName) {
  const out = []; const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const pick = (tag) => { const m = it.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };
    // The feed DOES carry locations (<tt:location><tt:name>) and <remoteStatus>; the parser used to
    // hard-code location '' (found 2026-10-04: swishanalytics 0/14 located).
    const locs = [...it.matchAll(/<tt:location>[\s\S]*?<\/tt:location>/g)].map(m => {
      const g = (t) => (m[0].match(new RegExp(`<tt:${t}>([^<]*)</tt:${t}>`)) || [])[1] || '';
      return (g('name') || [g('city'), g('country')].filter(Boolean).join(', ')).replace(/&amp;/g, '&').trim();
    }).filter(Boolean);
    if (/^fully$/i.test(pick('remoteStatus')) && !locs.some(l => /remote/i.test(l))) locs.push('Remote');
    out.push({ title: pick('title'), url: pick('link'), company: companyName, location: [...new Set(locs)].join('; '), postedAt: toDate(pick('pubDate')), updatedAt: toDate(pick('pubDate')) });
  }
  return out;
}
function parseSmartRecruiters(json, companyName, api) {
  const slug = api._slug;
  return (json.content || []).map(j => {
    const loc = j.location || {}; const bits = [loc.city, loc.region, loc.country].filter(Boolean);
    return { title: j.name || '', url: slug && j.id ? `https://jobs.smartrecruiters.com/${slug}/${j.id}` : (j.ref || ''),
      company: companyName, location: bits.join(', '), postedAt: toDate(j.releasedDate || j.createdOn), updatedAt: toDate(j.releasedDate || j.createdOn) };
  });
}
function parseWorkable(json, companyName, api) {
  const slug = api._slug;
  return (json.jobs || []).map(j => {
    // The widget API has NO `location` object: it carries flat city/state/country, a `locations[]`
    // array and a top-level `telecommuting`. Reading `j.location` left every Workable location
    // empty (found 2026-10-04, huggingface: 8/8 blank). `j.location` kept as a fallback.
    const one = (l) => [l.city, l.region || l.state, l.country].filter(Boolean).join(', ');
    const list = (j.locations || []).map(one).filter(Boolean);
    const flat = one({ city: j.city, state: j.state, country: j.country }) || (j.location ? one(j.location) : '');
    const bits = list.length ? [...new Set(list)] : (flat ? [flat] : []);
    if (j.telecommuting || j.location?.telecommuting) bits.push('Remote');
    return { title: j.title || j.full_title || '', url: slug && j.shortcode ? `https://apply.workable.com/${slug}/j/${j.shortcode}/` : (j.application_url || j.url || ''),
      company: companyName, location: bits.join('; '), postedAt: toDate(j.published_on || j.created_at), updatedAt: toDate(j.published_on || j.created_at) };
  });
}
function parseRecruitee(json, companyName) {
  return (json.offers || []).map(j => {
    const bits = [j.city, j.country].filter(Boolean); if (j.remote) bits.push('Remote');
    return { title: j.title || '', url: j.careers_url || '', company: companyName, location: j.location || bits.join(', '),
      postedAt: toDate(j.published_at || j.created_at), updatedAt: toDate(j.updated_at || j.published_at || j.created_at) };
  });
}

/**
 * Rippling's public ATS board. Discovered 2026-07-29 while chasing a
 * role that no sweep could see: Rippling is not on Greenhouse/Ashby/Lever,
 * so it was structurally invisible.
 *
 * Two quirks that matter:
 *  1. ONE ENTRY PER LOCATION PER REQ. A single req open in Chicago, Seattle and Remote
 *     appears three times sharing one uuid and url. Emitting all three would triple-
 *     count and let the "Remote (United States)" copy of a real onsite role trip the
 *     no-remote filter (or, worse, pass the location filter on the onsite copy and then
 *     be applied to as remote). So rows are collapsed by uuid and the locations are
 *     joined — the location filter then sees "Chicago, IL; Remote (United
 *     States)" and the existing remote-in-a-multi-city-string handling applies.
 *  2. NO PUBLISH DATE. The board exposes no created/published field at all, so
 *     postedAt is null. makeHoursPredicate rejects undated jobs, which means Rippling
 *     roles will NOT enter the fresh-window sweep on their own — that is deliberate
 *     and honest: we cannot claim a freshness we cannot read. They surface via
 *     probe/discovery and get scored with an explicit "freshness unverified" note.
 */
function parseRippling(json, companyName) {
  const byReq = new Map();
  for (const j of Array.isArray(json) ? json : (json.jobs || [])) {
    const id = j.uuid || j.url || j.name;
    if (!id) continue;
    const loc = (j.workLocation && (j.workLocation.label || j.workLocation.city)) || '';
    if (!byReq.has(id)) {
      byReq.set(id, { title: (j.name || '').trim(), url: j.url || '', company: companyName, locs: new Set(), postedAt: null, updatedAt: null });
    }
    if (loc) byReq.get(id).locs.add(loc);
  }
  return [...byReq.values()].map(({ locs, ...r }) => ({ ...r, location: [...locs].join('; ') }));
}

// ── Enterprise parsers (iCIMS / Oracle / Taleo) ─────────────────────
// fetchProvider returns RAW pages for these ({pages:[html|json,...]}) so the parsers stay pure and
// can be fed saved fixtures by scripts/test-ats-families.mjs.

export function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim();
}

/** iCIMS "jobs/search?in_iframe=1" HTML. Handles the card layout (iCIMS_JobCardItem) and the older
 *  row layout (iCIMS_JobListingRow); a job = an iCIMS_Anchor to /jobs/{id}/.../job. */
export function parseIcimsHtml(html, companyName, api = {}) {
  const out = []; const seen = new Set();
  const chunks = String(html).split(/<(?:li|div|tr)[^>]*class="[^"]*iCIMS_(?:JobCardItem|JobListingRow)[^"]*"/i).slice(1);
  const list = chunks.length ? chunks : String(html).split(/(?=<a[^>]+\/jobs\/\d+\/[^"]*\/job)/i).slice(1);
  for (const c of list) {
    const a = c.match(/<a[^>]+href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a || seen.has(a[2])) continue; seen.add(a[2]);
    const url = decodeEntities(a[1]).replace(/[?&]in_iframe=1/, '').replace(/\?$/, '');
    const titleAttr = (a[0].match(/title="\d+\s*-\s*([^"]+)"/) || [])[1];
    const h = a[3].match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i);
    const title = decodeEntities(titleAttr || (h ? h[1] : a[3])).replace(/^Title\s+/, '');
    // Location: a dt/span labelled "Job Location"/"Location" followed by the value.
    const lm = c.match(/(?:Job\s+)?Locations?<\/span>\s*(?:<\/dt>\s*<dd[^>]*>)?\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    const location = lm ? decodeEntities(lm[1]) : '';
    const dm = c.match(/Posted Date<\/span>\s*<span[^>]*title="([^"]+)"/i);
    const postedAt = dm ? toDate(dm[1]) : null;
    out.push({ title, url, company: companyName, location, postedAt, updatedAt: postedAt });
  }
  return out;
}
function parseIcims(payload, companyName, api) {
  const pages = payload?.pages || [payload];
  const seen = new Set(); const out = [];
  for (const p of pages) for (const j of parseIcimsHtml(p, companyName, api)) {
    if (seen.has(j.url)) continue; seen.add(j.url); out.push(j);
  }
  return out;
}
/** "Page 1 of 35" -> 35 (iCIMS paginator). */
export function icimsPageCount(html) {
  const m = String(html).match(/Page\s+\d+\s+of\s+(\d+)/i);
  return m ? Number(m[1]) : 1;
}

/** Oracle Recruiting Cloud REST: items[0].requisitionList[]. */
function parseOracle(payload, companyName, api) {
  const pages = payload?.pages || [payload];
  const seen = new Set(); const out = [];
  for (const p of pages) for (const r of (p?.items?.[0]?.requisitionList || [])) {
    if (!r.Id || seen.has(r.Id)) continue; seen.add(r.Id);
    const locs = [r.PrimaryLocation, ...(r.secondaryLocations || []).map(l => l?.Name)].filter(Boolean);
    if (/remote/i.test(r.WorkplaceType || r.WorkplaceTypeCode || '') && !locs.some(l => /remote/i.test(l))) locs.push('Remote');
    out.push({
      title: r.Title || '', company: companyName,
      url: `https://${api._host}/hcmUI/CandidateExperience/en/sites/${api._site}/job/${r.Id}`,
      location: [...new Set(locs)].join('; '), postedAt: toDate(r.PostedDate), updatedAt: toDate(r.PostedDate),
      department: r.JobFamily || '', team: r.JobFunction || '',
    });
  }
  return out;
}

/** Taleo Enterprise FTL: the req list is serialised in a "!|!"-delimited stream, in the first page's
 *  `initialHistory` hidden input and in every jobsearch.ajax page response. Each req is
 *  `{id}!|!{title}!|!{id}!|!{title}!|!{id}!|!{jobNo}!|!{location}!|!`. No posted date in the list. */
export function parseTaleoStream(text) {
  const s = String(text).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // Record head: id,title,id,title,id, then the id may repeat (tgh.taleo.net repeats it twice more)
  // before jobNo and location. Column order differs per section, so tolerate the repeats.
  const re = /!\|!(\d{3,})!\|!([^!]*)!\|!\1!\|!\2!\|!\1!\|!(?:\1!\|!)*([^!]*)!\|!([^!]*)!\|!/g;
  const dec = (x) => { try { return decodeURIComponent(x.replace(/%5C/gi, '')); } catch { return x; } };
  const hits = []; let m;
  while ((m = re.exec(s))) hits.push({ m, end: re.lastIndex });
  return hits.map(({ m, end }, i) => {
    const tail = s.slice(end, i + 1 < hits.length ? hits[i + 1].m.index : end + 2000);
    const dm = dec(tail.replace(/\+/g, ' ')).match(/\b([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\b/);
    const t = dm ? Date.parse(dm[1].replace('.', '')) : NaN;
    return { id: m[1], title: dec(m[2]).replace(/\\/g, ''), jobNo: dec(m[3]), location: dec(m[4]),
      postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
  });
}
export function taleoTotal(text) {
  const m = String(text).match(/listRequisition\.nbElements!\|!(\d+)/);
  return m ? Number(m[1]) : null;
}
function parseTaleo(payload, companyName, api) {
  const pages = payload?.pages || [payload];
  const seen = new Set(); const out = [];
  for (const p of pages) for (const r of parseTaleoStream(p)) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    out.push({ title: r.title, company: companyName, location: r.location, postedAt: r.postedAt, updatedAt: null,
      url: `https://${api._host}/careersection/${api._section}/jobdetail.ftl?job=${encodeURIComponent(r.jobNo || r.id)}&lang=en` });
  }
  return out;
}

export const PARSERS = {
  greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever, workday: parseWorkday,
  bamboohr: parseBambooHR, teamtailor: parseTeamtailorRss, smartrecruiters: parseSmartRecruiters,
  workable: parseWorkable, recruitee: parseRecruitee, rippling: parseRippling,
  icims: parseIcims, oracle: parseOracle, taleo: parseTaleo,
};
/** Every family scan-core can fetch AND parse. Families outside this list are detect-only. */
export const SUPPORTED_FAMILIES = Object.keys(PARSERS);
export const XML_PROVIDERS = new Set(['teamtailor']);
export const POST_PROVIDERS = new Set(['workday']);
export const PAGED_PROVIDERS = new Set(['workday', 'smartrecruiters', 'icims', 'oracle', 'taleo']);

// ── Fetch ────────────────────────────────────────────────────────────

export async function fetchJson(url, { method = 'GET', body, expect = 'json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const init = { signal: controller.signal, method, headers: { 'User-Agent': 'Mozilla/5.0 career-finder-scan' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.headers['Accept'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, init); }
    catch (e) { recordRequest(url, { status: e?.name === 'AbortError' ? 'timeout' : 'error' }); throw e; }
    recordRequest(url, { status: res.status });
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; err.retryAfterMs = retryAfterMs(res.headers?.get?.('retry-after')); throw err; }
    return expect === 'text' ? await res.text() : await res.json();
  } finally { clearTimeout(timer); }
}

// ── 429 backoff ──────────────────────────────────────────────────────
// Weekday audit 2026-10-06: 1,124-1,592 of ~2,700-3,100 Workday requests per role were HTTP 429.
// Every paged family now retries 429/503 with exponential backoff + jitter instead of swallowing the
// page as "empty". `net.sleep` is injectable so tests do not wait.
export const net = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
export const BACKOFF_BASE_MS = Number(process.env.CAREER_FINDER_BACKOFF_MS || 1000);
export const BACKOFF_RETRIES = Number(process.env.CAREER_FINDER_BACKOFF_RETRIES || 4);
/** Run counters the scan summary prints (reset by nothing: one process = one run). */
export const scanStats = { backoff429: 0, backoffGaveUp: 0, workdayTenants: 0, workdayEarlyStop: 0, workdayPageCap: [], workdayDetailCapped: [], workdayDetailFetched: 0, workdayReposts: 0 };

/** Retry-After (seconds or HTTP date) -> ms, capped at 60s; null when absent/unparseable. */
export function retryAfterMs(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : null;
}
/** Per-host timeout counts; a host past HOST_TIMEOUT_LIMIT is skipped for the rest of the run. */
export const hostTimeouts = new Map();
export const HOST_TIMEOUT_LIMIT = Number(process.env.CAREER_FINDER_HOST_TIMEOUT_LIMIT || 5);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

export async function fetchJsonBackoff(url, opts = {}, { retries = BACKOFF_RETRIES, baseMs = BACKOFF_BASE_MS } = {}) {
  const host = hostOf(url);
  for (let attempt = 0; ; attempt++) {
    if (host && (hostTimeouts.get(host) || 0) >= HOST_TIMEOUT_LIMIT) { const e = new Error(`host ${host} skipped after ${HOST_TIMEOUT_LIMIT} timeouts`); e.status = 'skipped'; throw e; }
    try { return await fetchJson(url, opts); }
    catch (e) {
      if (e?.name === 'AbortError' && host) hostTimeouts.set(host, (hostTimeouts.get(host) || 0) + 1);
      const retryable = e?.status === 429 || e?.status === 503;
      if (!retryable) throw e;
      if (attempt >= retries) { scanStats.backoffGaveUp++; throw e; }
      scanStats.backoff429++;
      await net.sleep(e.retryAfterMs ?? (baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs / 2)));
    }
  }
}

// Safety ceiling on jobs pulled from ONE paged board (Workday/iCIMS/Oracle/Taleo). Not a page
// cap: the old Workday MAX_PAGES=10 silently truncated every board to 200 (and before that 40).
// 10,000 covers the largest public boards seen (NVIDIA ~2,000, JPMC Oracle ~7,350).
export const ATS_MAX_JOBS = Number(process.env.CAREER_FINDER_ATS_MAX_JOBS || 10_000);
export const ORACLE_PAGE = 200;     // Oracle's REST honours limit=200 (verified JPMC 2026-10-04)
const PAGE_CONCURRENCY = 4;

async function inBatches(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

/** Age in whole days from Workday's "Posted Today / Yesterday / 3 Days Ago / 30+ Days Ago"; null = unknown. */
export function workdayAgeDays(postedOn) {
  const low = String(postedOn || '').toLowerCase();
  if (!low) return null;
  if (low.includes('today')) return 0;
  if (low.includes('yesterday')) return 1;
  const m = low.match(/(\d+)\+?\s*day/);
  return m ? parseInt(m[1], 10) : null;
}

export const WORKDAY_PAGE = 20;                 // Workday rejects limit > 20
export const WORKDAY_CONCURRENCY = Number(process.env.CAREER_FINDER_WD_CONCURRENCY || 2);   // per tenant
export const WORKDAY_MAX_PAGES = Number(process.env.CAREER_FINDER_WD_PAGES || 8);           // per tenant unless full
const WD_FULL = process.argv.includes('--full') || process.env.CAREER_FINDER_WD_FULL === '1';

/**
 * Workday sweep. Lists are usually newest-first (no sort is requested), so a window sweep pages until a page ENDS outside the window:
 *   - pages in groups of WORKDAY_CONCURRENCY (1-2 per tenant, not 4) with 429 backoff;
 *   - stops when a page's last dated row is older than the window (never older than "Posted Yesterday");
 *   - at most WORKDAY_MAX_PAGES pages unless `full` (or --full): when the cap bites with rows still
 *     fresh on the last page it is recorded in scanStats.workdayPageCap, never silent;
 *   - location/detail fetches run only for rows that pass `prefilter` (date + title), so a 2,000-row
 *     tenant no longer spends 150 detail requests on rows that were going to be dropped.
 * `full` fetches the whole board (old behaviour: plan from page 1's total, no early stop, no cap).
 */
export async function fetchWorkday(apiUrl, { maxJobs = ATS_MAX_JOBS, windowDays = scanWindowDays(), full = WD_FULL, maxPages = WORKDAY_MAX_PAGES, prefilter = null, label = '' } = {}) {
  const body = (offset) => ({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: '' });
  const page = (o) => fetchJsonBackoff(apiUrl, { method: 'POST', body: body(o) });
  const cutoff = Math.max(1, Number(windowDays) || 1);
  const isOld = (j) => { const a = workdayAgeDays(j.postedOn); return a != null && a > cutoff; };
  // Stop only when the LAST dated row of a page is outside the window: one pinned/evergreen old row
  // near the top must not hide fresh rows on later pages (no sort is sent, so order is not guaranteed).
  const lastIsOld = (rows) => { for (let i = rows.length - 1; i >= 0; i--) if (workdayAgeDays(rows[i].postedOn) != null) return isOld(rows[i]); return false; };
  scanStats.workdayTenants++;
  const first = await page(0);
  const all = [...(first.jobPostings || [])];
  // Workday reports the real `total` ONLY on the first page and returns 0 on every page after
  // it (reproduced against Salesforce: offset 0 -> total 1427, offset 20 -> 0, offset 40 -> 0).
  // So the page plan is computed once from page 1 and every page is fetched — no page cap.
  let total = all.length; const data = first;
  if (data.total) total = data.total;   // literal guarded by test-hiringcafe.mjs §17
  total = Math.min(total, maxJobs);
  const offsets = [];
  if (all.length >= WORKDAY_PAGE) for (let o = WORKDAY_PAGE; o < total; o += WORKDAY_PAGE) offsets.push(o);
  let pages = 1, stopped = false, capHit = false, failed = 0, lastPage = all;
  if (!full && lastIsOld(all)) { stopped = true; }
  else {
    for (let i = 0; i < offsets.length && !stopped; i += WORKDAY_CONCURRENCY) {
      const room = full ? Infinity : maxPages - pages;
      if (room <= 0) { capHit = !lastIsOld(lastPage); break; }
      const group = offsets.slice(i, i + Math.min(WORKDAY_CONCURRENCY, room));
      const got = await Promise.all(group.map(async (o) => { try { return (await page(o)).jobPostings || []; } catch { failed++; return []; } }));
      pages += group.length;
      for (const g of got) { all.push(...g); if (g.length) lastPage = g; }
      if (!full && lastIsOld(lastPage)) stopped = true;
    }
  }
  if (stopped) scanStats.workdayEarlyStop++;
  if (capHit) scanStats.workdayPageCap.push(label || apiUrl.replace(/^https:\/\//, '').split('/')[0]);
  await resolveWorkdayLocations(apiUrl, all, { only: prefilter, label });
  const out = { jobPostings: all, total: first.total || all.length, pages, earlyStopped: stopped, pageCapHit: capHit };
  if (failed || capHit) { out.partial = true; out.expected = total; }
  return out;
}

// Workday lists a multi-site req as locationsText "3 Locations" — a placeholder that classifies
// as unknown and so FAILED the location gate for every multi-site req (a Bay Area site hidden
// behind "2 Locations" was dropped). Resolve it: bulletFields first (free, sometimes carries the
// site list), else the job detail endpoint (jobPostingInfo.location + additionalLocations), at
// bounded concurrency with a per-board cap. Unresolved = WORKDAY_LOC_UNRESOLVED, which the
// location filter passes through for the scorer to check against the ATS — never a reject on
// the placeholder itself.
export const WORKDAY_LOC_PLACEHOLDER = /^\s*\d+\s+locations?\s*$/i;
export const WORKDAY_LOC_UNRESOLVED = 'Multiple locations (unresolved)';
export const WORKDAY_DETAIL_CAP = Number(process.env.CAREER_FINDER_WD_DETAIL_CAP || 150);
const LOCATIONISH = /,\s*[A-Z]{2}\b|,\s*[A-Za-z .]+$|\bremote\b|united states|\bUSA?\b/i;
export async function resolveWorkdayLocations(apiUrl, postings, { concurrency = WORKDAY_CONCURRENCY, cap = WORKDAY_DETAIL_CAP, only = null, label = '' } = {}) {
  const placeholders = postings.filter((j) => WORKDAY_LOC_PLACEHOLDER.test(j.locationsText || ''));
  // Detail requests are for rows that already passed the date + title gate (`only`); the rest keep the
  // placeholder and fall through to WORKDAY_LOC_UNRESOLVED below without a request.
  const todo = only ? placeholders.filter((j) => { try { return only(j); } catch { return true; } }) : placeholders;
  if (!placeholders.length) return 0;
  const base = String(apiUrl).replace(/\/jobs\/?(\?.*)?$/, '');
  let resolved = 0;
  const needDetail = [];
  for (const j of todo) {
    const fromBullets = (j.bulletFields || []).filter((b) => typeof b === 'string' && LOCATIONISH.test(b) && !/^(R|JR|REQ)?[-_]?\d+$/i.test(b));
    if (fromBullets.length) { j.locationsText = fromBullets.join('; '); resolved++; }
    else needDetail.push(j);
  }
  if (needDetail.length > cap) scanStats.workdayDetailCapped.push(`${label || base.replace(/^https:\/\//, '').split('/')[0]} (${needDetail.length - cap} of ${needDetail.length} rows unresolved)`);
  await inBatches(needDetail.slice(0, cap), concurrency, async (j) => {
    if (!j.externalPath) return;
    try {
      scanStats.workdayDetailFetched++;
      const d = (await fetchJsonBackoff(base + j.externalPath))?.jobPostingInfo || {};
      const locs = [d.location, ...(d.additionalLocations || [])].map((x) => (typeof x === 'string' ? x : x?.descriptor || '')).filter(Boolean);
      if (locs.length) { j.locationsText = [...new Set(locs)].join('; '); resolved++; }
    } catch { /* leave for the unresolved marker */ }
  });
  for (const j of placeholders) if (WORKDAY_LOC_PLACEHOLDER.test(j.locationsText || '')) j.locationsText = WORKDAY_LOC_UNRESOLVED;
  return resolved;
}

// SmartRecruiters caps a page at 100 and the index URL asks for exactly one page, so every
// board with >100 postings was silently truncated to 100 (Western Digital, Sia in career-ops'
// index both read "100 jobs"). Page by offset up to totalFound.
export async function fetchSmartRecruiters(api, { maxJobs = ATS_MAX_JOBS } = {}) {
  const u = new URL(api.url); u.searchParams.set('limit', '100'); u.searchParams.set('offset', '0');
  const first = await fetchJson(u.toString());
  const content = [...(first.content || [])];
  const total = Math.min(first.totalFound || content.length, maxJobs);
  const offsets = []; for (let o = 100; o < total; o += 100) offsets.push(o);
  const rest = await inBatches(offsets, PAGE_CONCURRENCY, async (o) => {
    const v = new URL(u); v.searchParams.set('offset', String(o));
    try { return (await fetchJson(v.toString())).content || []; } catch { return []; }
  });
  for (const r of rest) content.push(...r);
  return { ...first, content };
}

export async function fetchIcims(api, { maxJobs = ATS_MAX_JOBS } = {}) {
  const base = `https://${api._host}/jobs/search?ss=1&in_iframe=1`;
  const first = await fetchJson(base, { expect: 'text' });
  const n = Math.min(icimsPageCount(first), Math.ceil(maxJobs / 20));
  const rest = await inBatches([...Array(Math.max(0, n - 1)).keys()].map(i => i + 1), PAGE_CONCURRENCY,
    async (pr) => { try { return await fetchJson(`${base}&pr=${pr}`, { expect: 'text' }); } catch { return ''; } });
  return { pages: [first, ...rest] };
}

/** Oracle Recruiting Cloud (HCM) CandidateExperience REST, newest first (sortBy=POSTING_DATES_DESC).
 *  `stopBefore` (a Date): stop paging once a page's last PostedDate is older than it, so a window
 *  sweep of a 7,000-req board is 1-2 pages. Without it the whole board is paged (old behaviour). */
export async function fetchOracle(api, { maxJobs = ATS_MAX_JOBS, stopBefore = null } = {}) {
  const url = (off) => api.url.replace(/offset=\d+/, `offset=${off}`);
  const first = await fetchJsonBackoff(url(0));
  const total = Math.min(first?.items?.[0]?.TotalJobsCount || 0, maxJobs);
  const pastWindow = (p) => {
    if (!stopBefore) return false;
    const list = p?.items?.[0]?.requisitionList || [];
    const last = list.length ? toDate(list[list.length - 1].PostedDate) : null;
    // PostedDate is a bare date (UTC midnight): the whole day is before the cutoff only if the day AFTER it is.
    return !!last && last.getTime() + 86_400_000 <= stopBefore.getTime();
  };
  const offsets = []; for (let o = ORACLE_PAGE; o < total; o += ORACLE_PAGE) offsets.push(o);
  const pages = [first]; let failed = 0, stopped = pastWindow(first);
  for (let i = 0; i < offsets.length && !stopped; i += WORKDAY_CONCURRENCY) {
    const group = offsets.slice(i, i + WORKDAY_CONCURRENCY);
    const got = await Promise.all(group.map(async (o) => { try { return await fetchJsonBackoff(url(o)); } catch { failed++; return null; } }));
    for (const g of got) if (g) pages.push(g);
    if (got.some((g) => g && pastWindow(g))) stopped = true;
  }
  return { pages, expected: total, partial: failed > 0, earlyStopped: stopped };
}

export async function fetchTaleo(api, { maxJobs = ATS_MAX_JOBS } = {}) {
  const firstHtml = await fetchJson(api.url, { expect: 'text' });
  // Paging is a stateless POST to jobsearch.ajax (no session/csrf needed — verified on aa224 2026-10-04).
  const ajax = `https://${api._host}/careersection/${api._section}/jobsearch.ajax`;
  const page = async (p) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({ ftlpageid: 'reqListBasicPage', ftlinterfaceid: 'requisitionListInterface', ftlcompid: 'rlPager',
        jsfCmdId: 'rlPager.pageNext', ftlcompclass: 'PagerComponent', ftlcallback: 'ftlPager_processResponse', ftlajaxid: 'ftlx1',
        'rlPager.currentPage': String(p), lang: 'en' });
      const res = await fetch(ajax, { method: 'POST', body, signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 career-finder-scan', 'Content-Type': 'application/x-www-form-urlencoded' } });
      recordRequest(ajax, { status: res.status });
      return res.ok ? await res.text() : '';
    } catch { return ''; } finally { clearTimeout(t); }
  };
  // Some sections (e.g. tgh.taleo.net/ex) lazy-load the list: the .ftl HTML has no stream and no
  // nbElements. Then ajax page 1 is the real first page and carries the total.
  let first = firstHtml;
  if (!parseTaleoStream(first).length || taleoTotal(first) == null) {
    const p1 = await page(1);
    if (parseTaleoStream(p1).length) first = p1;
  }
  const total = Math.min(taleoTotal(first) || 0, maxJobs);
  const per = parseTaleoStream(first).length || 25;
  const pages = [first];
  const nums = []; for (let p = 2; (p - 1) * per < total; p++) nums.push(p);
  const rest = await inBatches(nums, PAGE_CONCURRENCY, page);
  pages.push(...rest);
  const parsed = new Set(pages.flatMap(x => parseTaleoStream(x).map(r => r.id))).size;
  return { pages, expected: total, partial: parsed < total };
}

// Greenhouse serves `departments` (and the full JD body) ONLY with ?content=true.
// Without it the field is present but always empty — measured 2026-07-25: airtable
// 0/38 jobs carried departments plain vs 38/38 with the param, same on anthropic
// (0/418 vs 418/418) and affirm (0/174 vs 174/174). Greenhouse is ~34% of
// data/company-index.tsv, so the plain URL silently threw away the employer's own
// org taxonomy for a third of the index. Normalized here rather than only at the
// two URL-construction sites so board URLs supplied via a company's `api:` config
// get it too.
export function withGreenhouseContent(url) {
  if (!/boards-api\.greenhouse\.io/.test(url)) return url;
  if (/[?&]content=true\b/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'content=true';
}

/** `opts` carries the sweep window to the families that can stop early: { windowDays, windowStart, prefilter, full, label }. */
export async function fetchProvider(api, opts = {}) {
  if (POST_PROVIDERS.has(api.type)) return fetchWorkday(api.url, { ...(opts.windowDays != null ? { windowDays: opts.windowDays } : {}), ...(opts.full != null ? { full: opts.full } : {}), prefilter: opts.prefilter || null, label: opts.label || '' });
  if (api.type === 'icims') return fetchIcims(api);
  if (api.type === 'smartrecruiters') return fetchSmartRecruiters(api);
  if (api.type === 'oracle') return fetchOracle(api, { stopBefore: opts.full ? null : (opts.windowStart || null) });
  if (api.type === 'taleo') return fetchTaleo(api);
  if (XML_PROVIDERS.has(api.type)) return fetchJson(api.url, { expect: 'text' });
  if (api.type === 'greenhouse') return fetchJson(withGreenhouseContent(api.url));
  return fetchJson(api.url);
}

// ── Filters ──────────────────────────────────────────────────────────

/** Titles the title filter rejected this run (unique, capped) — printed with --explain. */
export const DROPPED_TITLE_SAMPLE = [];
const EXPLAIN = process.argv.includes('--explain');
let explainHooked = false;
function recordDrop(title) {
  const t = String(title || '').trim();
  if (t && DROPPED_TITLE_SAMPLE.length < 10 && !DROPPED_TITLE_SAMPLE.includes(t)) DROPPED_TITLE_SAMPLE.push(t);
}
/** Print the dropped-title sample (scan / scan-index --explain). Safe to call more than once. */
export function printDroppedTitleSample() {
  if (!EXPLAIN || printDroppedTitleSample.done) return;
  printDroppedTitleSample.done = true;
  console.log(`\nTitle-drop sample (${DROPPED_TITLE_SAMPLE.length}, --explain):`);
  for (const t of DROPPED_TITLE_SAMPLE) console.log(`  - ${t}`);
  if (!DROPPED_TITLE_SAMPLE.length) console.log('  (none dropped)');
}

export function buildTitleFilter(titleFilter, opts = {}) {
  const f = buildTitleFilterInner(titleFilter, opts);
  if (EXPLAIN && !explainHooked) { explainHooked = true; process.on('exit', printDroppedTitleSample); }
  return (title) => { const ok = f(title); if (!ok) recordDrop(title); return ok; };
}

function buildTitleFilterInner(titleFilter, { dropSeniorityNegatives = false } = {}) {
  // No portals.yml title_filter positives: fall back to config/profile.yml targets.
  if (!(titleFilter?.positive || []).length && hasTargets()) return (title) => titleMatches(title || '');
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  let negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  if (dropSeniorityNegatives) {
    const seniority = ['junior', 'intern', 'entry level', 'associate', 'apprentice'];
    negative = negative.filter(k => !seniority.includes(k));
  }
  return (title) => {
    const lower = (title || '').toLowerCase();
    const matchedPositives = positive.filter(k => lower.includes(k));
    // portals.yml positives are plain substrings; the profile's role vocabulary/synonyms (titleMatches)
    // is OR-ed in so shipping example positives never masks "Data Platform Software Engineer" style titles.
    const viaTargets = matchedPositives.length === 0 && hasTargets() && titleMatches(title || '');
    const hasPositive = positive.length === 0 || matchedPositives.length > 0 || viaTargets;
    if (!hasPositive) return false;
    // A negative is neutralized when it is a substring of a positive phrase the
    // title actually matched — e.g. positive "data engineering manager" covers
    // the "engineering manager" negative. Stops generic disqualifiers from killing the more
    // specific target titles that are explicitly on the positive list.
    const hasNegative = negative.some(k => lower.includes(k) && !matchedPositives.some(p => p.includes(k)));
    return !hasNegative;
  };
}

/**
 * Classify a location string: 'local' | 'remote' | 'elsewhere' | 'unknown'.
 * Delegates to targets.mjs, which reads the search area from config/profile.yml
 * (location.city / metro / cities[]).
 *
 * 'unknown' means the string names no place ("Hybrid", "Acme HQ"), so the caller can fall
 * back to another source (e.g. a job-board card's location) instead of silently discarding
 * a real local req. It must NEVER be treated as 'local' — unknown is a prompt to verify.
 */
export function classifyLocation(loc) {
  return targetsClassify(loc);
}

/**
 * Boolean location gate: local passes; remote passes per location.remote_policy;
 * elsewhere/unknown fail. `title` is optional and lets remote-country policy reject
 * titles that name a foreign region ("... - EMEA").
 */
export function buildLocationFilter() {
  const verdict = buildLocationVerdict();
  return (loc, title = '', offices = []) => verdict(loc, title, offices).ok;
}

/**
 * Same gate, with the reasoning: (loc, title, offices[]) -> { ok, flag, rule }.
 * `offices` are the extra places the parsers already expose (Ashby secondaryLocations, Greenhouse
 * offices[]); a posting passes when ANY of loc/offices is inside the configured area, and `flag`
 * (multi-location, also-remote, remote-in-metro, via-offices, remote-us) is what callers carry
 * on the candidate as `loc_flag` so a human can see why a non-obvious row passed.
 */
export function buildLocationVerdict() {
  // A Workday multi-site req whose sites could not be resolved is NOT filtered on the placeholder.
  return (loc, title = '', offices = []) => loc === WORKDAY_LOC_UNRESOLVED
    ? { ok: true, flag: 'workday-sites-unresolved', rule: 'unresolved Workday multi-site marker passes to the scorer' }
    : locationVerdict(loc, title, offices);
}

// ── First-seen registry (freshness for boards that expose no date) ───
//
// WHY (2026-08-20). Rippling's ATS returns no date field at all, so `publishedAt` parses to
// NaN, age computes as Infinity, and EVERY Rippling req fails the freshness gate forever.
// Genuine Rippling roles died that way — the lane was not making a judgement, it was failing to
// parse and reporting that as "stale".
//
// The fix is NOT to invent a publish date. It is to record the first moment WE observed a
// req and reason from that: a job id absent from the registry yesterday and present today
// appeared within the last cycle. That is an observation we can actually prove, and callers
// must label it as such (`date-basis: first-seen`) so nothing downstream mistakes it for an
// ATS-published timestamp. See project_ats_publishedat_is_bumpable — even real ATS dates get
// bumped, so an honest provenance label matters more than a confident number.
// Ledger columns: url_key  first_seen_iso  source  last_date. `source` = the lane that first saw the id
// (scan-index, ...); `last_date` = the ATS date last seen for it (a day for day-level families, an ISO
// timestamp otherwise), which is what makes a bumped date detectable ("re-promoted").
// Two-column files written by older versions load fine (source/last_date read as '').
export const FIRST_SEEN_PATH = process.env.CAREER_FINDER_FIRST_SEEN || 'data/_first-seen.tsv';
const FIRST_SEEN_HEADER = 'url_key\tfirst_seen_iso\tsource\tlast_date\n';
let _firstSeen = null;
let _pending = [];
function loadFirstSeen() {
  if (_firstSeen) return _firstSeen;
  _firstSeen = new Map();
  try {
    for (const line of readFileSync(FIRST_SEEN_PATH, 'utf-8').split('\n').slice(1)) {
      const [key, iso, source = '', last = ''] = line.split('\t');
      if (!key || !iso) continue;
      const prev = _firstSeen.get(key);
      // Later lines refresh last_date only; the earliest first_seen wins.
      _firstSeen.set(key, prev ? { ...prev, last_date: last || prev.last_date } : { first_seen: iso, source, last_date: last });
    }
  } catch { /* absent registry is normal on first run */ }
  return _firstSeen;
}
/** Test hook: drop the in-memory ledger so the next call re-reads FIRST_SEEN_PATH. */
export function _resetFirstSeen() { _firstSeen = null; _pending = []; }

/** Ledger entry for a job URL, or null. */
export function ledgerGet(url) {
  const key = dedupUrlKey(url);
  return key ? (loadFirstSeen().get(key) || null) : null;
}
/** Insert/refresh an entry in memory and queue the TSV line (written by ledgerFlush). */
export function ledgerPut(url, { now = new Date(), source = 'scan-index', lastDate = '' } = {}) {
  const key = dedupUrlKey(url);
  if (!key) return null;
  const m = loadFirstSeen();
  const prev = m.get(key);
  const entry = prev ? { ...prev, last_date: lastDate || prev.last_date } : { first_seen: now.toISOString(), source, last_date: lastDate };
  m.set(key, entry);
  _pending.push(`${key}\t${entry.first_seen}\t${entry.source}\t${entry.last_date}`);
  return entry;
}
/** Append queued ledger lines. Never throws: the ledger is an optimisation, not a reason to fail a scan. */
export function ledgerFlush() {
  if (!_pending.length) return 0;
  const n = _pending.length;
  try {
    const header = existsSync(FIRST_SEEN_PATH) ? '' : FIRST_SEEN_HEADER;
    appendFileSync(FIRST_SEEN_PATH, header + _pending.join('\n') + '\n');
  } catch { return 0; }
  _pending = [];
  return n;
}

/** Window start as a Date for scan-index's two window modes (rolling hours, or N local calendar days). */
export function windowStartFor({ hours = null, days = 1, now = new Date() } = {}) {
  const ov = hours && windowOverride();
  if (ov) return ov.start;
  if (hours) return new Date(now.getTime() - hours * 3600 * 1000);
  const c = new Date(now); c.setDate(c.getDate() - (days - 1)); c.setHours(0, 0, 0, 0); return c;
}

/**
 * Record (once) and return the ISO timestamp at which this URL was first observed.
 * Idempotent: the first call writes, every later call returns the stored value.
 */
export function firstSeenKnown(url) {
  const key = dedupUrlKey(url);
  return !!key && loadFirstSeen().has(key);
}
export function firstSeen(url, { now = new Date(), record = true } = {}) {
  const key = dedupUrlKey(url);
  if (!key) return null;
  const m = loadFirstSeen();
  if (m.has(key)) return m.get(key).first_seen;
  const iso = now.toISOString();
  m.set(key, { first_seen: iso, source: 'scan-index', last_date: '' });
  if (!record) return iso;
  try {
    const header = existsSync(FIRST_SEEN_PATH) ? '' : FIRST_SEEN_HEADER;
    appendFileSync(FIRST_SEEN_PATH, `${header}${key}\t${iso}\tscan-index\t\n`);
  } catch { /* registry is an optimisation; never break a scan over it */ }
  return iso;
}

// ── Dedup ────────────────────────────────────────────────────────────

// Key a URL for identity comparison. ATS boards are not consistent about the case of the
// company slug they hand back — SmartRecruiters served Freshworks posting 744000141976919 as
// /Freshworks/ from one endpoint and /freshworks/ from another, and the exact-string seen-set
// re-emitted an already-scored req as a fresh candidate on every 5-minute hot-tier sweep.
// Job ids themselves are numeric or lowercase UUIDs across every ATS family we parse, so two
// genuinely distinct postings never differ by case alone.
export function dedupUrlKey(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

export function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0]; if (url) seen.add(dedupUrlKey(url));
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) seen.add(dedupUrlKey(m[1]));
  }
  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(dedupUrlKey(m[0]));
  }
  // Dedup against the canonical triaged ledger too (col 7 = url). Without this, the rolling
  // 48h window would re-surface every already-scored role as a "new candidate" each sweep; the
  // scoring step would dedup them anyway, but suppressing here keeps the candidate file honest
  // and avoids handing the LLM scorer roles it already judged.
  if (existsSync(SCORED_JOBS_PATH)) {
    for (const line of readFileSync(SCORED_JOBS_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[6]; if (url) seen.add(dedupUrlKey(url));
    }
  }
  return seen;
}

// Statuses where the employer relationship for THIS role is settled or in flight. A repost is
// not a new opportunity in these cases, so the key never expires.
const ROLE_DEDUP_PERMANENT = /^(applied|responded|interview|offer|rejected)$/i;
// How long a merely-LOOKED-AT verdict suppresses the same employer+title. Beyond this, a new
// requisition gets a fresh look.
export const ROLE_DEDUP_DAYS = Number(process.env.CAREER_OPS_ROLE_DEDUP_DAYS || 30);

/**
 * Employer+title suppression for the index sweep.
 *
 * WHY THIS IS TIME-SCOPED (fixed 2026-08-20). The key is `company::role` and carried NO
 * requisition id and NO date, so a single past evaluation made that employer+title invisible
 * to the index lane FOREVER. An employer reposting the same title as a NEW requisition months later
 * would be discarded as a duplicate of the old evaluation — different req, silently dropped.
 *
 * The asymmetry rule from the role-matching guidance applies: a wrongly-suppressed req is an
 * invisible loss, a wrongly-surfaced one costs one cheap scoring pass. So bias to surfacing.
 * Exact-requisition dedup is unaffected — loadSeenUrls() still blocks the same URL outright,
 * which is the check that actually means "same req".
 */
export function loadSeenCompanyRoles({ days = ROLE_DEDUP_DAYS } = {}) {
  const seen = new Set();
  if (!existsSync(APPLICATIONS_PATH)) return seen;
  const cutoff = Date.now() - days * 864e5;
  for (const line of readFileSync(APPLICATIONS_PATH, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const f = line.split('|').map(x => x.trim());
    // | # | Date | Company | Role | Score | Status | ...  → f[1..6] after the leading empty cell
    const [, , date, company, role, , status] = f;
    if (!company || !role || company.toLowerCase() === 'company' || /^-+$/.test(company)) continue;
    const key = `${company.toLowerCase()}::${role.toLowerCase()}`;
    if (ROLE_DEDUP_PERMANENT.test(String(status || '').trim())) { seen.add(key); continue; }
    const t = Date.parse(date);
    // An unparseable date is treated as permanent: failing closed here only costs one
    // suppressed row, whereas failing open would re-surface the whole backlog at once.
    if (!Number.isFinite(t) || t >= cutoff) seen.add(key);
  }
  return seen;
}

// ── Parallel fetch with concurrency limit ───────────────────────────
//
// A task may carry a `.host` property (set it with `taskHost(url)`). When present, at most
// `perHost` requests run against that host at once. This is what lets the TOTAL limit rise
// safely: the index concentrates on three shared API hosts (measured 2026-08-19:
// api.ashbyhq.com 792 boards, boards-api.greenhouse.io 440, api.lever.co 105), so a plain
// limit of 24 could aim all 24 at Ashby — which has rate-limited this pipeline before
// (RATE-LIMIT-01, 2026-07-29: truncated JSON that read as empty boards). perHost 8 keeps
// per-host pressure BELOW the old worst case (limit 10, all on one host) while the pool
// works other hosts in parallel. Tasks without `.host` behave exactly as before.

export const taskHost = url => { try { return new URL(url).host; } catch { return ''; } };

export async function parallelFetch(tasks, limit = 10, { perHost = 8 } = {}) {
  const results = new Array(tasks.length);
  const queue = tasks.map((t, i) => ({ t, i }));
  const inFlight = new Map();               // host -> requests currently running
  async function worker() {
    while (queue.length) {
      const k = queue.findIndex(({ t }) => !t.host || (inFlight.get(t.host) || 0) < perHost);
      if (k === -1) { await new Promise(r => setTimeout(r, 25)); continue; }  // all remaining hosts saturated
      const { t, i } = queue.splice(k, 1)[0];
      if (t.host) inFlight.set(t.host, (inFlight.get(t.host) || 0) + 1);
      try { results[i] = await t(); }
      finally { if (t.host) inFlight.set(t.host, (inFlight.get(t.host) || 0) - 1); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Company names for scan-index --only: column 1 of a TSV or a plain list, lowercased. Line 1 is a
 * header ONLY when it carries a `company` token (any column, any case); a headerless TSV used to
 * lose its first company because any tab in line 1 was taken to mean "header".
 */
export function parseOnlyList(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (lines[0] && lines[0].split(/\t|,/).some((c) => /^\s*company\s*$/i.test(c))) lines.shift();
  return new Set(lines.map((l) => (l.split('\t')[0] || '').toLowerCase().trim()).filter(Boolean));
}
