#!/usr/bin/env node

/**
 * daily-quota.mjs — enforce the daily board policy, driven by config/profile.yml:
 *
 *   1. EVERY job on the board is score >= pipeline.qualify_score AND found within the last
 *      pipeline.window_hours.
 *   2. THE QUOTA: the board must hold AT LEAST pipeline.daily_quota such qualifiers, AND AT
 *      LEAST pipeline.primary_quota of them must be the PRIMARY role (targets.primary_role,
 *      tested with isPrimaryRole()). BOTH conditions gate the exit code. Set primary_quota: 0
 *      to make the primary-role requirement advisory only.
 *
 * Source of truth: data/scored-jobs.tsv — cols: date, company, role, score, verdict, why, url,
 * found_at, applied_at, [dismissed_at, aged]. Applied still counts as a qualifier found today;
 * dismissed is excluded.
 *
 * Usage:  node scripts/daily-quota.mjs [--json] [--hours N] [--min-count N]
 * Exit:   0 only if the board holds >= daily_quota qualifiers AND >= primary_quota primary roles.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { requireTargets, isPrimaryRole } from './targets.mjs';

const T = requireTargets();
const PRIMARY = T.targets.primary_role;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i !== -1 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg('--hours', T.pipeline.window_hours);
const MIN_COUNT = arg('--min-count', T.pipeline.daily_quota);
const PRIMARY_QUOTA = T.pipeline.primary_quota;
const JSON_OUT = process.argv.includes('--json');
const MIN = T.pipeline.qualify_score;
const NEAR = Math.max(0, MIN - 0.3);   // near-miss floor

// Same tolerant found_at parsing the Go dashboard uses (UTC Z, ±hh:mm, colon-less ±hhmm;
// fall back to the date column at local noon).
function parseFound(r) {
  const s = (r[7] || '').trim();
  if (s) { const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); if (!isNaN(t)) return t; }
  const d = Date.parse((r[0] || '') + 'T12:00:00');
  return isNaN(d) ? null : d;
}

/** 'primary' when the title is the configured primary role, else 'other'. */
export function archetype(role) { return isPrimaryRole(role || '') ? 'primary' : 'other'; }

const rows = existsSync('data/scored-jobs.tsv')
  ? readFileSync('data/scored-jobs.tsv', 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')).filter(r => r[0] !== 'date')
  : [];
const now = Date.now(), WIN = HOURS * 3600e3;

const board = rows
  .filter(r => parseFloat(r[3]) >= MIN)
  // AGED reqs are never board rows: their found_at is when they were SCORED, not posted.
  .filter(r => (r[4] || '').trim() !== 'aged')
  .filter(r => !(r[9] || '').trim())           // not dismissed
  .map(r => ({ co: r[1], role: r[2], score: r[3], applied: !!(r[8] || '').trim(), t: parseFound(r), arch: archetype(r[2]), url: r[6] }))
  .filter(x => x.t && now - x.t <= WIN);

const primary = board.filter(x => x.arch === 'primary');
const other = board.filter(x => x.arch === 'other');
const primaryOk = primary.length >= PRIMARY_QUOTA;
const countOk = board.length >= MIN_COUNT;
const met = countOk && primaryOk;
const needed = Math.max(0, MIN_COUNT - board.length);

// Near-miss surfacing: if the primary role is short, show the best recent primary near-miss
// (NEAR..MIN, last 7d) flagged below-bar. Never placed on the board.
const NEAR_DAYS = 7;
const userDismissed = r => !!(r[9] || '').trim() && (r[10] || '').trim() !== 'aged';
const primaryNear = rows
  .map(r => ({ co: r[1], role: r[2], score: parseFloat(r[3]), dis: userDismissed(r), t: parseFound(r), arch: archetype(r[2]) }))
  .filter(x => x.arch === 'primary' && x.score >= NEAR && x.score < MIN && !x.dis && x.t && now - x.t <= NEAR_DAYS * 864e5)
  .sort((a, b) => b.score - a.score);

// Live fallback: when the primary role is missing from the board, surface the freshest live
// qualifier of it from the last 7 days. Found_at is never re-stamped; the bar is untouched.
// A row auto-pruned for age carries 'aged' in col 11 and is still a live lead; only a user
// dismissal hides it.
const FALLBACK_DAYS = 7;
const fallbackPrimary = primaryOk ? null : rows
  .map(r => ({ co: r[1], role: r[2], score: parseFloat(r[3]), dis: userDismissed(r), aged: (r[4] || '').trim() === 'aged', t: parseFound(r), arch: archetype(r[2]), url: r[6] }))
  .filter(x => x.arch === 'primary' && x.score >= MIN && !x.dis && !x.aged && x.t && now - x.t <= FALLBACK_DAYS * 864e5)
  .filter(x => now - x.t > WIN)
  .sort((a, b) => b.t - a.t)[0] || null;
const fbJson = fb => fb && { company: fb.co, role: fb.role, score: fb.score, url: fb.url, ageDays: Math.round((now - fb.t) / 864e5) };

// Actionable top-up: the quota measures FRESH supply; the user still needs >= MIN_COUNT roles
// to act on. Top the surfaced list up from the still-live pool, newest first, age-labelled.
// The exit code stays driven by fresh count only.
const keyOf = x => x.url || `${x.co}|${x.role}`;
const shown = new Set([...board, fallbackPrimary].filter(Boolean).map(keyOf));
const topUp = rows
  .map(r => ({ co: r[1], role: r[2], score: parseFloat(r[3]), dis: userDismissed(r), t: parseFound(r), arch: archetype(r[2]), url: r[6] }))
  .filter(x => x.score >= MIN && !x.dis && x.t && now - x.t <= FALLBACK_DAYS * 864e5 && now - x.t > WIN)
  .filter(x => !shown.has(keyOf(x)))
  .sort((a, b) => b.t - a.t);
const actionable = [
  ...board.map(x => ({ ...x, fresh: true })),
  ...(fallbackPrimary ? [{ ...fallbackPrimary, fresh: false }] : []),
];
for (const x of topUp) { if (actionable.length >= MIN_COUNT) break; actionable.push({ ...x, fresh: false }); }

// Req age vs found age: a role found an hour ago may be a months-old re-promoted req.
const postedByUrl = new Map();
try {
  for (const line of readFileSync('data/qualifiers.tsv', 'utf8').split('\n').slice(1)) {
    const c = line.split('\t');
    const u = (c[5] || '').trim(), p = Date.parse((c[7] || '').trim());
    if (u && Number.isFinite(p)) postedByUrl.set(u, p);
  }
} catch { /* no qualifiers ledger yet */ }
const ageLabel = (x) => {
  if (!x.fresh) return `AGED ${Math.max(1, Math.round((now - x.t) / 864e5))}d — re-verify open`;
  const p = postedByUrl.get((x.url || '').trim());
  if (!Number.isFinite(p)) return `FOUND <${HOURS}h (req age unknown — check the posting)`;
  const d = Math.round((now - p) / 864e5);
  return d <= 1 ? `FRESH <${HOURS}h` : `FOUND <${HOURS}h, but the req is ~${d}d old — re-verify open`;
};

// Stretch leads: below the bar only because of a years/experience gate, named not hidden.
const stretch = rows
  .map(r => ({ co: r[1], role: r[2], score: parseFloat(r[3]), why: r[5] || '', dis: userDismissed(r), t: parseFound(r), url: r[6], arch: archetype(r[2]) }))
  .filter(x => x.score >= NEAR && x.score < MIN && !x.dis && x.t && now - x.t <= NEAR_DAYS * 864e5)
  .filter(x => /gate|year/i.test(x.why))
  .sort((a, b) => b.score - a.score || b.t - a.t)
  .slice(0, 4);

// Every surfaced job must have its OWN report (role-aware; a different req at the same
// employer does not count).
let REPORTS = [];
try { REPORTS = readdirSync('reports').filter(f => /\.md$/i.test(f)); } catch {}
const LOC_WORDS = [T.location.city, T.location.metro, ...(T.location.cities || [])].join(' ').toLowerCase().split(/[^a-z]+/).filter(Boolean);
const GENERIC_W = new Set(['engineer', 'senior', 'staff', 'lead', 'the', 'and', 'for', ...LOC_WORDS]);
function reportFor(co, role) {
  const tok = String(co).toLowerCase().split(/[\s,.(/-]/)[0].replace(/[^a-z0-9]/g, '');
  const cands = REPORTS.filter(f => tok.length >= 2 && f.toLowerCase().split(/[-.]/).some(g => g === tok));
  if (!cands.length) return null;
  const w = String(role).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(x => x.length > 3 && !GENERIC_W.has(x));
  if (!w.length) return cands[0];
  for (const f of cands) {
    let body = '';
    try { body = readFileSync(`reports/${f}`, 'utf-8').slice(0, 1200).toLowerCase(); } catch {}
    const hay = f.toLowerCase() + ' ' + body;
    if (w.filter(x => hay.includes(x)).length / w.length >= 0.6) return f;
  }
  return null;
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    hours: HOURS, min: MIN, minCount: MIN_COUNT, primaryRole: PRIMARY, primaryQuota: PRIMARY_QUOTA,
    total: board.length, needed, primary: primary.length, other: other.length, primaryOk, countOk, met,
    primaryNear: primaryNear.slice(0, 3).map(x => ({ company: x.co, role: x.role, score: x.score })),
    liveFallback: { primary: fbJson(fallbackPrimary) },
    actionable: actionable.map(x => ({ company: x.co, role: x.role, score: x.score, url: x.url, fresh: !!x.fresh, ageDays: Math.round((now - x.t) / 864e5) })),
    actionableCount: actionable.length, surfaceOk: actionable.length >= MIN_COUNT,
  }, null, 2));
} else {
  const fmt = a => a.length ? a.map(x => `${x.score}  ${x.co} | ${x.role}${x.applied ? '  [applied]' : ''}`).join('\n      ') : '(none)';
  console.log(`Daily board policy (last ${HOURS}h, >=${MIN}, quota >=${MIN_COUNT} incl. >=${PRIMARY_QUOTA} ${PRIMARY}):  total=${board.length}  primary=${primary.length}  other=${other.length}`);
  console.log(`  ${PRIMARY} (primary):\n      ${fmt(primary)}`);
  if (other.length) console.log(`  other targets:\n      ${fmt(other)}`);
  if (met) {
    console.log(`\nQUOTA: MET — ${board.length} qualifier(s) on the ${HOURS}h board (need >=${MIN_COUNT}) including ${primary.length} ${PRIMARY} (need >=${PRIMARY_QUOTA}).`);
  } else {
    const reasons = [];
    if (!countOk) reasons.push(`${board.length} of ${MIN_COUNT} qualifiers (NEED ${needed} MORE)`);
    if (!primaryOk) reasons.push(`${primary.length} of ${PRIMARY_QUOTA} ${PRIMARY} qualifier(s)`);
    console.log(`\nQUOTA: SHORT — ${reasons.join('; ')}.  [>=${MIN}, <=${HOURS}h]`);
    if (!primaryOk) console.log(`  -> Hunt the primary-role lane (${PRIMARY}) next.`);
    console.log(`  -> If the bar genuinely cannot be met today, surface the best near-miss flagged below-bar and report the shortfall. NEVER inflate a score, relabel a role, or widen the window to hit the quota.`);
  }

  console.log(`\nAPPLY TODAY (${actionable.length}${actionable.length < MIN_COUNT ? ` — only ${actionable.length} live >=${MIN} role(s) exist in the last ${FALLBACK_DAYS}d` : ''}):`);
  for (const x of actionable) {
    const rep = reportFor(x.co, x.role);
    console.log(`      ${x.score}  ${x.co} | ${x.role}`);
    console.log(`         [${ageLabel(x)}]  ${x.url || '(no url)'}`);
    console.log(`         report: ${rep ? 'reports/' + rep : '*** MISSING — owed ***'}`);
  }
  const noReport = actionable.filter(x => !reportFor(x.co, x.role));
  if (noReport.length) console.log(`\n  !! ${noReport.length} surfaced job(s) MISSING a report — generate before applying:\n${noReport.map(x => '     - ' + x.co + ' | ' + x.role).join('\n')}`);

  if (stretch.length) {
    console.log(`\nSTRETCH (below the ${MIN} bar — the gate each one misses is named; apply only if you want to push):`);
    for (const x of stretch) {
      console.log(`      ${x.score}  ${x.co} | ${x.role}  [${x.arch}]`);
      console.log(`         gap: ${String(x.why).replace(/\s+/g, ' ').slice(0, 150)}`);
      console.log(`         ${x.url || ''}`);
    }
  }

  if (!primaryOk && primaryNear.length) {
    const s = primaryNear[0];
    console.log(`\nPRIMARY NEAR-MISS (below the ${MIN} bar):\n      ${s.score}  ${s.co} | ${s.role}  (~${Math.round((now - s.t) / 864e5)}d ago)`);
  }
  if (fallbackPrimary) {
    const fb = fallbackPrimary;
    console.log(`\nLIVE FALLBACK (${PRIMARY}) — freshest live >=${MIN} qualifier in the last ${FALLBACK_DAYS}d (re-verify open before applying):\n      ${fb.score}  ${fb.co} | ${fb.role}  (~${Math.round((now - fb.t) / 864e5)}d ago)\n      ${fb.url}`);
  }

  // LinkedIn lane health: a dead crawler and a quiet market look identical on the board.
  try {
    const st = JSON.parse(readFileSync('data/_linkedin-crawl-status.json', 'utf8'));
    const ranAgoH = (now - Date.parse(st.ran_at)) / 3.6e6;
    if (!st.ok) console.log(`\n!! LINKEDIN LANE FAILED — ${st.stopped_because || st.error} (last attempt ${Math.round(ranAgoH)}h ago). A thin board is NOT evidence of a quiet market.`);
    else if (ranAgoH > 26) console.log(`\n!! LINKEDIN LANE STALE — last ran ${Math.round(ranAgoH)}h ago (expected daily). See docs/SCHEDULING.md.`);
    else if (st.skipped) console.log(`\n   LinkedIn lane skipped: ${st.skipped}`);
    else console.log(`\n   LinkedIn lane OK — ${st.unique_cards} cards, ${st.verified} ATS-verified.`);
  } catch {
    console.log('\n   LinkedIn lane: no status file yet (optional lane; needs the debug browser).');
  }

  // AGED, still open: ATS-confirmed real and on-target, only older than the window.
  const aged = rows.filter(f => f.length > 6 && (f[4] || '').trim() === 'aged')
    .map(f => ({ co: f[1], role: f[2], score: parseFloat(f[3]), url: f[6], applied: (f[8] || '').trim() }))
    .filter(r => Number.isFinite(r.score) && r.score >= MIN)
    .sort((a, b) => b.score - a.score)
    .filter((r, i, a) => a.findIndex(x => x.url === r.url) === i)
    .slice(0, 40);
  const open = aged.filter(r => !r.applied), appliedAged = aged.filter(r => r.applied);
  if (open.length) {
    console.log(`\nAGED — still open, older than the window. NOT quota-eligible; re-verify before applying.`);
    for (const r of open) console.log(`      ${r.score.toFixed(1)}  ${r.co} | ${r.role}\n            ${r.url}`);
  }
  if (appliedAged.length) console.log(`   (${appliedAged.length} aged req(s) hidden — already applied)`);
}

process.exit(met ? 0 : 1);
