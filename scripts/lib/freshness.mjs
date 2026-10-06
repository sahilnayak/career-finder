/**
 * freshness.mjs — one decision: is this posting FRESH, and on what evidence?
 *
 * Pure functions (no I/O, no clock) so every label is unit-testable. scan-index.mjs owns the
 * ledger file (data/_first-seen.tsv) and feeds `known` in; this module only reasons.
 *
 * Why this exists (weekday audit 2026-10-06): day-level date families (Workday "Posted Yesterday",
 * Oracle PostedDate, iCIMS, Taleo) cannot prove a posting is inside a 24h window, and ATS dates
 * get bumped (a req reposted weeks later keeps its id, a "fresh" Snowflake req was 82 days old).
 * What we CAN prove is when WE first saw an id. So:
 *
 *   minute-level families (Ashby, Greenhouse first_published, Lever, ...)
 *       in window                         -> fresh
 *       known id, later ATS date, or first seen before the window yet dated inside it
 *                                         -> re-promoted   (date bumped; not fresh; sticky across runs)
 *       outside window                    -> old (recorded once, so a later bump is detectable)
 *       Greenhouse updated_at only        -> unverified    (updated_at moves on every edit)
 *   day-level families (workday, oracle, icims, taleo)
 *       day entirely before window start  -> unverified
 *       known id, different day           -> re-promoted
 *       id first seen on/after window start (or never seen) AND day overlaps window -> new
 *       known id first seen before the window                                       -> known
 *
 * `edge` is a flag, not a label: the ATS timestamp sits within 1h of the window start, on either
 * side, so a clock-skew or timezone slip could flip the decision. Callers print it.
 */

export const DAY_LEVEL_FAMILIES = new Set(['workday', 'oracle', 'icims', 'taleo']);
export const EDGE_MS = 3_600_000;
export const LABELS = ['fresh', 'new', 'unverified', 're-promoted', 'known', 'old'];

/** Calendar day (YYYY-MM-DD) of a day-level date. UTC midnight = a date-only value, read in UTC. */
export function dayOf(date, localDateStr) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  const utcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return utcMidnight ? date.toISOString().slice(0, 10) : (localDateStr ? localDateStr(date) : date.toISOString().slice(0, 10));
}

/** The value stored in the ledger's last_date column: a day for day-level families, else full ISO. */
export function ledgerDate(date, family, localDateStr) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  return DAY_LEVEL_FAMILIES.has(family) ? dayOf(date, localDateStr) : date.toISOString();
}

/**
 * @param {object} job     { postedAt: Date|null, dateSource?: string }
 * @param {string} family  scan-core api type
 * @param {object|null} known  ledger entry { first_seen: ISO, last_date: string } or null
 * @param {object} win     { start: Date, isRecent: (Date)=>boolean, localDateStr: (Date)=>string }
 * @returns {{label: string, fresh: boolean, edge: boolean, record: boolean, lastDate: string}}
 *   record = the caller should write/refresh the ledger row for this id.
 */
export function labelFreshness(job, family, known, win) {
  const { start, isRecent, localDateStr } = win;
  const d = job.postedAt;
  const out = (label, extra = {}) => ({ label, fresh: label === 'fresh' || label === 'new', edge: false, record: false, lastDate: ledgerDate(d, family, localDateStr), ...extra });

  if (job.dateSource === 'updated_at') return out('unverified', { record: false });
  if (!(d instanceof Date) || isNaN(d)) return out('unverified');

  const edge = Math.abs(d.getTime() - start.getTime()) <= EDGE_MS && !DAY_LEVEL_FAMILIES.has(family);

  if (DAY_LEVEL_FAMILIES.has(family)) {
    const day = dayOf(d, localDateStr);
    const startDay = localDateStr(start);
    if (day < startDay) return out('unverified', { record: true });
    if (known && known.last_date && known.last_date !== day) return out('re-promoted', { record: true });
    if (!known) return out('new', { record: true });
    // Known id: still "new" while it was first seen inside this window (a second run in the same
    // window must not drop a candidate the first run found but nobody has scored yet).
    const fs = Date.parse(known.first_seen);
    return fs >= start.getTime() ? out('new', { record: false }) : out('known', { record: false });
  }

  // Re-promotion is STICKY without a marker column: a req we first saw BEFORE the window start can
  // not honestly have an ATS date inside the window, so a recent date on such an id is a bump on
  // every run, not just the run that noticed it (ledgerPut overwrites last_date on the first one).
  if (known) {
    const bumped = known.last_date && known.last_date !== d.toISOString() && Date.parse(known.last_date) < d.getTime();
    const fs = Date.parse(known.first_seen);
    const seenBeforeWindow = Number.isFinite(fs) && fs < start.getTime() && d.getTime() >= start.getTime();
    if (bumped || seenBeforeWindow) return out('re-promoted', { record: !!bumped, edge });
  }
  // Out-of-window rows are recorded too (once per id) so a later date bump on them is detectable.
  if (!isRecent(d)) return out('old', { edge, record: !known });
  return out('fresh', { record: !known, edge });
}

/** Counter helper: tally labels (+ edge) for the summary line. */
export function newTally() { return { fresh: 0, new: 0, unverified: 0, 're-promoted': 0, known: 0, old: 0, edge: 0, 'updated_at-only': 0 }; }
export function tally(t, r, job) {
  t[r.label] = (t[r.label] || 0) + 1;
  if (r.edge) t.edge++;
  if (job?.dateSource === 'updated_at') t['updated_at-only']++;
}
export function formatTally(t) {
  return Object.entries(t).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || '(none)';
}
