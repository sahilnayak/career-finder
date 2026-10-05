// morning-summary.mjs — pure helpers for morning.mjs's end-of-run summary (offline-testable).
//
// daily-quota.mjs exits 1 when the board is short. That is an OUTCOME, not a broken lane, so it
// must never be listed under FAILED LANES (which means "a lane is dead, go fix it").

/** Lanes whose non-zero exit means "quota short", not "lane failed". */
export const QUOTA_LANES = new Set(['quota', 'quota:report']);

/**
 * @param {[string,string,string][]} results  [name, status, why] rows from morning.mjs
 * @returns {{ failed: [string,string,string][], quotaShort: boolean }}
 */
export function splitFailures(results) {
  const failed = []; let quotaShort = false;
  for (const r of results) {
    const [name, st] = r;
    if (!/^exit /.test(st)) continue;
    if (QUOTA_LANES.has(name) && st === 'exit 1') { quotaShort = true; continue; }
    failed.push(r);
  }
  return { failed, quotaShort };
}

/** The QUOTA line, or '' when there is nothing to say. */
export function quotaLine(q, quotaShort, primaryLabel = 'primary') {
  if (q) return `QUOTA: ${q.met ? 'met' : 'quota short'} — ${q.total}/${q.minCount} qualifiers, ${q.primary}/${q.primaryQuota} ${primaryLabel}`;
  return quotaShort ? 'QUOTA: quota short (daily-quota.mjs exit 1)' : '';
}
