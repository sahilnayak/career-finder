#!/usr/bin/env node

/**
 * recall-audit.mjs — One-shot diagnostic: where is the discovery pipeline BLIND?
 *
 * Sweeps every indexed board once with the filters DISABLED, then buckets what the
 * production filters would have thrown away. Answers, quantitatively:
 *   - how many plausibly-target roles in the profile's area are open right now
 *   - how many are lost to the portals.yml title whitelist (substring, so a singular
 *     keyword can miss a plural title)
 *   - how many are lost to the strict city-list location filter (prose locations)
 *   - how many are lost to a missing/absent postedAt
 *   - the age distribution, i.e. how much of the market the pipeline window can ever see
 *
 * The BROAD (recall-ceiling) title set is targets.roles + title_keywords + the optional
 * targets.recall_keywords list in config/profile.yml.
 *
 * Zero LLM tokens. Read-only: writes only /tmp-style JSON under data/_recall-audit.json.
 *
 * Usage: node scripts/recall-audit.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import {
  detectApi, fetchProvider, PARSERS, buildTitleFilter, buildLocationFilter,
  parallelFetch, taskHost,
} from './scan-core.mjs';
import { requireTargets, isPrimaryRole } from './targets.mjs';

const profile = requireTargets();

const portals = existsSync('portals.yml') ? (yaml.load(readFileSync('portals.yml', 'utf-8')) || {}) : {};
const titleFilter = buildTitleFilter(portals.title_filter, { dropSeniorityNegatives: true });
const locFilter = buildLocationFilter();

if (!existsSync('data/company-index.tsv')) { console.error('No data/company-index.tsv — seed it first.'); process.exit(1); }
const text = readFileSync('data/company-index.tsv', 'utf-8').split('\n');
const header = text[0].split('\t');
const rows = text.slice(1).filter(Boolean)
  .map(l => { const c = l.split('\t'); return Object.fromEntries(header.map((h, i) => [h, c[i] ?? ''])); })
  .filter(r => r.ats_api_url);

// Deliberately WIDER than portals.yml — this is the recall ceiling we measure against.
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
const broadTerms = [...profile.targets.roles, ...profile.targets.title_keywords, ...(profile.targets.recall_keywords || [])]
  .map(String).map(t => t.replace(/^!/, '').trim()).filter(Boolean);
const BROAD = broadTerms.length ? new RegExp(`(${broadTerms.map(esc).join('|')})`, 'i') : /$^/;
const REMOTE = /\b(remote|anywhere|work from home|wfh|distributed)\b/i;
// "Near miss" locations: in the user's state but not matched by the strict city list.
const st = String(profile.location.state || '').trim();
const REGIONISH = st ? new RegExp(`(\\b${esc(st)}\\b|${esc(profile.location.metro || st)})`, 'i') : /$^/;

const b = { jobs: 0, boards: 0, err: 0 };
const broadLocal = [];     // BROAD title + passes the strict location filter
const broadRegion = [];    // BROAD title + in-state location that FAILS the strict filter
const broadNoLoc = [];     // BROAD title + blank location (auto-rejected today)
const missedByTitle = [];  // BROAD + local, but the portals.yml whitelist says no
const famCount = {};
const perFamJobs = {};

const tasks = rows.map(r => {
  const t = async () => {
    const api = detectApi({ api: r.ats_api_url, careers_url: r.careers_url });
    if (!api || !PARSERS[api.type]) return;
    try {
      const json = await fetchProvider(api);
      const jobs = PARSERS[api.type](json, r.company, api);
      b.jobs += jobs.length; b.boards++;
      perFamJobs[api.type] = (perFamJobs[api.type] || 0) + jobs.length;
      for (const j of jobs) {
        const title = String(j.title || ''); const loc = String(j.location || '');
        if (!BROAD.test(title) || REMOTE.test(title)) continue;
        const rec = {
          c: j.company, t: title, l: loc, p: j.postedAt ? j.postedAt.toISOString() : '',
          u: j.url, a: api.type, pri: isPrimaryRole(title),
        };
        if (locFilter(loc)) {
          broadLocal.push(rec);
          famCount[api.type] = (famCount[api.type] || 0) + 1;
          if (!titleFilter(title)) missedByTitle.push(rec);
        } else if (!loc) broadNoLoc.push(rec);
        else if (!REMOTE.test(loc) && REGIONISH.test(loc)) broadRegion.push(rec);
      }
    } catch { b.err++; }
  };
  t.host = taskHost(r.ats_api_url);
  return t;
});

await parallelFetch(tasks, 24);

const now = Date.now(), H = 3600e3;
function ageBuckets(list) {
  const o = { '<=24h': 0, '24-72h': 0, '3-7d': 0, '7-30d': 0, '>30d': 0, 'no-date': 0 };
  for (const r of list) {
    if (!r.p) { o['no-date']++; continue; }
    const h = (now - Date.parse(r.p)) / H;
    if (h <= 24) o['<=24h']++; else if (h <= 72) o['24-72h']++;
    else if (h <= 168) o['3-7d']++; else if (h <= 720) o['7-30d']++; else o['>30d']++;
  }
  return o;
}

const summary = {
  boards_ok: b.boards, boards_err: b.err, total_jobs: b.jobs,
  jobs_by_family: perFamJobs,
  BROAD_local_total: broadLocal.length,
  BROAD_local_primary: broadLocal.filter(r => r.pri).length,
  BROAD_local_age: ageBuckets(broadLocal),
  BROAD_local_primary_age: ageBuckets(broadLocal.filter(r => r.pri)),
  local_by_family: famCount,
  MISSED_by_portals_title_filter: missedByTitle.length,
  MISSED_primary: missedByTitle.filter(r => r.pri).length,
  MISSED_titles: [...new Set(missedByTitle.map(r => r.t))].sort(),
  REGION_dropped_by_locfilter: broadRegion.length,
  REGION_sample_locs: [...new Set(broadRegion.map(r => r.l))].slice(0, 40),
  NOLOC_dropped: broadNoLoc.length,
};

writeFileSync('data/_recall-audit.json', JSON.stringify({ ...summary, broadLocal, broadRegion, broadNoLoc }, null, 1));
console.log(JSON.stringify(summary, null, 1));
