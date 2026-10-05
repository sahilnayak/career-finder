#!/usr/bin/env node
/**
 * request-ledger.mjs — one per-run request counter, keyed by host family.
 *
 * Why: the 2026-10-04 discovery audit could not say how many LinkedIn or HiringCafe requests the
 * test run made, so the "<=3 guest requests/day" rule was uncheckable. Every lane now records its
 * outbound requests here and every run prints the totals.
 *
 * LinkedIn is NOT counted here a second time. li-budget.mjs stays the one LinkedIn counter: its
 * claim() events (data/li-events.tsv) are the request count for the logged-in lanes, and record()
 * on a LinkedIn URL only appends a `http` status event to that same log (kind `http` is outside
 * every li-budget horizon, so it never spends budget). summary() reads those events back for this
 * process, filtered by pid + run id.
 *
 * API
 *   record(urlOrHost, { status })   status: HTTP code, 'error', 'timeout', 'cdp', ...
 *   summary()                        -> [{ family, requests, statuses: {code: n} }]
 *   flush({ mode })                  appends this process's rows to data/_request-ledger.tsv
 *                                    (auto-runs once at process exit)
 *   readLedger({ runId, path })      rows from the TSV (for morning.mjs / pipeline-digest.mjs)
 *   aggregate(rows)                  family -> { requests, statuses } across rows
 *   formatSummary(agg)               one printable block
 *
 * Run identity: CAREER_FINDER_RUN_ID (morning.mjs sets it for its children) else a per-process id.
 * Mode: CAREER_FINDER_RUN_MODE else the script basename.
 * Path: CAREER_FINDER_LEDGER else data/_request-ledger.tsv (cwd-relative, like every data file).
 *
 * TSV columns: date  run_id  mode  family  requests  statuses   (statuses = "200:41,404:2")
 *
 * CLI: node scripts/request-ledger.mjs [--run <id> | --last | --date YYYY-MM-DD] [--json]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EVENTS_PATH, logEvent } from './li-budget.mjs';

export const FAMILIES = ['linkedin-guest', 'linkedin-loggedin', 'hiringcafe', 'greenhouse', 'lever', 'ashby',
  'workday', 'smartrecruiters', 'icims', 'oracle', 'other'];
const LI_FAMILIES = new Set(['linkedin-guest', 'linkedin-loggedin']);
// li-budget kinds that are logged-in navigations (ACCOUNT_LANES minus the off-account guest lane).
const LOGGEDIN_KINDS = new Set(['profile', 'search', 'jobsearch', 'connect', 'message', 'pageview', 'page']);
export const LEDGER_HEADER = ['date', 'run_id', 'mode', 'family', 'requests', 'statuses'];

export const RUN_ID = process.env.CAREER_FINDER_RUN_ID
  || `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${process.pid}`;
const MODE = () => process.env.CAREER_FINDER_RUN_MODE || basename(process.argv[1] || 'node', '.mjs');
const LEDGER = () => process.env.CAREER_FINDER_LEDGER || 'data/_request-ledger.tsv';

/** Host (or full URL) -> family. LinkedIn guest = the logged-out /jobs-guest/ API. */
export function familyOf(urlOrHost = '') {
  let host = String(urlOrHost), path = '';
  try { const u = new URL(/^[a-z]+:\/\//i.test(host) ? host : `https://${host}`); host = u.hostname; path = u.pathname; } catch { /* keep raw */ }
  host = host.toLowerCase();
  if (/(^|\.)linkedin\.com$/.test(host)) return /\/jobs-guest\//.test(path) ? 'linkedin-guest' : 'linkedin-loggedin';
  if (/(^|\.)hiring\.cafe$|(^|\.)hiringcafe\.com$/.test(host)) return 'hiringcafe';
  if (/greenhouse\.io$/.test(host)) return 'greenhouse';
  if (/lever\.co$/.test(host)) return 'lever';
  if (/ashbyhq\.com$/.test(host)) return 'ashby';
  if (/myworkdayjobs\.com$|myworkdaysite\.com$|workday\.com$/.test(host)) return 'workday';
  if (/smartrecruiters\.com$/.test(host)) return 'smartrecruiters';
  if (/icims\.com$/.test(host)) return 'icims';
  if (/oraclecloud\.com$|taleo\.net$/.test(host)) return 'oracle';
  return 'other';
}

const counts = new Map(); // family -> { requests, statuses: {} }
const bump = (m, fam, status, n = 1) => {
  const e = m.get(fam) || { requests: 0, statuses: {} };
  e.requests += n;
  const k = String(status ?? 'unknown');
  e.statuses[k] = (e.statuses[k] || 0) + n;
  m.set(fam, e);
};

/** Count one outbound request. LinkedIn URLs log a status event to li-budget's log instead. */
export function record(urlOrHost, { status } = {}) {
  const fam = familyOf(urlOrHost);
  if (LI_FAMILIES.has(fam)) { logEvent({ kind: 'http', status: String(status ?? 'unknown'), note: fam }); return fam; }
  bump(counts, fam, status);
  return fam;
}

/** Wrap a fetch-like call: records the status (or 'error') and rethrows. */
export async function tracked(url, init, fetchImpl = fetch) {
  try { const r = await fetchImpl(url, init); record(url, { status: r.status }); return r; }
  catch (e) { record(url, { status: e?.name === 'AbortError' ? 'timeout' : 'error' }); throw e; }
}

/** LinkedIn traffic for one process/run, read from li-budget's event log. */
export function linkedinFromEvents({ pid = process.pid, runId = RUN_ID, path = EVENTS_PATH } = {}) {
  const m = new Map();
  if (!existsSync(path)) return m;
  const spends = { 'linkedin-guest': 0, 'linkedin-loggedin': 0 };
  const http = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const [, kind, status, note, rid, p] = line.split('\t');
    // logEvent() writes the env run id ('' when unset), so pid alone identifies the process;
    // the run id additionally guards against pid reuse across runs.
    if (String(p) !== String(pid) || (rid || '') !== (process.env.CAREER_FINDER_RUN_ID ? runId : '')) continue;
    if (kind === 'http' && LI_FAMILIES.has(note)) bump(http, note, status);
    else if (status === 'spend' && kind === 'guest') spends['linkedin-guest']++;
    else if (status === 'spend' && LOGGEDIN_KINDS.has(kind)) spends['linkedin-loggedin']++;
  }
  for (const fam of LI_FAMILIES) {
    const h = http.get(fam);
    const n = Math.max(spends[fam], h?.requests || 0);
    if (!n) continue;
    const statuses = { ...(h?.statuses || {}) };
    const gap = n - (h?.requests || 0);
    if (gap > 0) statuses.claimed = gap; // claim()ed navigations with no recorded HTTP status (CDP)
    m.set(fam, { requests: n, statuses });
  }
  return m;
}

/** This process's totals, all families (LinkedIn read from li-budget's log). */
export function summary() {
  const merged = new Map(counts);
  for (const [fam, e] of linkedinFromEvents()) merged.set(fam, e);
  return FAMILIES.filter(f => merged.has(f)).map(f => ({ family: f, ...merged.get(f) }));
}

export const fmtStatuses = (s) => Object.entries(s).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(',');
export const parseStatuses = (str = '') => Object.fromEntries(String(str).split(',').filter(Boolean)
  .map(kv => { const i = kv.lastIndexOf(':'); return [kv.slice(0, i), Number(kv.slice(i + 1)) || 0]; }));

let flushed = false;
/** Append this process's rows. Idempotent per process. */
export function flush({ mode = MODE(), path = LEDGER(), date = new Date().toISOString() } = {}) {
  if (flushed) return 0;
  flushed = true;
  const rows = summary();
  if (!rows.length) return 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const head = existsSync(path) ? '' : LEDGER_HEADER.join('\t') + '\n';
    appendFileSync(path, head + rows.map(r => [date, RUN_ID, mode, r.family, r.requests, fmtStatuses(r.statuses)].join('\t')).join('\n') + '\n');
  } catch { /* the ledger must never break a run */ }
  return rows.length;
}
// Offline test suites (scripts/test-*.mjs) exercise the fetch paths against mocks; their counts are
// not real traffic and must never land in the user's ledger.
// test-all.mjs also sets CAREER_FINDER_LEDGER_OFF=1 for everything it spawns, so a child script run
// against mocks (not itself named test-*) cannot leak rows either.
const IS_TEST = /^test-/.test(basename(process.argv[1] || ''));
const ledgerOn = () => process.env.CAREER_FINDER_LEDGER_OFF !== '1' && !IS_TEST;
process.on('exit', () => { if (ledgerOn()) flush(); });
// 'exit' does not fire on a signal kill (e.g. discovery-audit --live timing a lane out with
// SIGTERM), which would drop the counts for exactly the run that made the most requests. Flush,
// then exit with the conventional 128+signal code. Only installed if nobody else handles it.
for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  if (process.listenerCount(sig) === 0) process.once(sig, () => { if (ledgerOn()) flush(); process.exit(code); });
}

/** Parse ledger rows. Filters: runId, sinceIso. */
export function readLedger({ path = LEDGER(), runId, sinceIso } = {}) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
    if (!line.trim()) continue;
    const [date, run_id, mode, family, requests, statuses] = line.split('\t');
    if (runId && run_id !== runId) continue;
    if (sinceIso && date < sinceIso) continue;
    out.push({ date, run_id, mode, family, requests: Number(requests) || 0, statuses: parseStatuses(statuses) });
  }
  return out;
}

/** family -> { requests, statuses, modes } summed across rows. */
export function aggregate(rows) {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.family) || { requests: 0, statuses: {}, modes: new Set() };
    e.requests += r.requests;
    for (const [k, v] of Object.entries(r.statuses)) e.statuses[k] = (e.statuses[k] || 0) + v;
    if (r.mode) e.modes.add(r.mode);
    m.set(r.family, e);
  }
  return m;
}

export function formatSummary(agg, title = 'REQUEST LEDGER') {
  const fams = [...agg.keys()].sort((a, b) => FAMILIES.indexOf(a) - FAMILIES.indexOf(b));
  if (!fams.length) return `${title}: no requests recorded`;
  const total = fams.reduce((s, f) => s + agg.get(f).requests, 0);
  const lines = fams.map(f => `  ${f.padEnd(18)} ${String(agg.get(f).requests).padStart(6)}  ${fmtStatuses(agg.get(f).statuses)}`);
  return `${title} (${total} requests):\n${lines.join('\n')}`;
}

// ── CLI ──
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.env.CAREER_FINDER_LEDGER_OFF = '1';
  const a = process.argv.slice(2);
  const val = (f) => { const i = a.indexOf(f); return i !== -1 ? a[i + 1] : undefined; };
  let rows = readLedger();
  if (val('--run')) rows = rows.filter(r => r.run_id === val('--run'));
  else if (val('--date')) rows = rows.filter(r => r.date.startsWith(val('--date')));
  else if (a.includes('--last') && rows.length) { const last = rows[rows.length - 1].run_id; rows = rows.filter(r => r.run_id === last); }
  const agg = aggregate(rows);
  if (a.includes('--json')) console.log(JSON.stringify(Object.fromEntries([...agg].map(([k, v]) => [k, { requests: v.requests, statuses: v.statuses, modes: [...v.modes] }])), null, 2));
  else console.log(formatSummary(agg));
}
