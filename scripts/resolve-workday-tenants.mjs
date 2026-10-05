#!/usr/bin/env node

/**
 * resolve-workday-tenants.mjs — find the Workday tenant for employers whose tenant is NOT
 * derivable from their name, and write it into the discovery queue.
 *
 * WHY. probe-ats.mjs builds Workday URLs from slugs guessed off the company name. That works when
 * the tenant matches the name (cisco -> `cisco`, Micron -> `micron`) and fails completely when it
 * does not. Measured 2026-08-24:
 *
 *     S&P Global        slugs() gives spglobal / sp-global      real tenant: spgi
 *     Applied Materials slugs() gives appliedmaterials          real tenant: amat
 *
 * Both are live boards (spgi.wd5/SPGI_Careers = 313 jobs, amat.wd1/External = 1,900) that the
 * prober could never reach. Roughly 17 large employers in the discovery queue are stranded the
 * same way. A ticker map does not fix it either: `amat` works but `intu`, `qcom` and `hpe` do not,
 * so the ticker is a weak correlation rather than a rule.
 *
 * The one thing that DOES resolve it deterministically is a search index — Workday job URLs are
 * public and indexed, so the tenant is sitting in the result URL. This uses DuckDuckGo's HTML
 * endpoint, which needs no key and no WebSearch budget.
 *
 * RATE LIMITING IS REAL AND MUST BE RESPECTED. Verified: the first query returns HTTP 200 with a
 * full body; by the third, DDG returns HTTP 202 with a truncated body and no results. It is not a
 * hard block, it is a soft throttle that silently degrades — which would look exactly like "this
 * company has no Workday board" if we did not know. Hence the long jittered delay, the 202
 * detection, and the cache: a tenant never changes, so a resolved name is never queried twice.
 *
 * Usage:
 *   node scripts/resolve-workday-tenants.mjs --names "S&P Global,Applied Materials"
 *   node scripts/resolve-workday-tenants.mjs --unresolved        # names in the queue with no URL
 *   node scripts/resolve-workday-tenants.mjs --unresolved --append --limit 15
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { loadNoise } from './role-filters.mjs';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
const APPEND = argv.includes('--append');
const LIMIT = Number(val('--limit') || 12);
const QUEUE = 'data/_discovered-companies.tsv';
const CACHE = 'data/_workday-tenants.json';
const UA = { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 8-16s, jittered. Slower than feels necessary because the failure mode is SILENT: a throttled
// response looks identical to "no board exists", and a false negative here gets cached as fact.
const politeDelay = () => 8000 + Math.random() * 8000;

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf-8')) : {};
const saveCache = () => writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');

/** Ask a public search index for the employer's Workday URL. Returns {tenant, shard, site, url}. */
async function searchTenant(name) {
  const q = encodeURIComponent(`"${name}" site:myworkdayjobs.com`);
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, UA);
  const body = await res.text();
  let text = body;
  try { text = decodeURIComponent(body); } catch { /* some bodies are not fully percent-encoded */ }

  // A 202 or a short body means throttled, NOT "no result". Never cache a throttled miss.
  const throttled = res.status === 202 || text.length < 18000;
  const full = [...new Set(text.match(/https?:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[A-Za-z0-9_-]+/gi) || [])];
  const host = [...new Set(text.match(/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com/gi) || [])];

  if (full.length) {
    const m = full[0].match(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([A-Za-z0-9_-]+)/i);
    return { tenant: m[1], shard: m[2], site: m[3], url: full[0], throttled: false };
  }
  if (host.length) {
    const m = host[0].match(/([a-z0-9-]+)\.(wd\d+)\./i);
    return { tenant: m[1], shard: m[2], site: null, url: null, throttled: false };
  }
  return { tenant: null, throttled };
}

/** Confirm a candidate against Workday's own API before believing it. */
async function verify(tenant, shard, site) {
  const sites = site ? [site] : ['External', `${tenant.toUpperCase()}_Careers`, 'Careers', 'External_Career_Site'];
  for (const s of sites) {
    try {
      const r = await fetch(`https://${tenant}.${shard}.myworkdayjobs.com/wday/cxs/${tenant}/${s}/jobs`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...UA.headers },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const n = j.total ?? (j.jobPostings || []).length;
      if (n > 0) return { site: s, postings: n, careers: `https://${tenant}.${shard}.myworkdayjobs.com/${s}` };
    } catch { /* try the next site */ }
  }
  return null;
}

// ── names to work on ────────────────────────────────────────────────────────
const NOISE = loadNoise();
const isNoise = (n) => { const l = n.toLowerCase(); return NOISE.some((x) => l.includes(x)); };

let names = [];
if (val('--names')) names = val('--names').split(',').map((s) => s.trim()).filter(Boolean);
else if (argv.includes('--unresolved') && existsSync(QUEUE)) {
  for (const line of readFileSync(QUEUE, 'utf-8').split('\n')) {
    const [co, url] = line.split('\t').map((s) => (s || '').trim());
    if (!co || /^https?:\/\//.test(url)) continue;
    names.push(co);
  }
  names = [...new Set(names)];
}
names = names.filter((n) => !isNoise(n) && !cache[n.toLowerCase()]);
if (names.length > LIMIT) { console.log(`${names.length} candidates, capping at --limit ${LIMIT}`); names = names.slice(0, LIMIT); }

console.log(`resolving Workday tenants for ${names.length} employer(s), ~${Math.round(politeDelay() / 1000)}s apart\n`);

const found = [];
let throttleHits = 0;
for (const name of names) {
  const s = await searchTenant(name).catch(() => ({ tenant: null, throttled: true }));
  if (s.throttled) {
    throttleHits++;
    console.log(`  ~ ${name} — search throttled, NOT recorded as a miss`);
    if (throttleHits >= 3) { console.log('\nthrottled three times; stopping rather than caching false negatives.'); break; }
    await sleep(politeDelay() * 2);
    continue;
  }
  if (!s.tenant) {
    cache[name.toLowerCase()] = { tenant: null, checked: new Date().toISOString().slice(0, 10) };
    console.log(`  · ${name} — no Workday URL indexed`);
    await sleep(politeDelay());
    continue;
  }
  const v = await verify(s.tenant, s.shard, s.site);
  if (v) {
    found.push({ name, careers: v.careers, postings: v.postings });
    cache[name.toLowerCase()] = { tenant: s.tenant, shard: s.shard, site: v.site, careers: v.careers, checked: new Date().toISOString().slice(0, 10) };
    console.log(`  ✓ ${name} → ${s.tenant}.${s.shard}/${v.site}  (${v.postings} postings)`);
  } else {
    console.log(`  ✗ ${name} — found ${s.tenant}.${s.shard} in search but no live board confirmed`);
  }
  saveCache();
  await sleep(politeDelay());
}

saveCache();
console.log(`\nresolved ${found.length} of ${names.length}${throttleHits ? `, ${throttleHits} throttled` : ''}`);

if (APPEND && found.length) {
  // Rewrite the queue in place so the resolved name carries its careers_url.
  const lines = readFileSync(QUEUE, 'utf-8').split('\n').map((line) => {
    const [co, url] = line.split('\t').map((s) => (s || '').trim());
    if (!co || /^https?:\/\//.test(url)) return line;
    const hit = found.find((f) => f.name.toLowerCase() === co.toLowerCase());
    return hit ? `${co}\t${hit.careers}` : line;
  });
  writeFileSync(QUEUE, lines.join('\n'));
  console.log(`wrote ${found.length} careers_url(s) into ${QUEUE}`);
} else if (found.length) {
  console.log('(dry run — pass --append to write them into the discovery queue)');
}
