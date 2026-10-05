#!/usr/bin/env node

/**
 * quota-guard.mjs — make a quota-exhausted pipeline run FAIL LOUDLY and RECOVER LATER,
 * instead of logging ten failures and exiting 0 as if the market were quiet.
 *
 * THE BUG THIS EXISTS FOR. `claude -p` prints "You've hit your session limit · resets 12pm" and
 * **still exits 0**. Every LLM step in morning.mjs therefore "succeeds", the run exits 0,
 * launchctl reports success, and the board shows nothing. That is indistinguishable from a genuinely
 * quiet morning — except jobs WERE found and simply never scored.
 *
 * Measured in data/_pipeline.log, session-limit hits inside the 07:00 run:
 *     2026-08-20: 0    2026-08-21: 0    2026-08-22: 4    2026-08-23: 4    2026-08-24: 6
 *
 * On 2026-08-24 the sweep found Hippocratic AI (Agent Deployment Engineer, Menlo Park) and Datadog,
 * the LinkedIn lane reported OK, and NOTHING was scored. The board read 0. The cause is a SHARED
 * 5-hour quota window: heavy interactive/swarm use overnight leaves the 07:00 cron with nothing.
 *
 * Same silent-failure family as the stale dashboard binary and the wall-clock cron gate: it looks
 * healthy and is not.
 *
 * Usage:
 *   node scripts/quota-guard.mjs check <logfile>   # did this run hit the limit? sets the marker
 *   node scripts/quota-guard.mjs status            # is a deferred backlog pending? exit 0 if yes
 *   node scripts/quota-guard.mjs clear             # backlog scored; remove the marker
 *   node scripts/quota-guard.mjs mark [--mode daily|speed|hot] [--resets 12pm] [--hits N]
 *                                                  # caller already saw the wall (morning.mjs exit-3 path)
 *
 * Generic API (audited for item #10): nothing here assumes a role family. The unscored count reads
 * the shared ledgers only; the run slice starts at morning.mjs's "<mode> run start" banner (or the
 * legacy "pipeline start"), so a whole-day log is never re-scanned.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const MARKER = 'data/_QUOTA_DEFERRED.json';
const cmd = process.argv[2];
const arg = process.argv[3];

// The exact strings `claude -p` emits when it is out of quota. Matching the SPECIFIC condition
// matters: a crash, a bad prompt and a quota wall are three different failures and only this one
// is worth retrying unchanged.
const LIMIT_RE = /hit your session limit|usage limit reached|rate limit.*resets|quota exceeded/i;
const flag = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

/** Count what is sitting unscored right now, so the marker records the real cost of the miss. */
function unscoredCount() {
  let scored = new Set();
  try {
    scored = new Set(readFileSync('data/scored-jobs.tsv', 'utf-8').split('\n')
      .map((l) => (l.split('\t')[6] || '').trim()).filter(Boolean));
  } catch { /* no ledger yet */ }
  let n = 0;
  for (const f of ['data/_web-roles.tsv', 'data/_aged-roles.tsv', 'data/_candidates.tsv']) {
    try {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        const c = line.split('\t');
        const url = (c[5] || c[6] || '').trim();
        if (/^https?:\/\//.test(url) && !scored.has(url)) n++;
      }
    } catch { /* file may not exist */ }
  }
  return n;
}

if (cmd === 'check') {
  const log = arg && existsSync(arg) ? readFileSync(arg, 'utf-8') : '';
  // Only inspect THIS run: everything after the last "pipeline start" banner.
  const lastStart = Math.max(log.lastIndexOf('pipeline start'), log.lastIndexOf(' run start'));
  const slice = lastStart > -1 ? log.slice(lastStart) : log;
  const hits = (slice.match(LIMIT_RE) || []).length;

  if (!hits) {
    if (existsSync(MARKER)) { unlinkSync(MARKER); console.log('quota-guard: run completed with quota available; cleared a stale marker.'); }
    else console.log('quota-guard: no quota problem in this run.');
    process.exit(0);
  }

  const m = RESET_RE.exec(slice);
  const resetsAt = m ? `${m[1]}${m[2] ? ':' + m[2] : ':00'}${m[3].toLowerCase()}` : 'unknown';
  const pending = unscoredCount();
  writeFileSync(MARKER, JSON.stringify({
    deferred_at: new Date().toISOString(),
    limit_hits: hits,
    resets_at: resetsAt,
    unscored_when_deferred: pending,
    note: 'Scoring did NOT run — the quota was exhausted, not the market. Candidates are collected and waiting.',
  }, null, 2) + '\n');

  console.error(`!! QUOTA EXHAUSTED — scoring did NOT run (${hits} limit hits, resets ${resetsAt}).`);
  console.error(`!! ${pending} candidate(s) are collected and UNSCORED. This is NOT a quiet market.`);
  console.error(`!! Marker written to ${MARKER}; a later pass will score the backlog once quota returns.`);
  process.exit(3);   // distinct from 0 (fine) and 2 (a real failure)
}

if (cmd === 'mark') {
  const pending = unscoredCount();
  writeFileSync(MARKER, JSON.stringify({
    deferred_at: new Date().toISOString(),
    limit_hits: Number(flag('--hits', 1)) || 1,
    resets_at: flag('--resets', 'unknown'),
    mode: flag('--mode', 'unknown'),
    unscored_when_deferred: pending,
    note: 'Scoring did NOT run — the quota was exhausted, not the market. Candidates are collected and waiting.',
  }, null, 2) + '\n');
  console.log(`quota-guard: marker written (${pending} unscored).`);
  process.exit(0);
}

if (cmd === 'status') {
  if (!existsSync(MARKER)) { console.log('no deferred backlog'); process.exit(1); }
  const m = JSON.parse(readFileSync(MARKER, 'utf-8'));
  const pending = unscoredCount();
  console.log(`deferred since ${m.deferred_at} (quota reset ${m.resets_at}); ${pending} unscored now`);
  process.exit(pending > 0 ? 0 : 1);   // exit 0 means "there is work to do"
}

if (cmd === 'clear') {
  if (existsSync(MARKER)) { unlinkSync(MARKER); console.log('quota-guard: backlog cleared.'); }
  else console.log('quota-guard: nothing to clear.');
  process.exit(0);
}

console.error('usage: quota-guard.mjs check <logfile> | status | clear | mark [--mode m] [--resets t] [--hits n]');
process.exit(64);
