#!/usr/bin/env node

/**
 * speed-linkedin.mjs — LinkedIn guest-API supplement for the `speed` loop.
 *
 * Fetches the productive high-signal titles from LinkedIn's no-login guest jobs API for the
 * profile's location (config/profile.yml `location`) within a rolling window, then applies
 * pre-filters so each cycle surfaces ONLY genuinely new, on-target, targetable signal:
 *   - remote handling per `location.remote_policy`
 *   - the profile's local area only (targets.locationMatches)
 *   - staffing-agency / aggregator blocklist (data/_speed-noise.txt — anonymized blind posts)
 *   - off-archetype title pre-filter (drop Account/Sales Manager, pure SWE/ML/Data-Eng, etc.)
 *   - dedup vs data/scored-jobs.tsv (already-triaged roles)
 *
 * IMPORTANT: LinkedIn cards often show a local city even for REMOTE roles (and vice versa).
 * Treat every
 * survivor's location as UNVERIFIED — confirm against the company's ATS before trusting it.
 *
 * Usage:  node scripts/speed-linkedin.mjs [--hours 12] [--json]
 * Output: human table by default; `--json` emits the survivor array for piping into scoring.
 */

import { readFileSync, existsSync } from 'fs';
import { requireTargets, titleDropped, loadNoise, SEARCH_KEYWORDS, locationMatches, areaLabel, dealbreakerHit } from './role-filters.mjs';
import { liSearchGeos } from './li-geo.mjs';

requireTargets();
import { spend as spendBudget, sleep, jitterMs } from './li-budget.mjs';

const argv = process.argv.slice(2);
const hoursIdx = argv.indexOf('--hours');
const hours = hoursIdx !== -1 ? parseFloat(argv[hoursIdx + 1]) : 12;
const asJson = argv.includes('--json');

// KILL-SWITCH: skip the LinkedIn guest comb while data/LINKEDIN_OFF exists (user-set 2026-06-17).
// Emit an empty result so callers (pipeline-cron) treat it as "no LinkedIn signals" and move on.
if (existsSync(new URL('../data/LINKEDIN_OFF', import.meta.url))) {
  if (asJson) process.stdout.write('[]\n');
  else console.error('speed-linkedin: LinkedIn activity is OFF (data/LINKEDIN_OFF present). Remove that file to re-enable.');
  process.exit(0);
}
const fTPR = `r${Math.round(hours * 3600)}`; // r43200 = 12h
// Geo variants: local always; remote-country/any profiles add country geoId + f_WT=2.
const GEOS = liSearchGeos();
const TITLES = SEARCH_KEYWORDS.slice(0, 4);   // targets.roles from config/profile.yml, max 4
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const NOISE = loadNoise();
let scored = '';
try { scored = readFileSync('data/scored-jobs.tsv', 'utf-8').toLowerCase(); } catch {}

async function fetchTitle(kw, geo = '') {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}${geo ? `&${geo}` : ''}&f_TPR=${fTPR}&start=0`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    return r.ok ? await r.text() : '';
  } catch { return ''; }
}

function parseCards(html) {
  const out = [];
  for (const c of html.split('<li>').slice(1)) {
    const title = (c.match(/base-search-card__title">\s*([^<]+?)\s*</) || [])[1];
    const company = (c.match(/base-search-card__subtitle">\s*<a[^>]*>\s*([^<]+?)\s*</) || c.match(/hidden-nested-link[^>]*>\s*([^<]+?)\s*</) || [])[1];
    const loc = (c.match(/job-search-card__location">\s*([^<]+?)\s*</) || [])[1];
    // LinkedIn serves geo-localised subdomains (ph.linkedin.com, ca.linkedin.com) depending on
    // the caller's IP; normalise to www so dedup and logged URLs stay stable.
    const url = ((c.match(/href="(https:\/\/[a-z]{2,3}\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1] || '')
      .replace(/^https:\/\/[a-z]{2,3}\.linkedin\.com/, 'https://www.linkedin.com') || undefined;
    const dt = (c.match(/datetime="([^"]+)"/) || [])[1];
    const isNew = /listdate--new/.test(c);
    if (title && url) out.push({ title: title.replace(/&amp;/g, '&'), company: (company || '').replace(/&amp;/g, '&'), loc, url, dt, isNew });
  }
  return out;
}

const seen = new Set();
const stats = { raw: 0, remote: 0, nonBay: 0, noise: 0, offArchetype: 0, dup: 0, kept: 0 };
const survivors = [];

// SERIAL + jittered (2026-07-25). This used to be Promise.all over all six
// titles: six simultaneous hits on the same endpoint from one IP, on the hour,
// every hour — the most bot-shaped traffic in the repo. Unauthenticated, so the
// downside is an IP rate-limit rather than the account, but it is free to fix.
// Each query charges the `guest` budget — a separate lane from the logged-in
// caps, since anonymous calls don't touch the account, but still bounded so a
// stuck cron can't hammer the endpoint into an IP block.
const htmls = [];
const QUERIES = TITLES.flatMap(kw => GEOS.map(g => [kw, g.param]));
for (const [i, [kw, geo]] of QUERIES.entries()) {
  const b = spendBudget('guest');
  if (!b.ok) {
    console.error(`speed-linkedin: daily guest-API budget reached (${b.used}/${b.cap}) — stopping early with partial results.`);
    break;
  }
  htmls.push(await fetchTitle(kw, geo));
  if (i < QUERIES.length - 1) await sleep(jitterMs('guest'));
}
for (const html of htmls) {
  for (const card of parseCards(html)) {
    const id = card.url.split('/view/')[1];
    if (seen.has(id)) continue; seen.add(id);
    stats.raw++;
    const co = card.company.toLowerCase();
    // Remote and locality both judged by config (location.remote_policy + local area).
    if (card.loc && !locationMatches(card.loc, card.title)) {
      if (/\b(remote|anywhere|work from home)\b/i.test(`${card.title} ${card.loc}`)) stats.remote++; else stats.nonBay++;
      continue;
    }
    if (NOISE.some(n => co.includes(n))) { stats.noise++; continue; }
    if (titleDropped(card.title) || dealbreakerHit(card.company, card.title)) { stats.offArchetype++; continue; }
    if (card.company && scored.includes(co)) { stats.dup++; continue; }
    // company-less (anonymized) cards: dedup by LinkedIn job id against logged URLs
    const numId = (id || '').match(/\d{8,}/)?.[0];
    if (numId && scored.includes(numId)) { stats.dup++; continue; }
    stats.kept++; survivors.push(card);
  }
}

if (asJson) { console.log(JSON.stringify(survivors, null, 2)); process.exit(0); }

console.log(`LinkedIn ≤${hours}h (${areaLabel()}) — raw ${stats.raw} → remote ${stats.remote}, non-local ${stats.nonBay}, agency-noise ${stats.noise}, off-archetype ${stats.offArchetype}, already-scored ${stats.dup} → NEW SIGNAL: ${stats.kept}`);
if (!survivors.length) { console.log('\n(no new on-archetype, targetable, unscored roles this cycle)'); }
else { console.log(''); for (const s of survivors) console.log(`${s.isNew ? '🆕' : '  '} ${s.title} | ${s.company || '?'} | ${s.loc || '?'} | ${s.dt || '?'}\n   ${s.url}`); }
console.log('\nNOTE: locations are LinkedIn-reported (unverified) — confirm against the company ATS before trusting the location (remote roles are often mislabeled as local).');
