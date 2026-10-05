#!/usr/bin/env node

/**
 * discover-companies.mjs — Grows data/company-index.tsv from external sources.
 *
 * The "company discovery agent" (zero-token core). Merges:
 *   - config/profile.yml discovery.seed_companies ([{company, careers_url}]) and
 *     data/seed-companies.tsv (`company\tcareers_url`), the user's own seed lists
 *   - an optional --from <file.tsv> of `company\tcareers_url` rows (e.g. output
 *     of the background company-finder agent or a browser discovery pass)
 *   - optional YC directory (--yc, or discovery.yc: true in the profile), filtered to the
 *     profile's location (startup-heavy; mainly useful for tech roles)
 *
 * The index starts EMPTY in a fresh install. There is no built-in company list: which
 * employers matter depends on the user's role and metro.
 *
 * For each candidate it runs detectApi() and appends new rows (dedup by
 * careers_url) to data/company-index.tsv. Idempotent / incremental.
 *
 * Usage:
 *   node scripts/discover-companies.mjs [--from data/_discovered-companies.tsv] [--yc] [--dry-run]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { detectApi, fetchJson } from './scan-core.mjs';
import { detectFamily } from './probe-ats-core.mjs';
import { requireTargets, locationMatches, areaLabel } from './targets.mjs';

const INDEX_PATH = 'data/company-index.tsv';
const HEADER = 'company\thq\tcareers_url\tats_type\tats_api_url\tsource\tdate_added\tlast_scanned\tlast_status\n';
const TODAY = new Date().toISOString().slice(0, 10);

const SEED_FILE = 'data/seed-companies.tsv';

function profileSeeds(profile) {
  const raw = profile.discovery?.seed_companies;
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`discovery.seed_companies must be a list, got ${typeof raw}. Use plain names ("- Acme") or objects ("- {company: Acme, careers_url: https://...}").`);
  }
  const out = [];
  raw.forEach((c, i) => {
    if (typeof c === 'string') {
      // Plain string: a company name, or "Name | https://careers-url".
      const [name, url] = c.split(/\s*[|\t]\s*/);
      if (name?.trim()) out.push({ company: name.trim(), careers_url: (url || '').trim() });
      return;
    }
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const company = String(c.company || c.name || '').trim();
      if (!company) throw new Error(`discovery.seed_companies[${i}] is an object without a company/name key (keys: ${Object.keys(c).join(', ') || 'none'}). Expected {company, careers_url}.`);
      out.push({ company, careers_url: String(c.careers_url || c.url || '').trim() });
      return;
    }
    throw new Error(`discovery.seed_companies[${i}] has unsupported shape (${Array.isArray(c) ? 'array' : typeof c}: ${JSON.stringify(c)}). Expected a string or {company, careers_url}.`);
  });
  return out.filter(c => c.company && (!c.careers_url || /^https?:\/\//.test(c.careers_url)));
}

function parseTsvPairs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [company, careers_url] = t.split('\t').map(s => (s || '').trim());
    if (company && careers_url && /^https?:\/\//.test(careers_url)) out.push({ company, careers_url });
  }
  return out;
}

function loadExisting() {
  const keys = new Set();
  const names = new Set();
  if (existsSync(INDEX_PATH)) {
    for (const line of readFileSync(INDEX_PATH, 'utf-8').split('\n').slice(1)) {
      const cols = line.split('\t');
      const cu = cols[2];
      if (cu) keys.add(cu.toLowerCase().replace(/\/$/, ''));
      const name = (cols[0] || '').trim();
      if (name) names.add(name.toLowerCase());
    }
  }
  keys.names = names;
  return keys;
}

// ── YC company directory via Algolia. Zero LLM, zero browser. ───────────────────────────────
//
// THE KEY DOES NOT NEED TO BE CONFIGURED. YC embeds a public, search-only, index-restricted
// Algolia key in its own page JS for client-side search (`window.AlgoliaOpts`). It is scoped by
// Algolia to `restrictIndices=YCCompany_production,...` with `tagFilters=["ycdc_public"]`, i.e.
// it can read the public company directory and nothing else. We scrape it at run time rather
// than hardcoding it, because YC rotates it on deploys; an env var override is still honoured
// if someone wants to pin one.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36';
const YC_APP = '45BWZJ1SGC';

async function ycKey() {
  if (process.env.YC_ALGOLIA_KEY) return process.env.YC_ALGOLIA_KEY;
  const r = await fetch('https://www.ycombinator.com/companies', {
    headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`yc page HTTP ${r.status}`);
  const m = (await r.text()).match(/window\.AlgoliaOpts\s*=\s*(\{.*?\})\s*[;<]/s);
  if (!m) throw new Error('AlgoliaOpts not found on the YC companies page');
  const o = JSON.parse(m[1]);
  if (!o.key) throw new Error('AlgoliaOpts carried no key');
  return o.key;
}

async function fetchYC() {
  try {
    const key = await ycKey();
    const hits = [];
    // isHiring:true cuts the directory from ~6,200 companies to ~1,478, the only half worth indexing.
    for (let page = 0; page < 4; page++) {
      const r = await fetch(`https://${YC_APP.toLowerCase()}-dsn.algolia.net/1/indexes/YCCompany_production/query`, {
        method: 'POST',
        headers: { 'X-Algolia-Application-Id': YC_APP, 'X-Algolia-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: `hitsPerPage=1000&page=${page}&query=&filters=isHiring:true` }),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) break;
      const d = await r.json();
      hits.push(...(d.hits || []));
      if (page >= (d.nbPages ?? 1) - 1) break;
    }

    // Keep companies with an office in the profile's search area (or remote, per remote_policy).
    const localAll = hits.filter((h) => locationMatches(h.all_locations || h.location || ''))
      .filter((h) => h.name && h.website);

    // THE RUN MUST ADVANCE, or the lane re-probes the same prefix forever. Without this, a
    // capped run always walks the SAME first N companies: the first run adds whatever it finds
    // and every later run re-fetches those identical sites to rediscover rows already indexed,
    // burning the whole budget to add nothing. Skip anything already in the index, and remember
    // the ones we probed and could not resolve so they do not block the queue head either.
    const already = new Set();
    try {
      for (const line of readFileSync('data/company-index.tsv', 'utf-8').split('\n')) {
        const n = line.split('\t')[0];
        if (n) already.add(n.trim().toLowerCase());
      }
    } catch { /* no index yet */ }
    const SEEN_FILE = 'data/_yc-probed.txt';
    const seenProbed = new Set();
    try {
      for (const l of readFileSync(SEEN_FILE, 'utf-8').split('\n')) if (l.trim()) seenProbed.add(l.trim().toLowerCase());
    } catch { /* first run */ }

    const local = localAll.filter((h) => {
      const n = h.name.trim().toLowerCase();
      return !already.has(n) && !seenProbed.has(n);
    });

    // RESOLVE THE BOARD FROM THE COMPANY'S OWN SITE, NEVER BY GUESSING A SLUG.
    //
    // The index stores a careers_url that scan-core must be able to PARSE; a bare marketing site
    // is unsweepable, and an earlier version of this function emitted 465 such rows in one run.
    // Guessing a slug from the company name is worse than useless: it silently attaches a
    // live-but-WRONG board whenever the name is generic. Probing 10 of these by name alone
    // "resolved" YC's Reach (reachpower.com) to jobs.ashbyhq.com/reach, a board that belongs to
    // someone else entirely. That is an index identity collision.
    //
    // So read the employer's OWN careers
    // page and take the ATS link THEY publish. A link on the company's own domain is
    // self-asserted identity, so there is no collision left to resolve.
    const ATS_LINK = /https?:\/\/(?:job-boards\.|boards\.)?(?:greenhouse\.io\/[a-z0-9-]+|jobs\.ashbyhq\.com\/[a-z0-9-]+|jobs\.lever\.co\/[a-z0-9-]+|careers\.smartrecruiters\.com\/[a-z0-9-]+|apply\.workable\.com\/[a-z0-9-]+|[a-z0-9-]+\.recruitee\.com|ats\.rippling\.com\/[a-z0-9-]+)/i;
    const LIMIT = Number(process.env.YC_PROBE_LIMIT || 150);   // incremental; the rest roll to the next run
    const out = [];
    const probedNames = [];
    let probed = 0;

    for (const h of local) {
      if (probed >= LIMIT) break;
      probed++;
      probedNames.push(h.name.trim());
      const root = h.website.replace(/\/+$/, '');
      for (const path of ['/careers', '/jobs', '']) {
        try {
          const r = await fetch(root + path, { headers: { 'user-agent': UA }, redirect: 'follow',
                                               signal: AbortSignal.timeout(12000) });
          if (!r.ok) continue;
          const m = (await r.text()).match(ATS_LINK);
          if (m) { out.push({ company: h.name, careers_url: m[0] }); break; }
        } catch { /* a dead marketing site is not worth failing the lane for */ }
      }
    }
    // Record every company we actually probed, resolved or not, so the next run starts after them.
    // A --dry-run must NOT advance the cursor, or "preview" silently consumes the queue.
    if (probedNames.length && !process.argv.includes('--dry-run')) {
      try { appendFileSync(SEEN_FILE, probedNames.join('\n') + '\n'); } catch { /* non-fatal */ }
    }
    console.error(`  yc: ${hits.length} hiring, ${localAll.length} in ${areaLabel()}, ${local.length} unprobed, probed ${probed}, resolved ${out.length} real ATS board(s), ${localAll.length - local.length} already known`);
    return out;
  } catch (e) {
    // Loud, not silent: this lane failing invisibly is how it produced nothing for months.
    console.error(`  yc: lane failed (${e.message})`);
    return [];
  }
}

async function main() {
  const profile = requireTargets();
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fromIdx = argv.indexOf('--from');
  const fromFile = fromIdx !== -1 ? argv[fromIdx + 1] : null;

  const existing = loadExisting();
  const candidates = new Map(); // normalized careers_url -> {company, careers_url, source}

  const needsUrl = [];
  const add = (rows, source) => {
    for (const r of rows) {
      if (!r.careers_url) { needsUrl.push(r.company); continue; }
      const key = r.careers_url.toLowerCase().replace(/\/$/, '');
      if (!candidates.has(key)) candidates.set(key, { ...r, source });
    }
  };

  let seeds;
  try { seeds = profileSeeds(profile); } catch (e) { console.error(`discover-companies: ${e.message}`); process.exit(1); }
  add(seeds, 'seed');
  if (needsUrl.length) {
    console.error(`discover-companies: ${needsUrl.length} seed(s) have a name but no careers_url and were skipped: ${needsUrl.join(', ')}`);
    console.error('  Find each careers page (Workday/Oracle/iCIMS/Greenhouse URL) and add it as {company, careers_url} or "Name | https://...".');
  }
  if (existsSync(SEED_FILE)) add(parseTsvPairs(readFileSync(SEED_FILE, 'utf-8')), 'seed');
  if (fromFile && existsSync(fromFile)) add(parseTsvPairs(readFileSync(fromFile, 'utf-8')), 'agent');
  // `discovery.yc: false` always wins (morning passes --yc by default, item #17).
  const ycOn = profile.discovery?.yc !== false && (argv.includes('--yc') || profile.discovery?.yc === true);
  if (fromFile && !existsSync(fromFile)) { console.error(`discover-companies: --from file not found: ${fromFile}`); process.exit(1); }
  if (!candidates.size && !ycOn) {
    console.error('discover-companies: no company sources configured. Add discovery.seed_companies to config/profile.yml,');
    console.error(`  rows to ${SEED_FILE} (company<TAB>careers_url), pass --from <file.tsv>, or enable --yc / discovery.yc: true.`);
    process.exit(1);
  }
  if (ycOn) add(await fetchYC(), 'yc');

  const rows = [];
  let withApi = 0, browserOnly = 0, unsupported = 0;
  for (const [key, c] of candidates) {
    if (existing.has(key)) continue;
    const nameKey = (c.company || '').trim().toLowerCase();
    if (nameKey && existing.names.has(nameKey)) continue; // dedup on company name
    const api = detectApi({ careers_url: c.careers_url });
    const fam = api ? null : detectFamily(c.careers_url);
    if (api) withApi++; else browserOnly++;
    if (fam) { unsupported++; console.log(`  unsupported family ${fam}: ${c.company} (${c.careers_url}) — indexed, not yet parsed`); }
    if (nameKey) existing.names.add(nameKey); // guard against dupes within this batch
    rows.push([c.company, '', c.careers_url, api?.type || fam || '', api?.url || '', c.source, TODAY, '', ''].join('\t'));
  }

  console.log(`Candidates: ${candidates.size} | already indexed: ${existing.size} | new: ${rows.length}`);
  console.log(`  with ATS API: ${withApi} | browser-only: ${browserOnly}${unsupported ? ` (${unsupported} on a detected-but-unsupported ATS)` : ''}`);
  if (!candidates.size) { console.error('discover-companies: every configured source returned 0 candidates (see lane logs above)'); process.exit(1); }
  if (fromFile) console.log(`  (merged --from ${fromFile})`);

  if (dryRun) { console.log('(dry run — nothing written)'); rows.slice(0, 12).forEach(r => console.log('  + ' + r.split('\t').slice(0, 5).join(' | '))); return; }

  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, HEADER, 'utf-8');
  if (rows.length) appendFileSync(INDEX_PATH, rows.join('\n') + '\n', 'utf-8');
  const total = readFileSync(INDEX_PATH, 'utf-8').split('\n').filter(Boolean).length - 1;
  console.log(`Wrote ${rows.length} new rows → ${INDEX_PATH} (total: ${total} companies)`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
