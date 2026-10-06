/**
 * repair-schedule.mjs — backoff schedule for dead boards (pure, no I/O except the sidecar helpers).
 *
 * A board that is still dead after a repair attempt is re-checked after 1 week, then 2, then 4
 * (and every 4 weeks after that). The schedule lives in data/_repair-schedule.tsv, keyed on the
 * same board identity as the index (rowKey), so it survives index rewrites.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parseTsv } from './index-tsv.mjs';

export const BACKOFF_WEEKS = [1, 2, 4];
export const SCHEDULE_COLS = ['key', 'company', 'attempts', 'last_checked', 'next_check', 'result'];
const DAY = 86_400_000;

/** Weeks to wait after `attempts` failed checks (1 -> 1, 2 -> 2, 3+ -> 4). */
export const backoffWeeks = attempts => BACKOFF_WEEKS[Math.min(Math.max(attempts, 1), BACKOFF_WEEKS.length) - 1];

export function addDays(iso, days) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
}

/** Next-check date after a failed check made on `today` that was failure number `attempts`. */
export const nextCheckDate = (today, attempts) => addDays(today, backoffWeeks(attempts) * 7);

/** A row with no schedule entry is due immediately; otherwise due when next_check <= today. */
export const isDue = (entry, today) => !entry || !entry.next_check || entry.next_check <= today;

/** New schedule entry after a check. ok=true clears the backoff (entry removed by caller). */
export function recordFailure(entry, { key, company, today, result }) {
  const attempts = (Number(entry?.attempts) || 0) + 1;
  return { key, company, attempts: String(attempts), last_checked: today, next_check: nextCheckDate(today, attempts), result: result || '' };
}

export function loadSchedule(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const r of parseTsv(readFileSync(path, 'utf-8')).rows) if (r.key) m.set(r.key, r);
  return m;
}

export function saveSchedule(path, map) {
  const lines = [...map.values()].sort((a, b) => a.next_check.localeCompare(b.next_check))
    .map(r => SCHEDULE_COLS.map(c => String(r[c] ?? '').replace(/[\t\n]/g, ' ')).join('\t'));
  writeFileSync(path, SCHEDULE_COLS.join('\t') + '\n' + lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
}

/**
 * Nonsense-slug control. A host that answers 200 with jobs for a random slug is a SPA that
 * 200s for anything, so a 200 on the real slug proves nothing. `probe(url)` -> {ok, count}.
 * Returns {host200sAnything, controlUrl}.
 */
export async function nonsenseControl(buildUrl, probe, rand = () => Math.random().toString(36).slice(2, 10)) {
  const slug = `zz-nope-${rand()}${rand()}`;
  const url = buildUrl(slug);
  const r = await probe(url);
  return { controlUrl: url, host200sAnything: !!(r && r.ok && r.count > 0) };
}
