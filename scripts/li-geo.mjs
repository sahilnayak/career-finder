#!/usr/bin/env node
// li-geo.mjs — the LinkedIn location filter, read from config/profile.yml.
//
// LinkedIn search URLs filter on a numeric geoId. Resolution order (first hit wins):
//   1. an explicit override (a --geo flag)
//   2. location.linkedin_geo_id in config/profile.yml
//   3. the resolver cache data/_li-geo-cache.json (filled by `node scripts/li-geo.mjs resolve`)
//   4. a small built-in table of geoIds known to be stable (countries + SF Bay Area)
//   5. the free-text `location=` parameter built from city/state/country
// Every LinkedIn lane builds its URL through liGeoParam()/liSearchGeos() so there is one source
// of truth.
//
// REMOTE. When location.remote_policy is remote-country or any, liSearchGeos() adds a second
// geo variant: the COUNTRY geoId plus LinkedIn's remote facet f_WT=2. The local-geo search alone
// never shows a remote req listed against another city. Lanes do NOT cross it with every search
// form: the crawl, faceted and semantic forms all run on the local geo, and linkedin-jobsearch.mjs
// runs ONE extra faceted search per role on the remote variant.
//
// CLI:
//   node scripts/li-geo.mjs show              # what every lane will use, as JSON
//   node scripts/li-geo.mjs resolve [--force] # resolve city/metro -> geoId via LinkedIn's public
//                                             # typeahead, cache it in data/_li-geo-cache.json, and
//                                             # write location.linkedin_geo_id into the profile when
//                                             # it is unset (one-line edit, comments preserved)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadTargets, areaLabel, PROFILE_PATH } from './targets.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GEO_CACHE = process.env.CAREER_FINDER_LI_GEO_CACHE || join(REPO, 'data/_li-geo-cache.json');

// Only ids already proven in production searches. Metros vary per account/locale, so they are
// resolved and cached rather than guessed.
const KNOWN = {
  'united states': '103644278', 'usa': '103644278', 'us': '103644278', 'united states of america': '103644278',
  'canada': '101174742', 'united kingdom': '101165590', 'uk': '101165590', 'india': '102713980',
  'san francisco bay area': '90000084', 'sf bay area': '90000084', 'bay area': '90000084',
};
export const US_GEO_ID = '103644278';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function readCache() { try { return JSON.parse(readFileSync(GEO_CACHE, 'utf8')); } catch { return {}; } }
function writeCache(o) {
  try { mkdirSync(dirname(GEO_CACHE), { recursive: true }); writeFileSync(GEO_CACHE, JSON.stringify(o, null, 2) + '\n'); } catch { /* best effort */ }
}

export function liLocationText() {
  const l = loadTargets().location;
  // City, state, country — NOT the metro label. LinkedIn geocodes free text loosely: measured,
  // "Chicago Metro" resolved to the Philippines while "Chicago, IL, United States" resolved
  // correctly. Set location.linkedin_geo_id to avoid free-text geocoding entirely.
  const parts = [l.city, l.state, l.country].filter(Boolean);
  return parts.length ? parts.join(', ') : (l.metro || '');
}

/** Candidate strings to look up, most specific first. */
function lookupKeys() {
  const l = loadTargets().location;
  return [l.metro, [l.city, l.state].filter(Boolean).join(', '), l.city, liLocationText()].map(norm).filter(Boolean);
}

/** The local geoId, or '' when nothing resolves (callers then fall back to free text). */
export function liGeoId() {
  const explicit = String(loadTargets().location.linkedin_geo_id || '').trim();
  if (explicit) return explicit;
  const cache = readCache();
  for (const k of lookupKeys()) {
    if (cache[k]?.id) return String(cache[k].id);
    if (KNOWN[k]) return KNOWN[k];
  }
  return '';
}

/** The country geoId for remote searches ('' when unknown). */
export function liCountryGeoId() {
  const c = norm(loadTargets().location.country || 'united states');
  return readCache()[`country:${c}`]?.id || KNOWN[c] || '';
}

// Returns a query-string fragment WITHOUT the leading '&': `geoId=123` or `location=Chicago%2C%20IL`.
// An explicit override (e.g. a --geo flag) wins.
export function liGeoParam(override = '') {
  const id = String(override || liGeoId()).trim();
  if (id) return `geoId=${encodeURIComponent(id)}`;
  const text = liLocationText();
  return text ? `location=${encodeURIComponent(text)}` : '';
}

/**
 * The geo variants every lane searches, each a { tag, param, label } where param is a query
 * fragment without the leading '&'. Always the local geo; plus { tag:'remote' } (country geoId +
 * f_WT=2) when remote_policy is remote-country or any.
 */
export function liSearchGeos(override = '') {
  const out = [{ tag: 'local', param: liGeoParam(override), label: areaLabel() }];
  const l = loadTargets().location;
  if (l.remote_policy === 'remote-country' || l.remote_policy === 'any') {
    const cid = liCountryGeoId();
    const country = l.country || 'United States';
    const geo = cid ? `geoId=${cid}` : `location=${encodeURIComponent(country)}`;
    out.push({ tag: 'remote', param: `${geo}&f_WT=2`, label: `remote, ${country}` });
  }
  return out;
}

/**
 * Set location.linkedin_geo_id in profile YAML TEXT with a minimal line edit: fills an existing
 * empty `linkedin_geo_id:` line (keeping its trailing comment), or inserts one directly under
 * `location:`. Returns { text, changed }. Never overwrites a non-empty value; never re-serialises
 * the YAML, so comments and ordering survive. No `location:` block = unchanged.
 */
export function setProfileGeoId(text, id) {
  const lines = String(text).split('\n');
  const locIdx = lines.findIndex((l) => /^location:\s*(#.*)?$/.test(l));
  if (locIdx === -1 || !id) return { text, changed: false };
  let end = lines.length;
  for (let i = locIdx + 1; i < lines.length; i++) if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) { end = i; break; }
  let indent = '  ';
  for (let i = locIdx + 1; i < end; i++) {
    const m = lines[i].match(/^(\s+)linkedin_geo_id:\s*(.*)$/);
    if (m) {
      const [val, ...cmt] = m[2].split(/\s+#/);
      const v = val.trim().replace(/^["']|["']$/g, '');
      if (v && v !== '~' && v !== 'null') return { text, changed: false };
      lines[i] = `${m[1]}linkedin_geo_id: "${id}"${cmt.length ? '   #' + cmt.join(' #') : ''}`;
      return { text: lines.join('\n'), changed: true };
    }
    const k = lines[i].match(/^(\s+)[a-z_]+:/);
    if (k && indent === '  ') indent = k[1];
  }
  lines.splice(locIdx + 1, 0, `${indent}linkedin_geo_id: "${id}"   # written by li-geo.mjs resolve`);
  return { text: lines.join('\n'), changed: true };
}

/** Resolve via LinkedIn's PUBLIC guest typeahead (no login, no account budget). */
export async function resolveGeo(query, { fetchImpl = fetch } = {}) {
  const url = 'https://www.linkedin.com/jobs-guest/api/typeaheadHits?typeaheadType=GEO'
    + '&geoTypes=POPULATED_PLACE,ADMIN_DIVISION_2,MARKET_AREA,COUNTRY_REGION&query=' + encodeURIComponent(query);
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`typeahead HTTP ${r.status}`);
  const hits = await r.json();
  const h = Array.isArray(hits) ? hits[0] : null;
  return h?.id ? { id: String(h.id), name: h.displayName || h.name || query } : null;
}

async function cli() {
  const cmd = process.argv[2] || 'show';
  if (cmd === 'resolve') {
    const force = process.argv.includes('--force');
    const cache = readCache();
    const l = loadTargets().location;
    const wanted = [];
    const local = l.metro || liLocationText();
    if (local) wanted.push([norm(local), local]);
    if (l.remote_policy === 'remote-country' || l.remote_policy === 'any') {
      const c = l.country || 'United States';
      if (!KNOWN[norm(c)]) wanted.push([`country:${norm(c)}`, c]);
    }
    const res = {};
    for (const [key, q] of wanted) {
      if (!force && cache[key]?.id) { res[key] = { ...cache[key], cached: true }; continue; }
      if (!force && KNOWN[key]) { res[key] = { id: KNOWN[key], builtin: true }; continue; }
      try {
        const hit = await resolveGeo(q);
        if (hit) { cache[key] = { ...hit, query: q, resolved_at: new Date().toISOString() }; res[key] = cache[key]; }
        else res[key] = { error: 'no match — set location.linkedin_geo_id or the lane uses free text' };
      } catch (e) { res[key] = { error: e.message }; }
    }
    writeCache(cache);
    // Persist the local id into the profile so every lane (and a cache wipe) agrees on it.
    let profile = null;
    const localId = local ? res[norm(local)]?.id : '';
    if (localId && !String(l.linkedin_geo_id || '').trim()) {
      try {
        const r = setProfileGeoId(readFileSync(PROFILE_PATH, 'utf8'), String(localId));
        if (r.changed) { writeFileSync(PROFILE_PATH, r.text); profile = { wrote: PROFILE_PATH, linkedin_geo_id: String(localId) }; }
      } catch (e) { profile = { error: e.message }; }
    }
    loadTargets({ fresh: true });
    console.log(JSON.stringify({ resolved: res, profile, geos: liSearchGeos() }, null, 2));
    process.exit(Object.values(res).some((r) => r.error) ? 1 : 0);
  }
  console.log(JSON.stringify({ geo_id: liGeoId(), param: liGeoParam(), geos: liSearchGeos(), cache: GEO_CACHE }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await cli();

export { areaLabel };
