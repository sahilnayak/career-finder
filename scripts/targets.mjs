#!/usr/bin/env node
/**
 * targets.mjs — the ONE place every lane learns WHAT roles and WHERE.
 *
 * Nothing about roles or geography is hard-coded in career-finder. Every title keyword, negative,
 * city and remote rule is read from config/profile.yml, which onboarding writes from the user's
 * resume (and the user confirms). Scripts import from here (or from role-filters.mjs, which
 * delegates here) instead of carrying their own regexes, so lanes cannot drift apart.
 *
 * Contract (config/profile.yml):
 *   targets:  { roles[], title_keywords[], title_negatives[], primary_role, seniority }
 *   location: { metro, city, state, country, lat, lng, radius_mi, linkedin_geo_id,
 *               remote_policy: onsite|hybrid|remote-country|any, cities[] }
 *   pipeline: { qualify_score, daily_quota, primary_quota, window_hours }
 *   outreach: { bridge, default_bullets[], sender_name, sender_email }
 *
 * Title semantics (ported from career-ops):
 *   - A title is POSITIVE when it contains any targets.roles or targets.title_keywords phrase.
 *   - A negative (title_negatives) drops a title only when NO positive is present
 *     ("negatives are neutralized by a positive"), so a vendor/domain word in a genuine
 *     target title cannot kill it.
 *   - A negative written with a leading "!" (e.g. "!director") is a HARD gate: it always drops,
 *     positive or not. Use it for level gates (director, vp, intern...).
 *
 * Location semantics: classifyLocation() is a tri-state-plus: 'local' | 'remote' | 'elsewhere' |
 * 'unknown'. 'unknown' (e.g. "Hybrid", "Acme HQ") proves nothing and must never be treated as a
 * pass: callers fall back to another source or drop it.
 *
 * Missing profile: loadTargets() throws a TargetsMissingError whose message tells the user to run
 * onboarding. CLI scripts should call requireTargets(), which prints that message and exits 1.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_PATH = process.env.CAREER_FINDER_PROFILE || resolve(ROOT, 'config/profile.yml');

export const ONBOARDING_MSG =
  `career-finder is not set up: ${PROFILE_PATH} is missing or has no targets.roles.\n` +
  `Run onboarding first (in Claude Code: "set me up" / the career-finder-onboarding skill), ` +
  `or copy config/profile.example.yml to config/profile.yml and fill it in.`;

export class TargetsMissingError extends Error {
  constructor(msg = ONBOARDING_MSG) { super(msg); this.name = 'TargetsMissingError'; }
}

const DEFAULTS = Object.freeze({
  targets: {
    roles: [], title_keywords: [], title_negatives: [], primary_role: '', seniority: '',
    include_management: null, dealbreakers: [],
  },
  location: {
    metro: '', city: '', state: '', country: '', lat: null, lng: null, radius_mi: 50,
    linkedin_geo_id: '', remote_policy: 'onsite', cities: [], timezone: '',
  },
  pipeline: {
    qualify_score: 4.3, daily_quota: 3, primary_quota: 1, window_hours: 24,
    scan_window_days: 7, hiringcafe_days: 7, max_yoe_over: 2,
  },
  integrations: { linkedin: true, gmail: false },
  outreach: { bridge: '', default_bullets: [], sender_name: '', sender_email: '' },
});

const REMOTE_POLICIES = new Set(['onsite', 'hybrid', 'remote-country', 'any']);

let cache = null;

function arr(v) {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean);
}

/** Reset the memoized profile (tests, or after onboarding rewrites the file). */
export function resetTargets() { cache = null; }

/** True when a usable profile exists. Never throws. */
export function hasTargets() {
  try { loadTargets(); return true; } catch { return false; }
}

/**
 * Load the whole profile with defaults filled for the four contract blocks. Other blocks
 * (candidate, narrative, compensation, ...) are passed through untouched.
 * Throws TargetsMissingError when the file is absent or targets.roles is empty.
 */
export function loadTargets({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  if (!existsSync(PROFILE_PATH)) throw new TargetsMissingError();
  let raw;
  try { raw = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {}; }
  catch (e) { throw new TargetsMissingError(`${PROFILE_PATH} is not valid YAML: ${e.message}`); }

  const t = { ...DEFAULTS.targets, ...(raw.targets || {}) };
  t.roles = arr(t.roles);
  t.title_keywords = arr(t.title_keywords);
  t.title_negatives = arr(t.title_negatives);
  t.primary_role = String(t.primary_role || t.roles[0] || '').trim();
  t.seniority = String(t.seniority || '').trim();
  if (!t.roles.length) throw new TargetsMissingError();
  t.dealbreakers = arr(t.dealbreakers).map(s => s.toLowerCase());
  t.include_management = t.include_management == null || t.include_management === ''
    ? t.roles.some(r => MGMT_WORDS.test(r))
    : t.include_management === true || /^(true|yes|1)$/i.test(String(t.include_management));

  const l = { ...DEFAULTS.location, ...(raw.location || {}) };
  for (const k of ['metro', 'city', 'state', 'country', 'linkedin_geo_id', 'timezone']) l[k] = String(l[k] ?? '').trim();
  l.cities = arr(l.cities);
  l.radius_mi = Number(l.radius_mi) || DEFAULTS.location.radius_mi;
  l.lat = l.lat == null || l.lat === '' ? null : Number(l.lat);
  l.lng = l.lng == null || l.lng === '' ? null : Number(l.lng);
  l.remote_policy = String(l.remote_policy || 'onsite').toLowerCase();
  if (!REMOTE_POLICIES.has(l.remote_policy)) l.remote_policy = 'onsite';

  const p = { ...DEFAULTS.pipeline, ...(raw.pipeline || {}) };
  for (const k of Object.keys(DEFAULTS.pipeline)) {
    const n = Number(p[k]);
    // max_yoe_over may legitimately be 0; every other pipeline number must be positive.
    p[k] = Number.isFinite(n) && (n > 0 || (k === 'max_yoe_over' && n === 0 && p[k] !== '')) ? n : DEFAULTS.pipeline[k];
  }

  const ig = { ...DEFAULTS.integrations, ...(raw.integrations || {}) };
  for (const k of Object.keys(ig)) if (typeof ig[k] !== "number" && !/^\d+$/.test(String(ig[k]))) ig[k] = ig[k] === true || /^(true|yes|1)$/i.test(String(ig[k])); else ig[k] = Number(ig[k]);

  const cand = { ...(raw.candidate || {}) };
  const yrs = Number(cand.years);
  cand.years = cand.years == null || cand.years === '' || !Number.isFinite(yrs) ? null : yrs;

  const o = { ...DEFAULTS.outreach, ...(raw.outreach || {}) };
  o.default_bullets = arr(o.default_bullets);
  o.sender_name = String(o.sender_name || raw.candidate?.full_name || '').trim();
  o.sender_email = String(o.sender_email || raw.candidate?.email || '').trim();

  cache = { ...raw, candidate: cand, targets: t, location: l, pipeline: p, outreach: o, integrations: ig };
  return cache;
}

/** CLI guard: return the profile, or print the onboarding message and exit (1 by default). */
export function requireTargets(exitCode = 1) {
  try { return loadTargets(); }
  catch (e) {
    if (e instanceof TargetsMissingError) { console.error(e.message); process.exit(exitCode); }
    throw e;
  }
}

// ── Regex building ─────────────────────────────────────────────────────────────────────────

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as a forgiving pattern: whitespace/hyphen-insensitive, word-bounded. */
function phrase(p) {
  const body = esc(p.toLowerCase().trim()).replace(/(\\-|\s)+/g, '[\\s\\-/]*');
  return `(?<![a-z0-9])${body}(?![a-z0-9])`;
}
const NEVER = /(?!)/;
const MGMT_WORDS = /\b(manager|director|lead|head)\b/i;
// Entry-level markers, dropped for experienced candidates (candidate.years >= 3).
const ENTRY_LEVEL = /(?<![a-z0-9])(intern(ship)?s?|early[\s-]*career|new[\s-]*grad(uate)?s?|associate|level[\s-]*(i|1))(?![a-z0-9])|\s(i|1)\s*$/i;
function anyOf(list) {
  const parts = list.filter(Boolean).map(phrase);
  return parts.length ? new RegExp(parts.join('|'), 'i') : NEVER;
}

function compiled() {
  const p = loadTargets();
  if (p.__compiled) return p.__compiled;
  const t = p.targets;
  const hard = t.title_negatives.filter(n => n.startsWith('!')).map(n => n.slice(1));
  const soft = t.title_negatives.filter(n => !n.startsWith('!'));
  const c = {
    positive: anyOf([...t.roles, ...t.title_keywords]),
    roles: anyOf(t.roles),
    entryRoles: t.roles.filter(r => ENTRY_LEVEL.test(` ${r}`)),
    dealbreaker: anyOf(t.dealbreakers),
    soft: anyOf(soft),
    hard: anyOf(hard),
    primary: anyOf([t.primary_role]),
    local: anyOf(localKeys(p.location)),
  };
  Object.defineProperty(p, '__compiled', { value: c, enumerable: false });
  return c;
}

/** Regex matching any positive role / keyword phrase (matches nothing when unconfigured). */
export function positiveRegex() { return compiled().positive; }
/** Regex matching any soft negative. */
export function negativeRegex() { return compiled().soft; }
/** Regex matching any hard ("!"-prefixed) negative. */
export function hardNegativeRegex() { return compiled().hard; }
/** Regex matching the primary role phrase. */
export function primaryRegex() { return compiled().primary; }

/**
 * Title variants to test: the title itself plus its comma-inverted form, so "Manager, Nursing"
 * also reads as "Nursing Manager" and "Engineer, Data" as "Data Engineer".
 */
export function titleVariants(title) {
  const s = String(title || '').trim();
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  return m ? [s, `${m[2].trim()} ${m[1].trim()}`] : [s];
}
const anyVariant = (re, title) => titleVariants(title).some(v => re.test(v));

// ── Token-set role matching ─────────────────────────────────────────────
// A role phrase matches a title when all its tokens appear (a) inside ONE comma/dash/paren
// segment of the title in any order, or (b) in order in the comma-inverted form with at most
// two qualifier words between consecutive tokens. So "Manager, Clinical Nursing" and
// "Assistant Nurse Manager" read as nursing/nurse manager, while
// "Senior Software Engineer, Data Platform" does NOT match "data engineer" (data and engineer
// sit in different segments, three words apart) unless title_keywords include "data platform".
const tok = s => String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const tokEq = (a, b) => a === b || (a.length > 3 && (a === b + 's' || b === a + 's'));
function phraseTokensMatch(phraseStr, title) {
  const want = tok(phraseStr);
  if (!want.length) return false;
  const segs = String(title || '').split(/[,|()\[\]:;]|\s[-–—\/]\s/);
  for (const seg of segs) {
    const have = tok(seg);
    if (want.every(w => have.some(h => tokEq(h, w)))) return true;
  }
  for (const v of titleVariants(title)) {
    const have = tok(v);
    for (let start = 0; start < have.length; start++) {
      if (!tokEq(have[start], want[0])) continue;
      let pos = start, ok = true;
      for (let k = 1; k < want.length && ok; k++) {
        let found = -1;
        for (let j = pos + 1; j <= Math.min(have.length - 1, pos + 3); j++) if (tokEq(have[j], want[k])) { found = j; break; }
        if (found < 0) ok = false; else pos = found;
      }
      if (ok) return true;
    }
  }
  return false;
}
/** True when any phrase in the list matches the title (regex first, then token-set). */
function phrasesMatch(list, re, title) {
  return anyVariant(re, title) || list.some(p => phraseTokensMatch(p, title));
}

/** Remove management words from a string (for re-testing a negative without them). */
const stripMgmt = s => s.replace(new RegExp(MGMT_WORDS.source, 'gi'), ' ');

/** True when the title should be dropped before scoring. */
export function titleDropped(title) {
  const s = String(title || '');
  const p = loadTargets();
  const c = compiled();
  const isRole = phrasesMatch(p.targets.roles, c.roles, s);
  // Management titles survive when the user wants management, or when the title IS a target role.
  const mgmtOk = p.targets.include_management || isRole;
  const hit = re => titleVariants(s).some(v => re.test(mgmtOk ? stripMgmt(v) : v));
  if (hit(c.hard)) return true;
  if (entryLevelDropped(s)) return true;
  if (!hit(c.soft)) return false;
  return !phrasesMatch([...p.targets.roles, ...p.targets.title_keywords], c.positive, s);
}

/** Entry-level title for an experienced candidate (years >= 3), unless a target role is entry-level. */
function entryLevelDropped(s) {
  const yrs = loadTargets().candidate.years;
  if (yrs == null || yrs < 3) return false;
  if (!titleVariants(s).some(v => ENTRY_LEVEL.test(v))) return false;
  const c = compiled();
  return !c.entryRoles.some(r => anyOf([r]).test(s));
}

/** True when the title is on-target: has a positive and is not dropped. */
export function titleMatches(title) {
  const s = String(title || '');
  const t = loadTargets().targets;
  return phrasesMatch([...t.roles, ...t.title_keywords], compiled().positive, s) && !titleDropped(s);
}

/** True when the title is the user's primary role (the one the primary_quota counts). */
export function isPrimaryRole(title) {
  const t = loadTargets().targets;
  return phrasesMatch(t.primary_role ? [t.primary_role] : [], compiled().primary, String(title || '')) && !titleDropped(title);
}

/** The first dealbreaker word found in company + title (case-insensitive substring), or null. */
export function dealbreakerHit(company = '', title = '') {
  const hay = `${company} ${title}`.toLowerCase();
  return loadTargets().targets.dealbreakers.find(w => hay.includes(w)) || null;
}

/** True when a posting's minimum years of experience exceeds candidate.years + pipeline.max_yoe_over. */
export function yoeTooHigh(minYoe) {
  const p = loadTargets();
  const n = Number(minYoe);
  if (minYoe == null || minYoe === '' || !Number.isFinite(n) || p.candidate.years == null) return false;
  return n > p.candidate.years + p.pipeline.max_yoe_over;
}

/** IANA timezone: location.timezone, else CAREER_FINDER_TZ, else the system zone. */
export function timezone() {
  let tz = '';
  try { tz = loadTargets().location.timezone; } catch { /* not set up */ }
  return tz || process.env.CAREER_FINDER_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Phrases to send to keyword searches (LinkedIn, HiringCafe, ...): the configured roles. */
export function searchKeywords() { return loadTargets().targets.roles.map(r => r.toLowerCase()); }

// ── Location ───────────────────────────────────────────────────────────────────────────────

const US_STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
  il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
  nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas',
  ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia',
  wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
};

/** Local-area keys: configured cities + city + metro. The state alone is NOT local (too wide). */
function localKeys(l) {
  return [...new Set([...l.cities, l.city, l.metro].map(s => s.toLowerCase().trim()).filter(Boolean))];
}

const REMOTE_WORDS = /\b(remote|anywhere|distributed|work from home|wfh|telecommute)\b/i;

const COUNTRY_ALIASES = {
  'united states': ['united states', 'usa', 'u.s.', 'us', 'america', 'americas', 'amer', 'nationwide'],
  'canada': ['canada', 'canadian'],
  'united kingdom': ['united kingdom', 'uk', 'england', 'britain', 'great britain'],
  'india': ['india'],
  'germany': ['germany', 'deutschland', 'dach'],
  'australia': ['australia', 'anz'],
};
const REGIONS = ['emea', 'apac', 'latam', 'dach', 'benelux', 'nordics', 'nordic', 'mena', 'middle east',
  'europe', 'asia', 'africa', 'worldwide', 'globally', 'anywhere in the world', 'international'];
const COUNTRIES = ['united states', 'usa', 'canada', 'united kingdom', 'uk', 'ireland', 'germany', 'austria',
  'switzerland', 'france', 'spain', 'portugal', 'italy', 'poland', 'netherlands', 'belgium', 'sweden',
  'norway', 'denmark', 'finland', 'israel', 'uae', 'saudi', 'india', 'singapore', 'japan', 'korea',
  'china', 'hong kong', 'australia', 'new zealand', 'brazil', 'mexico', 'philippines', 'argentina',
  'colombia', 'south africa', 'romania', 'dubai', 'czech republic', 'czechia', 'hungary', 'ukraine',
  'turkey', 'egypt', 'nigeria', 'kenya', 'vietnam', 'indonesia', 'malaysia', 'thailand', 'pakistan',
  'chile', 'peru', 'greece', 'lithuania', 'estonia', 'latvia', 'bulgaria', 'serbia', 'croatia',
  'slovakia', 'slovenia', 'costa rica', 'uruguay', 'taiwan'];

function countryAliases(country) {
  const c = country.toLowerCase();
  for (const [k, v] of Object.entries(COUNTRY_ALIASES)) if (k === c || v.includes(c)) return v;
  return c ? [c] : [];
}

/**
 * Classify a location string: 'local' | 'remote' | 'elsewhere' | 'unknown'.
 * 'unknown' = the string names no place ("Hybrid", "On-site", "Acme HQ", empty).
 */
export function classifyLocation(loc) {
  const s = String(loc || '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (REMOTE_WORDS.test(s)) return 'remote';
  if (compiled().local.test(s)) return 'local';
  if (/^(hybrid|on.?site|in.office|flexible|various|multiple locations?|n\/?a|tbd|-+)$/i.test(s)) return 'unknown';
  if (/\b(hq|headquarters|head office|main office)\b/i.test(s) && !/,/.test(s)) return 'unknown';
  return 'elsewhere';
}

/**
 * May we keep this REMOTE posting? Depends only on location.remote_policy:
 *   onsite | hybrid  -> never
 *   any              -> always
 *   remote-country   -> only if nothing names a foreign country/region, and when specific
 *                       states are enumerated as the eligibility area, the user's state is one.
 * `title` is accepted for API compatibility and checked for foreign geography (titles like
 * "Data Engineer - EMEA" often carry the region the location field omits).
 */
export function remoteAllowed(loc, title = '') {
  const { location: l } = loadTargets();
  if (l.remote_policy === 'any') return true;
  if (l.remote_policy !== 'remote-country') return false;
  const both = `${title} ${loc}`.toLowerCase();
  const mine = new Set(countryAliases(l.country || 'united states'));
  const foreign = [...REGIONS, ...COUNTRIES].filter(x => !mine.has(x) && !(mine.has('united states') && x === 'americas'));
  if (foreign.length && anyOf(foreign).test(both)) return false;
  // Enumerated US states as the eligibility area: the user's state must be among them.
  const isUS = mine.has('united states');
  if (isUS && l.state) {
    const st = l.state.toLowerCase();
    const myState = US_STATES[st] || st;
    const named = Object.values(US_STATES).filter(n => new RegExp(`\\b${esc(n)}\\b`, 'i').test(String(loc)));
    if (named.length && !named.includes(myState)) return false;
  }
  return true;
}

/**
 * The boolean location gate: local onsite/hybrid passes; remote passes per remote_policy;
 * elsewhere and unknown fail (callers wanting a fallback should use classifyLocation()).
 */
/** True when a local-matching string pins a DIFFERENT US state than the profile's, e.g. metro
 *  "Albany, NY" vs "US-GA-Albany" or "Albany, GA". City-name matching alone let those through. */
function namesOtherUsState(s) {
  const { location: l } = loadTargets();
  if (!l.state) return false;
  const st = l.state.toLowerCase().trim();
  const mine = US_STATES[st] ? st : Object.keys(US_STATES).find(k => US_STATES[k] === st);
  if (!mine) return false;
  const codes = [...String(s).matchAll(/\bUS-([A-Z]{2})\b|,\s*([A-Z]{2})\b(?!\w)/g)].map(m => (m[1] || m[2]).toLowerCase())
    .filter(c => US_STATES[c]);
  return codes.length > 0 && !codes.includes(mine);
}

export function locationMatches(locStr, title = '') {
  const s = String(locStr || '');
  const parts = s.split(/\s*[;|]\s*|\s+or\s+/i).filter(Boolean);
  if (parts.length > 1) {
    // onsite/hybrid: a Remote segment makes the posting ambiguous ("Houston; Remote"). Keep it only
    // when a LOCAL segment explicitly says onsite/hybrid.
    const { remote_policy } = loadTargets().location;
    if ((remote_policy === 'onsite' || remote_policy === 'hybrid') && parts.some(p => classifyLocation(p) === 'remote')) {
      return parts.some(p => compiled().local.test(p.toLowerCase()) && /\b(hybrid|on[\s-]?site|in[\s-]office)\b/i.test(p) && !REMOTE_WORDS.test(p));
    }
    // Otherwise a multi-location string ("Chicago, IL; Remote (US)") passes if ANY segment passes.
    // The whole string rides along as context so "Dubai | Remote job" cannot pass on the bare
    // "Remote job" segment once the split has separated it from its country.
    return parts.some(p => locationMatches(p, `${title} ${s}`));
  }
  const c = classifyLocation(s);
  if (c === 'local') return !namesOtherUsState(s);
  if (c === 'remote') return remoteAllowed(s, title);
  return false;
}

/**
 * Structured workplace field (ATS workplaceType / HiringCafe workplace): 'remote' passes only under
 * remote-country/any; 'hybrid' fails only under onsite; onsite/unknown values pass (the location
 * string still decides).
 */
export function workplaceAllowed(workplaceType) {
  const w = String(workplaceType || '').toLowerCase().replace(/[\s_-]+/g, '');
  const { remote_policy } = loadTargets().location;
  if (w.includes('remote')) return remote_policy === 'remote-country' || remote_policy === 'any';
  if (w.includes('hybrid')) return remote_policy !== 'onsite';
  return true;
}

/** Human label for the search area, for logs and prompts. */
export function areaLabel() {
  const { location: l } = loadTargets();
  return l.metro || [l.city, l.state].filter(Boolean).join(', ') || l.country || '(unset)';
}

// CLI: `node scripts/targets.mjs` prints the resolved profile blocks; `--test "<title>" ["<loc>"]`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Exit 2 = not set up; with --test, exit 1 = the title or location fails, or a dealbreaker hits.
  const p = requireTargets(2);
  const i = process.argv.indexOf('--test');
  if (i > -1) {
    const title = process.argv[i + 1] || '', loc = process.argv[i + 2] || '';
    const ci = process.argv.indexOf('--company');
    const company = ci > -1 ? process.argv[ci + 1] || '' : '';
    const v = { title, loc, company, titleMatches: titleMatches(title), titleDropped: titleDropped(title),
      isPrimaryRole: isPrimaryRole(title), location: classifyLocation(loc), locationMatches: locationMatches(loc, title),
      dealbreaker: dealbreakerHit(company, title) };
    console.log(JSON.stringify(v, null, 2));
    if (!v.titleMatches || !v.locationMatches || v.dealbreaker) process.exitCode = 1;
  } else {
    const { targets, location, pipeline, outreach, integrations } = p;
    console.log(JSON.stringify({ targets, location, pipeline, outreach, integrations, timezone: timezone() }, null, 2));
  }
}
