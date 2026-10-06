#!/usr/bin/env node

/**
 * pipeline-digest.mjs — one durable answer to "how is the pipeline doing?". ZERO LLM, zero browser.
 *
 * WHY THIS IS A SCRIPT AND NOT AN AGENT. The pipeline's worst failures happen precisely when the
 * token window is exhausted: on 2026-09-11 the 6am run collected every candidate, hit a session
 * limit at 07:06, never scored a single row, and ended 'QUOTA DEFERRED'. An LLM-based monitor
 * would have died in the same window. This must run when nothing else can, so it spends nothing.
 *
 * WHAT IT IS FOR. Distinguishing a BROKEN LANE from a QUIET MARKET. Those look identical on the
 * board and this repo has lost days to the confusion: TITLE_DROP silently ate the primary-role lane, a
 * wall-clock cron gate died on a schedule change, a wired-in resolver wrote a file nothing read
 * for a day, and the LinkedIn lane spent 2026-09-11 reporting a navigation failure that was a
 * dead browser, not LinkedIn. Every check below exists because something failed silently once.
 *
 * Usage:
 *   node scripts/pipeline-digest.mjs                 # write data/_daily-digest.md and print it
 *   node scripts/pipeline-digest.mjs --quiet         # write only
 *   node scripts/pipeline-digest.mjs --json
 *   node scripts/pipeline-digest.mjs --live          # also re-verify unapplied qualifiers (network)
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { isPrimaryRole, loadTargets } from './targets.mjs';
import { readLedger, aggregate, fmtStatuses } from './request-ledger.mjs';
import { healthLines } from './lib/health.mjs';
import { parseTsv } from './lib/index-tsv.mjs';
import { readLedger as readNominations } from './lib/nominate.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const QUIET = has('--quiet');
const JSON_OUT = has('--json');
const LIVE = has('--live');

// LOCAL dates, never toISOString(). Every ledger and log in this repo stamps LOCAL dates, so a
// UTC 'today' silently points at tomorrow from 5pm Pacific onward. Shipped that bug on the first
// run of this script: at 20:02 PDT it reported 'pipeline DID NOT RUN TODAY' for a day the cron
// had run at 06:00 and scored 25 rows. A monitor that misreads the clock is worse than no monitor.
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = localDay();
const yday = localDay(new Date(Date.now() - 864e5));
const read = (p) => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };
const lines = (p) => read(p).split('\n');
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 120000 }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };

// ── 1. SCORING: what actually got evaluated, and what it produced ────────────────
// scored-jobs.tsv schema is 12 cols: date company role score verdict why url found_at
// applied_at dismissed_at aged source. Cols 10-11 belong to prune-board.mjs; `source` is col 12
// and is BLANK on nearly every historical row, so never report "lane X produced 0" from it alone.
// Primary vs other target roles come from config/profile.yml (targets.primary_role), never hardcoded.
let QUALIFY = 4.3; try { QUALIFY = Number(loadTargets().pipeline.qualify_score) || 4.3; } catch {}
const isPrimary = (t) => { try { return isPrimaryRole(t); } catch { return false; } };

function scoredOn(day) {
  const out = { total: 0, qualified: 0, primary: 0, other: 0, verdicts: {}, sources: {}, top: [] };
  for (const l of lines('data/scored-jobs.tsv')) {
    const f = l.split('\t');
    if (f.length < 7 || f[0] !== day) continue;
    out.total++;
    out.verdicts[f[4] || '?'] = (out.verdicts[f[4] || '?'] || 0) + 1;
    if (f[11]) out.sources[f[11]] = (out.sources[f[11]] || 0) + 1;
    const sc = parseFloat(f[3]);
    if (sc >= QUALIFY) {
      out.qualified++;
      if (isPrimary(f[2])) out.primary++; else out.other++;
      out.top.push(`${sc.toFixed(1)}  ${f[1]} | ${f[2]}`);
    }
  }
  out.top.sort().reverse();
  return out;
}
const t = scoredOn(today), y = scoredOn(yday);

// ── 2. DID THE CRONS ACTUALLY RUN? ──────────────────────────────────────────────
// An exit code of 0 is NOT evidence a run happened: every cron here exits 0 silently when it
// cannot take its lock, so a stale lock or a still-running twin looks exactly like clean success.
// The only trustworthy signal is a start line in the log for today.
const CRONS = [
  ['daily', 'data/_pipeline.log', /career-finder daily run start/],
  ['speed', 'data/_speed-cron.log', /career-finder speed run start/],
  ['hot', 'data/_hot.log', /career-finder hot run start/],
];
const crons = CRONS.map(([name, log, re]) => {
  const ls = lines(log);
  const todays = ls.filter((l) => l.includes(today) && re.test(l));
  // A REQUESTED pause is not a broken cron. morning.mjs writes a SKIPPED line (never a
  // "run start" line) when today is in data/_pipeline-skip-dates.txt, so without this the digest
  // would report **DID NOT RUN TODAY** on a day the user deliberately asked for off — the same
  // class of false alarm as the wall-clock gate regression, just inverted.
  const skipped = ls.some((l) => l.includes(today) && /SKIPPED/.test(l));
  const lastAny = [...ls].reverse().find((l) => re.test(l)) || '';
  return { name, log, ranToday: todays.length, skipped, lastSeen: (lastAny.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/) || ['never'])[0],
           mtime: existsSync(log) ? (() => { const d = statSync(log).mtime, z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; })() : 'n/a' };
});

// MASTER PAUSE. An indefinite pause is the dangerous kind: a disabled scheduler job can go unnoticed
// for days because nothing reports it.
// So this is surfaced at the TOP of the digest, every day, WITH A DAY COUNT — the count is the part
// that makes a forgotten pause visible, since "paused" alone reads the same on day 1 and day 40.
const pausedSince = (() => {
  if (!existsSync('data/PIPELINE_OFF')) return null;
  const m = read('data/PIPELINE_OFF').match(/^since:\s*(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : 'unknown';
})();
const pausedDays = pausedSince && pausedSince !== 'unknown'
  ? Math.max(0, Math.round((new Date(`${today}T00:00:00`) - new Date(`${pausedSince}T00:00:00`)) / 864e5))
  : null;

// launchd (macOS) tells us whether a job is even ELIGIBLE to run; a disabled label never fires.
let disabled = [];
try {
  const d = sh('launchctl', ['print-disabled', `gui/${process.getuid()}`]);
  disabled = [...d.matchAll(/"(com\.career-finder\.[^"]+)"\s*=>\s*disabled/g)].map((m) => m[1]);
} catch { /* non-fatal */ }

// ── 3. LANE FAILURES AND THE QUOTA-DEFERRED SIGNAL ──────────────────────────────
// 'QUOTA DEFERRED' means the token window died before scoring, NOT that the market was quiet.
// Reporting a thin board without this line is how a budget failure gets misread as a market fact.
const plog = read('data/_pipeline.log');
const todayLog = plog.split('\n').filter((l) => l.includes(today));
const laneFails = todayLog.filter((l) => /LANE FAILED|lane failed|FAILED —|deferred|QUOTA DEFERRED|session limit/i.test(l))
  .map((l) => l.trim().slice(0, 150));

// ── 4. QUEUES: is discovery outrunning scoring? ─────────────────────────────────
const qdepth = (p) => { const n = lines(p).filter((x) => x.trim()).length; return Math.max(0, n - 1); };
const queues = {
  '_web-roles.tsv': qdepth('data/_web-roles.tsv'),
  '_candidates.tsv': qdepth('data/_candidates.tsv'),
  '_hot-candidates.tsv': qdepth('data/_hot-candidates.tsv'),
};
try { queues['_speed-li.json'] = JSON.parse(read('data/_speed-li.json') || '[]').length; } catch { queues['_speed-li.json'] = 0; }

// ── 5. INDEX HEALTH ─────────────────────────────────────────────────────────────
const idx = lines('data/company-index.tsv').filter((l) => l.trim());
const idxErr = idx.filter((l) => /\terror:/.test(l)).length;
// A 404 is a migrated/dead slug and needs repair-index. An abort is a scan-side TIMEOUT on a big
// board under concurrent load and needs a timeout/backoff change. Counting them together hides
// which fix applies, and the two have swapped dominance inside a single day before.
const idxAbort = idx.filter((l) => /\terror:.*(abort|timeout)/i.test(l)).length;
const idx404 = idx.filter((l) => /\terror:\s*HTTP 4/i.test(l)).length;

// ── 6. DOWNSTREAM: the stage that has actually been binding ─────────────────────
// Discovery has never been the constraint; acting on what it finds has. Surface it every day.
const apps = lines('data/applications.md').filter((l) => l.startsWith('|'));
const byStatus = {};
let qualTotal = 0;
for (const l of apps) {
  const p = l.split('|').map((x) => x.trim());
  if (p.length < 8 || p[1] === '#') continue;
  const sc = parseFloat((p[5] || '').replace('/5', ''));
  if (!(sc >= QUALIFY)) continue;
  qualTotal++;
  byStatus[p[6] || '?'] = (byStatus[p[6] || '?'] || 0) + 1;
}

const quota = sh('node', ['scripts/daily-quota.mjs']).split('\n').filter((l) => /QUOTA|Daily board policy/.test(l)).map((l) => l.trim());
// #31 read-only counts: outreach awaiting a pick, follow-ups overdue (both --count modes write nothing).
const countOf = (args, re) => { const m = sh('node', args).match(re); return m ? Number(m[1]) : null; };
const awaiting = countOf(['scripts/outreach-queue.mjs', 'awaiting', '--count'], /AWAITING:\s*(\d+)/i);
const overdue = countOf(['scripts/followup-cadence.mjs', '--count'], /FOLLOWUP:\s*(\d+)/);
const owed = (sh('node', ['scripts/pipeline-owed.mjs']).split('\n').find((l) => /^OWED/.test(l)) || '').trim();
let live = '';
if (LIVE) live = (sh('node', ['scripts/unclaimed-inventory.mjs', '--primary-only']).split('\n').filter((l) => /still open/.test(l))[0] || '').trim();

// ── render ──────────────────────────────────────────────────────────────────────
const delta = (a, b) => (b === 0 ? (a > 0 ? `+${a}` : '0') : `${a >= b ? '+' : ''}${a - b} vs yesterday`);
const L = [];
L.push(`# Pipeline digest — ${today}`, '');
if (pausedSince) {
  L.push(`> ⛔ **PIPELINE IS PAUSED** — since ${pausedSince}` +
    (pausedDays !== null ? ` (**${pausedDays} day${pausedDays === 1 ? '' : 's'}**)` : '') + '.',
    '> Nothing below is a market signal: no scan, no scoring, no spend has happened while paused.',
    '> Resume with `node scripts/pipeline.mjs on`.', '');
}
L.push('## Did it run');
for (const c of crons) {
  const dis = disabled.includes(`com.career-finder.${c.name}`) ? '  [DISABLED in launchd]' : '';
  L.push(`- **${c.name}**: ${c.ranToday ? `ran ${c.ranToday}x today`
  : c.skipped ? `**PAUSED TODAY BY REQUEST** (${pausedSince ? 'kill-switch data/PIPELINE_OFF' : 'date listed in data/_pipeline-skip-dates.txt'})`
  : '**DID NOT RUN TODAY**'} · last start ${c.lastSeen}${dis}`);
}
if (disabled.length) L.push(`- launchd-disabled jobs: ${disabled.join(', ')}`);
L.push('');
if (laneFails.length) {
  L.push('## ⚠️ Failures today');
  laneFails.slice(0, 8).forEach((f) => L.push(`- ${f}`));
  L.push('');
  L.push('> A thin board on a day with a lane failure is NOT evidence of a quiet market.');
  L.push('');
}
L.push('## Scoring');
L.push(`- scored today: **${t.total}** (${delta(t.total, y.total)})`);
L.push(`- qualifiers >=${QUALIFY}: **${t.qualified}** (${delta(t.qualified, y.qualified)}) — primary role ${t.primary}, other targets ${t.other}`);
L.push(`- verdicts: ${Object.entries(t.verdicts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
if (Object.keys(t.sources).length) L.push(`- by lane: ${Object.entries(t.sources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
else L.push('- by lane: *(source column blank — attribution unavailable for these rows, not zero)*');
if (t.top.length) { L.push(''); t.top.slice(0, 8).forEach((q) => L.push(`  - ${q}`)); }
L.push('');
quota.forEach((q) => L.push(`> ${q}`));
L.push('');
L.push('## Queues');
for (const [k, v] of Object.entries(queues)) L.push(`- ${k}: **${v}**`);
L.push(`- index: ${idx.length - 1} employers, **${idxErr}** boards erroring (${idx404} dead slug/404 -> repair-index, ${idxAbort} scan timeout -> raise FETCH_TIMEOUT_MS/backoff)`);
if (queues['_web-roles.tsv'] > 100) L.push(`- ⚠️ _web-roles is deep (${queues['_web-roles.tsv']}); it is drained by the morning run's score lane (SCORE_CAP per run).`);
L.push('');
// Request ledger (scripts/request-ledger.mjs): requests per host family over the last 24h.
{
  const rows = readLedger({ sinceIso: new Date(Date.now() - 864e5).toISOString() });
  const agg = aggregate(rows);
  L.push('## Requests (last 24h, data/_request-ledger.tsv)');
  if (!agg.size) L.push('- *(no ledger rows: no lane recorded a request, or the ledger is not wired into that lane)*');
  for (const [fam, e] of agg) L.push(`- ${fam}: **${e.requests}** (${fmtStatuses(e.statuses)})`);
  L.push('');
  // Health signals: status classes, round caps, Unproven 0 roles, nomination resolve rate.
  let roles = [], syn = () => [];
  try { const T = await import('./targets.mjs'); roles = T.loadTargets().targets.roles; syn = T.synonymsFor; } catch {}
  const titles = [];
  for (const [f, col] of [['data/scored-jobs.tsv', 2], ['data/_web-roles.tsv', 2], ['data/_candidates.tsv', 2]]) {
    for (const l of lines(f).slice(1)) { const c = l.split('\t'); if (c[0] === today && c[col]) titles.push(c[col]); }
  }
  const nomRows = readNominations().filter((r) => r.date >= localDay(new Date(Date.now() - 7 * 864e5)));
  const h = healthLines({ agg, indexRows: parseTsv(read('data/company-index.tsv')).rows, roles, synonymsFor: syn, titles, ledgerRows: nomRows });
  L.push('## Health signals');
  for (const w of h.warnings) L.push(`- ⚠️ **${w}**`);
  if (!h.warnings.length) L.push('- no warnings');
  for (const l of h.lines.filter((x) => !/^HTTP by family/.test(x) && !/^  \S+: \d+ \(/.test(x))) L.push(`- ${l.trim()}`);
  L.push('');
}
L.push('## Downstream (the stage that actually binds)');
L.push(`- qualifiers in the tracker (data/applications.md, all time): **${qualTotal}**${qualTotal ? ' — ' + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') : ''}${!qualTotal && t.qualified ? ` *(today's ${t.qualified} qualifier(s) are not in the tracker yet: the reports lane writes the row)*` : ''}`);
if (owed) L.push(`- ${owed}`);
if (awaiting != null) L.push(`- outreach awaiting a pick: **${awaiting}** (node scripts/outreach-queue.mjs awaiting)`);
if (overdue != null) L.push(`- follow-ups overdue: **${overdue}** (node scripts/followup-cadence.mjs --overdue-only)`);
if (live) L.push(`- ${live}`);
L.push('');

const md = L.join('\n');
writeFileSync('data/_daily-digest.md', md + '\n');
if (JSON_OUT) console.log(JSON.stringify({ today, scored: t, yesterday: y, crons, disabled, laneFails, queues, idxErr, byStatus, qualTotal, awaiting, overdue }, null, 2));
else if (!QUIET) console.log(md);
else console.log(`digest written → data/_daily-digest.md`);
