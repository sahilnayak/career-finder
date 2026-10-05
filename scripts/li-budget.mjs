#!/usr/bin/env node

/**
 * li-budget.mjs — one shared LinkedIn action budget for every script in this repo.
 *
 * Before 2026-07-25 there were two disconnected counters: the linkedin-stealth
 * skill's pace.mjs (usage-*.json, agent-facing) and
 * scan-roster.mjs's private data/_roster-budget.json. Neither knew about the
 * other, so an agent could burn the "daily" budget in the browser and a script
 * run would still spend a full separate allowance against the same account.
 *
 * This module makes pace.mjs the single source of truth: caps and the counter
 * file both come from the skill. If the skill isn't installed, it degrades to a
 * local counter with the same caps so the scripts still refuse to run unbounded.
 *
 * Usage:
 *   import { spend, check, pause, CAPS } from './li-budget.mjs';
 *   const b = spend('profile');        // charge one profile view
 *   if (!b.ok) stopForToday();          // at/over cap
 *   await pause('profile');             // jittered human delay
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// An external pace module is opt-in only (CAREER_FINDER_PACE=/path/pace.mjs). Never auto-load a
// global skill: it would share another account's counters with this fork.
const SKILL_PACE = process.env.CAREER_FINDER_PACE || '';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = join(REPO, 'data/li-events.tsv');
const COOLDOWN = join(REPO, 'data/LI_COOLDOWN');

let impl = null;
try {
  if (SKILL_PACE && existsSync(SKILL_PACE)) impl = await import(`file://${SKILL_PACE}`);
} catch {
  impl = null; // fall through to the local mirror below
}

// ── The ONE jobsearch cap ────────────────────────────────────────────────────────────────
// Derived from the morning workload instead of a hand-picked number, so the cap tracks the
// profile. Per role (max 4 roles): the crawl's pages (pipeline.linkedin_pages, default 2, 1-4)
// + 1 faceted + 1 semantic search, + 1 remote faceted search when remote_policy is
// remote-country/any. Budget = 2x that (one full re-run of the morning) + 20 tier-3 Apply-href
// rescues. Default profile (2 pages, onsite): 4 x (2+2) = 16 -> 2*16 + 20 = 52/day.
// Both FALLBACK_CAPS.jobsearch and HORIZONS.jobsearch.day read this constant; never set either
// by hand. Documented in config/profile.example.yml (integrations.linkedin_pages).
export const JOBSEARCH_ROLES = 4;
export const JOBSEARCH_RESCUES = 20;
export function jobsearchDailyCap({ pages = 2, remote = false } = {}) {
  const p = Math.min(4, Math.max(1, Number(pages) || 2));
  const perRole = p + 2 + (remote ? 1 : 0);
  return 2 * JOBSEARCH_ROLES * perRole + JOBSEARCH_RESCUES;
}
function profileJobsearchInputs() {
  try {
    const path = process.env.CAREER_FINDER_PROFILE || join(REPO, 'config/profile.yml');
    const raw = yaml.load(readFileSync(path, 'utf8')) || {};
    const pages = raw.pipeline?.linkedin_pages ?? raw.integrations?.linkedin_pages;
    const pol = String(raw.location?.remote_policy || '').toLowerCase();
    return { pages, remote: pol === 'remote-country' || pol === 'any' };
  } catch { return {}; }
}
export const JOBSEARCH_DAY_CAP = jobsearchDailyCap(profileJobsearchInputs());

// Fallback caps — kept identical to pace.mjs on purpose. If you change one,
// change both, or better: install the skill so there is only one.
const FALLBACK_CAPS = {
  pageview: 400, profile: 12, search: 12, jobsearch: JOBSEARCH_DAY_CAP,
  connect: 6, message: 8, page: 40, guest: 2000,
};
const FALLBACK_DELAYS = {
  pageview: [4, 11], page: [4, 11], profile: [6, 16], search: [8, 20], jobsearch: [6, 15],
  scroll: [1.2, 4.5], connect: [25, 70], message: [30, 90],
  guest: [3, 9], default: [3, 9],
};
// Kinds that do NOT count against the logged-in `pageview` superset.
const OFF_ACCOUNT = new Set(['pageview', 'page', 'guest']);

// Usage counters live in the repo (data/li-usage/), so a fork never shares counters with another
// account's home-dir state. CAREER_FINDER_LI_DIR overrides (tests, sandbox copies).
export const USAGE_DIR = process.env.CAREER_FINDER_LI_DIR || join(REPO, 'data/li-usage');
const DIR = USAGE_DIR;
// LOCAL day, matching pace.mjs:81. This used to be `toISOString().slice(0,10)` (UTC),
// so whenever the skill was missing the fallback counter and the skill counter
// disagreed by 7-8h and a run could double-spend across the boundary.
const day = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const file = () => join(DIR, `usage-${day()}.json`);

function loadLocal() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}
function saveLocal(o) {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(file(), JSON.stringify(o, null, 2)); } catch { /* best effort */ }
}

export const CAPS = impl?.CAPS ?? FALLBACK_CAPS;

/** Charge n actions of `kind`. Returns {used, cap, ok, remaining}; ok:false = STOP. */
export function spend(kind = 'pageview', n = 1) {
  if (impl?.spend) return impl.spend(kind, n);
  const s = loadLocal();
  s[kind] = (s[kind] || 0) + n;
  if (!OFF_ACCOUNT.has(kind)) s.pageview = (s.pageview || 0) + n;
  saveLocal(s);
  const cap = CAPS[kind] ?? Infinity;
  return { kind, used: s[kind], cap, ok: s[kind] < cap, remaining: Math.max(0, cap - s[kind]) };
}

/** Read-only check. ok:false = at/over cap. */
export function check(kind = 'pageview') {
  if (impl?.check) return impl.check(kind);
  const s = loadLocal();
  const cap = CAPS[kind] ?? Infinity;
  const used = s[kind] || 0;
  return { kind, used, cap, ok: used < cap, remaining: Math.max(0, cap - used) };
}

// ── Multi-horizon caps (2026-07-25) ──────────────────────────────────────
//
// The old model had exactly ONE horizon: a calendar day with a hard midnight
// reset, which permits 2x the daily cap inside a 20-minute window straddling
// midnight and says nothing at all about a week or a month. LinkedIn's own
// limits are multi-horizon (the Commercial Use Limit is monthly and resets on
// the 1st; the invitation limit is ~100/week), so ours have to be too.
//
// Numbers are POLICY, not measurement -- nobody can calibrate these without
// deliberately probing for the block, which is the one experiment we must never
// run. They are sized to the confirmed workload (2-3 companies/day at ~3
// searches + 0-2 profile visits each) with roughly 3x headroom for the user's
// own interactive browsing.
//
// TIER: the user confirmed **LinkedIn Premium** on 2026-07-26 (recorded in
// config/profile.yml -> linkedin.tier, which is the durable fact; this comment is
// a pointer, not the source). Premium substantially relaxes the Commercial Use
// Limit, so `search` is NOT the scarce lane here and `month` is a monitoring
// counter rather than a hard CUL proxy.
//
// FREE-TIER FALLBACK -- restore these the day the subscription lapses, because on
// free tier the CUL is the binding constraint on the whole design:
//   search: { day: 8, week: 30, month: 120 }
//
// Note the day cap is what actually binds either way: the confirmed workload is
// 2-3 companies/day at ~3 searches each (~9/day), so `day: 12` is the real limit
// and the monthly figure would only bite during an unusual catch-up burst.
export const HORIZONS = {
  // PEOPLE search — the lane the Commercial Use Limit actually meters.
  search:  { day: 12, week: 50, month: 350 },
  // JOB search — a DIFFERENT LinkedIn surface, deliberately split out 2026-07-27.
  // The CUL is scoped to People Search; job search has no published commercial limit, and
  // browsing job listings is the single most ordinary thing a logged-in job seeker does.
  // Charging job-search crawls against the people-search lane conflated the two and blocked
  // `linkedin-crawl.mjs` — the ONLY lane that has ever produced an ATS-verified job — at
  // 12/12 while the people lane had done no people searching at all that day.
  // Still an ACCOUNT lane: it counts toward BURST_PER_HOUR and trips the same cooldowns.
  // Capped conservatively despite the lower risk; raise only on evidence, never to hit a number.
  jobsearch: { day: JOBSEARCH_DAY_CAP, week: JOBSEARCH_DAY_CAP * 7 },  // single source: jobsearchDailyCap() above
  profile: { day: 12, week: 45 },
  connect: { day: 6,  week: 25 },   // 15/day exceeded the daily equivalent (~14.3)
  message: { day: 8,  week: 25 },   //   of the reported ~100/week invite limit
  pageview: { day: 40 },
  guest:   { day: 200 },
};
// Max charged actions in any rolling 60 minutes, across every account lane.
// The per-run cap in scan-roster.mjs is per-PROCESS, and drain-outreach.mjs
// spawns one process per company in a loop -- so three companies was ~45 visits
// in ~25 minutes with nothing structurally able to see it. Only a shared
// rolling-window counter can. (The 2026-06-17 flag was 246 profiles in ~1h.)
// LOWERED 40 -> 15 on 2026-08-20. Once `jobsearch` was split onto its own low-risk window,
// the ACCOUNT lanes' daily caps summed to 38 (search 12 + profile 12 + connect 6 + message 8),
// i.e. strictly below 40 -- so this window could never fire and was dead code. That is worse
// than no guardrail, because the whole day's 38 account actions could legally be spent inside
// five minutes, which is exactly the burst shape that earned the 2026-06-17 flag. 15/hour still
// clears the largest single legitimate job (a 12-visit contact-discovery pass) while forcing a
// day's work to spread. test-li-safety.mjs asserts this window actually refuses.
// Raising this is never the fix; lowering it is always safe.
export const BURST_PER_HOUR = 15;
// SPLIT OUT 2026-08-20 (user: "remove the linkedin search limits for finding jobs"). `jobsearch` is
// PUBLIC JOB-LISTING page loads — the lowest-risk lane there is, and a behaviour LinkedIn expects
// (people page through job results). It was sharing the 40/hr burst with profile/connect/message,
// so a 7-keyword x 8-page crawl (56 loads) died at 40 mid-run and left the result set unsearched.
// Job listings now get their own hourly ceiling; the ENUMERATION lanes that actually trip
// anti-automation (profile visits, connects, DMs, people-search) keep the untouched 40 between
// them. Jittered human delays still pace every single call.
export const BURST_PER_HOUR_JOBSEARCH = 300;
export const LOW_RISK_LANES = new Set(['jobsearch']);  // 10x-request 2026-07-29: raised 12 -> 40 so a multi-keyword job crawl is not throttled to one keyword/hour. Jitter delays still pace each call.

const ACCOUNT_LANES = new Set(['profile', 'search', 'jobsearch', 'connect', 'message', 'pageview', 'page']);

/** Append one row to data/li-events.tsv. Append-only telemetry; never read at runtime except by horizons(). */
export function logEvent({ kind, status = '', note = '' } = {}) {
  try {
    mkdirSync(dirname(EVENTS), { recursive: true });
    appendFileSync(EVENTS, [new Date().toISOString(), kind, status, note].join('\t') + '\n');
  } catch { /* telemetry must never break a run */ }
}

function readEvents(sinceMs) {
  if (!existsSync(EVENTS)) return [];
  const out = [];
  try {
    for (const line of readFileSync(EVENTS, 'utf8').split('\n')) {
      if (!line) continue;
      const [ts, kind] = line.split('\t');
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t >= sinceMs) out.push({ t, kind });
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Rolling-window + calendar-month usage for `kind`.
 * Returns { day, week, month, hourAll, caps, ok, blocked } where `blocked` names
 * the horizon that is exhausted (null if none).
 */
export function horizons(kind = 'profile') {
  const caps = HORIZONS[kind] || {};
  const now = Date.now();
  const week = readEvents(now - 7 * 864e5).filter(e => e.kind === kind).length;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const month = readEvents(monthStart.getTime()).filter(e => e.kind === kind).length;
  const recent = readEvents(now - 3600e3);
  // Enumeration lanes share the strict burst; job-listing loads are metered separately.
  const hourAll = recent.filter(e => ACCOUNT_LANES.has(e.kind) && !LOW_RISK_LANES.has(e.kind)).length;
  const hourJob = recent.filter(e => LOW_RISK_LANES.has(e.kind)).length;
  const dayUsed = check(kind).used;

  let blocked = null;
  if (caps.day != null && dayUsed >= caps.day) blocked = 'day';
  else if (caps.week != null && week >= caps.week) blocked = 'week';
  else if (caps.month != null && month >= caps.month) blocked = 'month';
  else if (LOW_RISK_LANES.has(kind) && hourJob >= BURST_PER_HOUR_JOBSEARCH) blocked = 'hour';
  else if (ACCOUNT_LANES.has(kind) && !LOW_RISK_LANES.has(kind) && hourAll >= BURST_PER_HOUR) blocked = 'hour';
  return { kind, day: dayUsed, week, month, hourAll, hourJob, caps, blocked, ok: !blocked };
}

// ── Circuit breaker ──────────────────────────────────────────────────────
//
// Before this, the ONLY response to LinkedIn pushback was to retry: visitProfile
// re-requested on 999/429 up to 3x. 999 is LinkedIn saying stop, so answering it
// with three more requests is an anti-circuit-breaker. And because
// drain-outreach.mjs spawns a fresh process per company, an in-memory backoff
// taught company #2 nothing -- the cooldown has to be PERSISTED to be real.
// Lives in the repo (alongside data/li-usage/) so the crons and every script
// see the same sentinel, exactly like data/LINKEDIN_OFF.

/** Trip the breaker: block all LinkedIn lanes for `hours`. */
export function cooldown(reason, hours = 6, lane = 'all') {
  const until = new Date(Date.now() + hours * 3600e3).toISOString();
  try {
    mkdirSync(dirname(COOLDOWN), { recursive: true });
    writeFileSync(COOLDOWN, JSON.stringify({ until, reason, lane, tripped_at: new Date().toISOString() }, null, 2));
  } catch { /* best effort */ }
  logEvent({ kind: 'cooldown', status: String(hours) + 'h', note: reason });
  return { until, reason, lane };
}

/** @returns {null|{until,reason,lane,remainingMs}} */
export function inCooldown() {
  if (!existsSync(COOLDOWN)) return null;
  try {
    const c = JSON.parse(readFileSync(COOLDOWN, 'utf8'));
    const remainingMs = Date.parse(c.until) - Date.now();
    if (!(remainingMs > 0)) { rmSync(COOLDOWN, { force: true }); return null; }  // expired: self-clear
    return { ...c, remainingMs };
  } catch { return null; }
}

/**
 * The one call every LinkedIn navigation must pass through.
 * Charges the budget BEFORE the action ("pay first, then act" -- a crash must not
 * hand back requests that already hit LinkedIn) and refuses when any horizon,
 * the burst window, or the cooldown says no.
 * @returns {{ok:boolean, reason?:string, used?:number, cap?:number}}
 */
export function claim(kind = 'profile', note = '') {
  const cd = inCooldown();
  if (cd) return { ok: false, reason: `cooldown until ${cd.until} (${cd.reason})` };
  const h = horizons(kind);
  if (!h.ok) {
    const isJobHour = h.blocked === 'hour' && LOW_RISK_LANES.has(kind);
    const used = h.blocked === 'hour' ? (isJobHour ? h.hourJob : h.hourAll) : h[h.blocked];
    const cap  = h.blocked === 'hour' ? (isJobHour ? BURST_PER_HOUR_JOBSEARCH : BURST_PER_HOUR) : h.caps[h.blocked];
    return { ok: false, reason: `${kind} ${h.blocked} cap reached (${used}/${cap})` };
  }
  const b = spend(kind);
  logEvent({ kind, status: 'spend', note });
  if (!b.ok) return { ok: false, reason: `${kind} day cap reached (${b.used}/${b.cap})`, ...b };
  return { ok: true, ...b };
}

/** Jittered human delay (ms) for `kind`. */
export function jitterMs(kind = 'pageview') {
  if (impl?.jitterMs) return impl.jitterMs(kind);
  const [lo, hi] = FALLBACK_DELAYS[kind] || FALLBACK_DELAYS.default;
  let secs = lo + Math.random() * (hi - lo);
  if (Math.random() < 0.12) secs += 8 + Math.random() * 22;
  return Math.round(secs * 1000);
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const pause = (kind = 'pageview') => sleep(jitterMs(kind));
export const usingSkill = !!impl;

// CLI: node scripts/li-budget.mjs status — a cap you cannot read is a cap you will blow.
// (Before 2026-08-18 invoking this file directly printed NOTHING; the counters were only
// reachable through pace.mjs, and the SessionStart banner's "40 profile visits/day" is the
// page-lane cap, not profiles.)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    if (impl?.status) console.log(JSON.stringify(impl.status(), null, 2));
    else {
      const out = {};
      for (const k of Object.keys(FALLBACK_CAPS)) { const h = horizons(k); out[k] = { used: h.day ?? 0, cap: FALLBACK_CAPS[k] }; }
      console.log(JSON.stringify({ source: 'fallback-mirror', usage: out, cooldown: inCooldown() || null }, null, 2));
    }
  } else {
    console.log('usage: node scripts/li-budget.mjs status');
  }
}
