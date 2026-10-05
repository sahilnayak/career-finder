#!/usr/bin/env node

/**
 * repair-index.mjs — re-detect the ATS for company-index rows whose board is dead.
 *
 * WHY THIS EXISTS. `scan-index` stamps `last_status` on every row it sweeps. Rows that
 * come back `error: HTTP 404` keep getting swept, keep failing, and are never repaired —
 * so a company that MIGRATED ATS (Greenhouse -> Ashby is the common direction) silently
 * drops out of coverage while still appearing to be indexed.
 *
 * Measured 2026-07-27: **58 of 1,329 indexed companies (4.4%) were 404ing**, and one of
 * them was Notion — which had moved Greenhouse -> Ashby and posted THREE SF Solutions
 * Consultant roles that day. The sweep saw none of them; a LinkedIn crawl found them.
 * That is the entire cost of this bug in one example.
 *
 * WHAT IT DOES. For each failing row, probe the known ATS hosts with slug candidates
 * derived from the company name and the existing careers_url, and rewrite the row's
 * ats_type + ats_api_url on the first host that returns a non-empty job list.
 *
 * Zero LLM tokens. Read-only against the network (HTTP GET of public job-board APIs).
 *
 * Usage:
 *   node scripts/repair-index.mjs            # dry run — report only, writes nothing
 *   node scripts/repair-index.mjs --apply    # rewrite data/company-index.tsv
 *   node scripts/repair-index.mjs --all      # probe every row, not just failing ones
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const INDEX = `${ROOT}data/company-index.tsv`;
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? Number(process.argv[i + 1]) : Infinity; })();

if (!existsSync(INDEX)) { console.error('no data/company-index.tsv'); process.exit(1); }

const lines = readFileSync(INDEX, 'utf8').split('\n');
const header = lines[0];
const COLS = header.split('\t');
const iCo = 0, iCareers = 2, iType = 3, iApi = 4, iStatus = COLS.length - 1;

// Alternate board URLs discovery has already seen, keyed by lowercased company name.
// _discovered-companies.tsv often holds the CORRECT slug for a row that is dead in the
// index (it had `greenhouse.io/sourcegraph91` while the index carried plain `sourcegraph`),
// so consulting it turns a guess into a lookup.
const DISCOVERED = (() => {
  const map = new Map();
  try {
    for (const line of readFileSync(`${ROOT}data/_discovered-companies.tsv`, 'utf8').split('\n')) {
      const [name, url] = line.split('\t');
      if (!name || !url) continue;
      const key = name.toLowerCase().trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(url.trim());
    }
  } catch { /* optional file */ }
  return map;
})();

/** Slug candidates: from discovery, the careers_url path, and the company name. */
function slugCandidates(company, careersUrl) {
  const out = new Set();
  const slugOf = u => (String(u || '').match(/(?:greenhouse\.io|ashbyhq\.com|lever\.co|recruitee\.com|teamtailor\.com)\/(?:posting-api\/job-board\/|v1\/boards\/|v0\/postings\/)?([^/?#]+)/i) || [])[1];

  for (const u of DISCOVERED.get(String(company || '').toLowerCase().trim()) || []) {
    const s = slugOf(u); if (s) out.add(s.toLowerCase());
  }
  const m = slugOf(careersUrl);
  if (m) out.add(m.toLowerCase());

  const n = String(company || '').toLowerCase().trim();
  const bare = n.replace(/[^a-z0-9]+/g, '');
  const dashed = n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Corporate tails employers routinely drop from (or add to) their board slug.
  const TAIL = /[-]?(ai|inc|io|hq|labs?|health|data|systems?|technolog(?:y|ies)|software|co|corp)$/;
  for (const s of [bare, dashed, bare.replace(TAIL, ''), dashed.replace(TAIL, '')]) {
    if (s && s.length > 1) out.add(s);
  }
  for (const suf of ['ai', 'hq', 'labs', 'data', 'inc']) {
    if (bare && !bare.endsWith(suf)) { out.add(bare + suf); out.add(dashed + '-' + suf); }
  }
  const first = n.split(/[^a-z0-9]+/).filter(Boolean)[0];
  if (first && first.length > 2) out.add(first);
  // 10 candidates x 7 providers is the practical ceiling before a full pass gets too slow.
  return [...out].filter(Boolean).slice(0, 10);
}

// Ordered most-likely-first; the probe stops at the first board returning jobs.
// `includeCompensation` on ashby matters: without it a repaired row silently loses the
// published salary band that scoring and the report's Block D read.
const PROVIDERS = [
  { type: 'ashby', url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`, count: j => (j?.jobs || []).length },
  { type: 'greenhouse', url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`, count: j => (j?.jobs || []).length },
  { type: 'lever', url: s => `https://api.lever.co/v0/postings/${s}?mode=json`, count: j => (Array.isArray(j) ? j.length : 0) },
  // Families below added 2026-08-04. repair-index probed only the three above while
  // scan-core PARSES TEN, so any company that had migrated to a rarer or in-house ATS was
  // unfixable by construction. Rippling is the proof: the pipeline already held its board
  // (ats.rippling.com/rippling) from a LinkedIn find, and repair still called the row dead.
  // Excluded on purpose: workday needs a tenant+shard+site triple that cannot be derived
  // from a slug, teamtailor serves XML rather than JSON, and bamboohr gates its list endpoint.
  { type: 'smartrecruiters', url: s => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`, count: j => (j?.content || []).length },
  { type: 'rippling', url: s => `https://api.rippling.com/platform/api/ats/v1/board/${s}/jobs`, count: j => (Array.isArray(j) ? j.length : 0) },
  { type: 'workable', url: s => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`, count: j => (j?.jobs || []).length },
  { type: 'recruitee', url: s => `https://${s}.recruitee.com/api/offers/`, count: j => (j?.offers || []).length },
];

async function probe(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const rows = lines.slice(1).map((l, idx) => ({ idx: idx + 1, raw: l, f: l.split('\t') })).filter(r => r.f[iCo]);
const targets = (ALL ? rows : rows.filter(r => /error|404|403/i.test(r.f[iStatus] || ''))).slice(0, LIMIT);

console.log(`${rows.length} indexed companies · ${targets.length} to probe${ALL ? ' (--all)' : ' (failing only)'}${APPLY ? '' : ' · DRY RUN'}\n`);

const fixed = [], stillDead = [];
let done = 0;
for (const r of targets) {
  const company = r.f[iCo];
  let hit = null;
  outer:
  for (const s of slugCandidates(company, r.f[iCareers])) {
    for (const p of PROVIDERS) {
      const url = p.url(s);
      const j = await probe(url);
      const n = j ? p.count(j) : 0;
      if (n > 0) { hit = { type: p.type, url, slug: s, n }; break outer; }
    }
  }
  done++;
  if (hit) {
    const was = r.f[iType] || '?';
    fixed.push({ company, was, now: hit.type, url: hit.url, n: hit.n });
    r.f[iType] = hit.type;
    r.f[iApi] = hit.url;
    r.f[iStatus] = `repaired ${new Date().toISOString().slice(0, 10)}`;
    r.raw = r.f.join('\t');
    console.log(`  ✅ ${company}: ${was} → ${hit.type} (${hit.n} jobs)  ${hit.url}`);
  } else {
    stillDead.push(company);
  }
  if (done % 20 === 0) console.log(`  … ${done}/${targets.length}`);
}

console.log(`\n──────── repair summary ────────`);
console.log(`repaired:   ${fixed.length}`);
console.log(`still dead: ${stillDead.length}${stillDead.length ? ' (' + stillDead.slice(0, 12).join(', ') + (stillDead.length > 12 ? ', …' : '') + ')' : ''}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to update data/company-index.tsv.');
  process.exit(0);
}
if (!fixed.length) { console.log('\nnothing to write.'); process.exit(0); }

copyFileSync(INDEX, `${INDEX}.bak`);
const out = [header, ...rows.map(r => r.raw)].join('\n');
writeFileSync(INDEX, out.endsWith('\n') ? out : out + '\n');
console.log(`\nwrote data/company-index.tsv (backup at company-index.tsv.bak)`);
