#!/usr/bin/env node

/**
 * workable-search.mjs — cross-employer discovery via Workable's PUBLIC jobs search API.
 * Zero LLM, zero browser. Same cost class as scan.mjs and hiringcafe-scan.mjs.
 *
 * WHY THIS EXISTS. The ATS sweep (scan-index.mjs) can only find jobs at companies ALREADY in
 * data/company-index.tsv; it cannot discover an employer it has never heard of. This
 * endpoint is the one cross-employer search
 * surface confirmed to exist across the supported ATS families:
 *
 *   GET https://jobs.workable.com/api/v1/jobs?query=<title>&location=<city>
 *
 * Greenhouse, Ashby, Lever, SmartRecruiters and Rippling were all checked and publish NO
 * cross-board search or board directory (verified 2026-09-10), so they stay company-by-company.
 *
 * ROBOTS COMPLIANCE (checked 2026-09-10). jobs.workable.com/robots.txt disallows /search* and
 * /profile*; /api/v1/jobs carries no Disallow rule. Poll hourly at most. Do NOT "fix" a thin
 * day by tightening the cadence. Related findings recorded at the same time, respected elsewhere:
 * Ashby disallows /api/ (never probe their GraphQL), Wellfound robots-walls its job-filter query
 * params (do not scrape it), and Lever's robots.txt names ClaudeBot in its disallow list, so
 * Lever stays limited to its documented per-company postings API and is never crawled.
 *
 * WHAT IT IS NOT. Volume is modest and the match is FUZZY in both dimensions: location is
 * radius-based (nearby anchor cities return near-identical sets) and the title query is
 * substring-ish, so a role query pulls in loosely related titles. Everything therefore goes through the SAME deterministic filters
 * every other lane uses (titleDropped / loadNoise / REMOTE / LOCAL), never straight to scoring.
 *
 * Dates here are the employer's own `created`, and spot-checking found genuinely old values
 * (2026-02, 2026-03) rather than everything restamped to today, so unlike the aggregators this
 * source does NOT appear to launder dates. It is still not a freshness gate: the ATS record is resolved downstream regardless.
 *
 * Usage:
 *   node scripts/workable-search.mjs                 # append survivors to data/_web-roles.tsv
 *   node scripts/workable-search.mjs --dry-run
 *   node scripts/workable-search.mjs --quiet
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';
import { REMOTE, LOCAL, loadNoise, titleDropped, TITLE_KEEP, SEARCH_KEYWORDS, remoteOkFor, requireTargets } from './role-filters.mjs';

const PROFILE = requireTargets();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run');
const QUIET = has('--quiet') || (process.env.CAREER_FINDER_QUIET || process.env.CAREER_OPS_QUIET) === '1';
const log = (...a) => { if (!QUIET) console.log(...a); };

const API = 'https://jobs.workable.com/api/v1/jobs';
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36' };

// Radius search means anchors overlap heavily; use the profile city plus up to two more
// configured cities rather than every suburb. Remote-only profiles fall back to the country.
const L = PROFILE.location;
const LOCATIONS = [...new Set([L.city, ...(L.cities || [])].filter(Boolean))].slice(0, 3);
if (!LOCATIONS.length && L.country) LOCATIONS.push(L.country);
// Search exactly the configured target roles (targets.roles).
const QUERIES = SEARCH_KEYWORDS;

const NOISE = loadNoise();
const seenUrls = new Set();
for (const f of ['data/_web-roles.tsv', 'data/scored-jobs.tsv', 'data/_web-roles-history.tsv']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const c = line.split('\t');
    for (const cell of c) if (cell.startsWith('http')) seenUrls.add(cell.trim());
  }
}

const indexed = new Set();
if (existsSync('data/company-index.tsv')) {
  for (const line of readFileSync('data/company-index.tsv', 'utf-8').split('\n')) {
    const f = line.split('\t');
    if (f[0]) indexed.add(f[0].trim().toLowerCase());
  }
}

// Workable returns ONE ROW PER CITY for the same requisition (BKF's single Project Manager req
// came back 4 times, another req twice), each with its own /view/ url, so url-dedup alone does
// not collapse them. Identity here is employer + normalised title.
const reqKey = (co, title) => `${co}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim();
const seenReqs = new Set();

const stats = { fetched: 0, dupe: 0, dupeReq: 0, remote: 0, nonLocal: 0, offArchetype: 0, noise: 0, kept: 0 };
const rows = [];
const newCos = new Map();

for (const q of QUERIES) {
  for (const loc of LOCATIONS) {
    const url = `${API}?query=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}`;
    let jobs = [];
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { log(`  ${q} @ ${loc}: HTTP ${r.status}`); continue; }
      jobs = (await r.json()).jobs || [];
    } catch (e) { log(`  ${q} @ ${loc}: ${e.name}`); continue; }
    stats.fetched += jobs.length;

    for (const j of jobs) {
      const title = j.title || '';
      const company = (j.company && (j.company.title || j.company.name)) || '';
      const site = (j.company && j.company.website) || '';
      const link = j.url || '';
      const l = j.location || (j.locations && j.locations[0]) || {};
      const locStr = [l.city, l.region, l.country].filter(Boolean).join(', ') || loc;
      const workplace = (j.workplace || '').toLowerCase();
      const posted = (j.created || j.updated || '').toString().slice(0, 10);

      if (!link || seenUrls.has(link)) { stats.dupe++; continue; }
      // Remote follows location.remote_policy; trust the explicit field AND the location string.
      const isRemote = workplace === 'remote' || REMOTE.test(locStr) || REMOTE.test(title);
      if (isRemote && !remoteOkFor(title, `${locStr || ''} ${workplace || ''}`)) { stats.remote++; continue; }
      if (!isRemote && !LOCAL.test(locStr)) { stats.nonLocal++; continue; }
      // titleDropped() is a NEGATIVE filter: it removes known-bad terms but does not require an
      // on-archetype token, so with a fuzzy source query it happily passes loosely related titles the
      // fuzzy query returned.
      // Workable's query match is substring-ish, so this lane needs the POSITIVE gate as well.
      if (!TITLE_KEEP.test(title) || titleDropped(title)) { stats.offArchetype++; continue; }
      const rk = reqKey(company, title);
      if (seenReqs.has(rk)) { stats.dupeReq++; continue; }
      seenReqs.add(rk);
      // loadNoise() returns an ARRAY of substrings, matched with .some(includes) exactly as
      // hiringcafe-scan.mjs:224 does. Treating it as a Set silently matches nothing.
      const coLower = company.trim().toLowerCase();
      if (NOISE.some((n) => coLower.includes(n))) { stats.noise++; continue; }

      seenUrls.add(link);
      stats.kept++;
      rows.push([new Date().toISOString().slice(0, 10), company, title, locStr, posted, link, 'workable-search'].join('\t'));

      if (company && !indexed.has(company.trim().toLowerCase()) && site) {
        const slug = site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        if (slug) newCos.set(company, `https://apply.workable.com/${slug.split('.')[0]}/`);
      }
    }
  }
}

if (!DRY && rows.length) appendFileSync('data/_web-roles.tsv', rows.join('\n') + '\n');
if (!DRY && newCos.size) {
  appendFileSync('data/_discovered-companies.tsv',
    [...newCos].map(([c, u]) => `${c}\t${u}`).join('\n') + '\n');
}

log(`workable-search: ${stats.fetched} hit(s) over ${QUERIES.length} title(s) x ${LOCATIONS.length} location(s)`);
log(`  dropped: dupe ${stats.dupe}, same-req-other-city ${stats.dupeReq}, remote ${stats.remote}, non-local ${stats.nonLocal}, off-archetype ${stats.offArchetype}, noise ${stats.noise}`);
console.log(`workable-search: wrote ${DRY ? 0 : rows.length}, new-companies ${DRY ? 0 : newCos.size}`);
for (const r of rows) log(`  + ${r.split('\t')[1]} | ${r.split('\t')[2]}`);
