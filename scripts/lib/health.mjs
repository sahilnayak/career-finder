/**
 * health.mjs — pure health signals shared by doctor.mjs and pipeline-digest.mjs (build plan step 6).
 * No network, no profile at import time; callers pass the rows in.
 *
 *   statusBreakdown()   per-family HTTP status counts from the request ledger, with the bad ones split out
 *   roundCapBoards()    boards whose last scan returned exactly a round-number job count (truncation tell)
 *   unprovenRoles()     target roles with no hits in the window, labelled "Unproven 0"
 *   nominationHealth()  nomination resolve rate vs the 70% target
 *   healthLines()       the printable block (markdown-safe plain lines)
 */
import { resolveRate, TARGET_RESOLVE_RATE } from './nominate.mjs';

/** Mirrors ROUND_CAPS in scan-index.mjs (test-nominate.mjs asserts they still match). */
export const ROUND_CAPS = [20, 40, 200, 10000];
/** Statuses that are not a real HTTP answer and not a failure ('cdp' = browser navigation). */
const NEUTRAL = new Set(['cdp', 'claimed']);

/** @returns {Array<{family: string, requests: number, statuses: Record<string, number>, bad: Record<string, number>}>} */
export function statusBreakdown(agg) {
  const out = [];
  for (const [family, e] of agg) {
    const bad = {};
    for (const [k, v] of Object.entries(e.statuses)) if (!/^2\d\d$/.test(k) && !NEUTRAL.has(k)) bad[k] = v;
    out.push({ family, requests: e.requests, statuses: e.statuses, bad });
  }
  return out;
}

/** Boards whose `last_status` ("N jobs / M kept") has N exactly on a round cap, grouped by ATS family. */
export function roundCapBoards(indexRows, caps = ROUND_CAPS) {
  const byFamily = {};
  for (const r of indexRows) {
    const n = Number((String(r.last_status || '').match(/^(\d+)\s+jobs/) || [])[1]);
    if (!Number.isFinite(n) || !caps.includes(n)) continue;
    (byFamily[r.ats_type || 'unknown'] ||= []).push({ company: r.company, jobs: n });
  }
  return { byFamily, total: Object.values(byFamily).reduce((s, l) => s + l.length, 0) };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * @param {string[]} roles
 * @param {(role: string) => string[]} synonymsFor
 * @param {string[]} titles   titles seen in the window (scored, candidate and web-role rows)
 * @returns {Array<{role: string, hits: number, unproven: boolean}>}
 */
export function unprovenRoles({ roles, synonymsFor = () => [], titles }) {
  return roles.map((role) => {
    const terms = [role, ...synonymsFor(role)].filter(Boolean);
    const re = new RegExp(`(^|[^a-z0-9])(?:${terms.map((t) => esc(t.toLowerCase())).join('|')})(?![a-z0-9])`, 'i');
    const hits = titles.filter((t) => re.test(String(t))).length;
    return { role, hits, unproven: hits === 0 };
  });
}

export function nominationHealth(ledgerRows) {
  const rr = resolveRate(ledgerRows);
  return { ...rr, belowTarget: rr.rate != null && rr.rate < TARGET_RESOLVE_RATE };
}

/**
 * @returns {{lines: string[], warnings: string[]}}  warnings are the subset that must be loud
 */
export function healthLines({ agg = new Map(), indexRows = [], roles = [], synonymsFor, titles = [], ledgerRows = [], windowLabel = 'last 24h' } = {}) {
  const lines = [], warnings = [];
  const sb = statusBreakdown(agg);
  lines.push(`HTTP by family (${windowLabel}):`);
  if (!sb.length) lines.push('  (no ledger rows: no lane recorded a request)');
  for (const f of sb) {
    const st = Object.entries(f.statuses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push(`  ${f.family}: ${f.requests} (${st})`);
    const bad = Object.entries(f.bad).map(([k, v]) => `${k}:${v}`).join(' ');
    // Loud only when it matters: any 403/429 (blocked or throttled) or 2%+ of the family's requests failing.
    const nBad = Object.values(f.bad).reduce((a, b) => a + b, 0);
    if (bad && (f.bad['403'] || f.bad['429'] || nBad / Math.max(1, f.requests) >= 0.02)) warnings.push(`${f.family} returned non-2xx answers: ${bad} of ${f.requests}`);
  }
  const caps = roundCapBoards(indexRows);
  if (caps.total) {
    for (const [fam, list] of Object.entries(caps.byFamily)) {
      warnings.push(`ROUND CAP: ${fam} has ${list.length} board(s) at exactly ${[...new Set(list.map((b) => b.jobs))].join('/')} jobs (likely truncated): ${list.slice(0, 5).map((b) => b.company).join(', ')}${list.length > 5 ? ', ...' : ''}`);
    }
  }
  if (roles.length) {
    const pr = unprovenRoles({ roles, synonymsFor, titles });
    lines.push('Target roles with hits in the window:');
    for (const r of pr) lines.push(`  ${r.role}: ${r.unproven ? 'Unproven 0 (no hits; not evidence the market is empty)' : r.hits}`);
  }
  const nh = nominationHealth(ledgerRows);
  if (nh.attempts === 0) lines.push('Nominations: no attempts recorded yet');
  else {
    lines.push(`Nominations: resolve rate ${Math.round(nh.rate * 100)}% (${nh.resolved}/${nh.attempts}, target ${TARGET_RESOLVE_RATE * 100}%)`);
    if (nh.belowTarget) warnings.push(`nomination resolve rate ${Math.round(nh.rate * 100)}% is below the ${TARGET_RESOLVE_RATE * 100}% target`);
  }
  return { lines, warnings };
}

/** Dead-lane gate (scan-index): fatal only with a real floor (>=5 empty-200 boards) AND a history baseline. */
export function deadLaneFatal(f, hadJobsBefore) { return f.ok >= 5 && f.jobs === 0 && !!hadJobsBefore; }

/** A fetch that timed out or was skipped for repeated timeouts: the host is slow, the board is not proven dead. */
export function isTimeoutError(err) {
  return err?.name === 'AbortError' || err?.status === 'skipped' || /operation was aborted|timed? ?out/i.test(String(err?.message || ''));
}
