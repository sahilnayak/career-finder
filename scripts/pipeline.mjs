#!/usr/bin/env node

/**
 * pipeline.mjs — master on/off switch for the whole daily pipeline.
 *
 * Toggles the data/PIPELINE_OFF sentinel that scripts/pipeline-cron.sh hard-checks at startup,
 * before it takes its lock and before the deferred-backlog recovery. While OFF the 06:00 launchd
 * job still fires, finds the sentinel, logs one line and exits 0. Nothing is scanned, scored,
 * drafted or spent.
 *
 * WHY A SENTINEL AND NOT `launchctl disable`: a launchd disable is invisible from inside the repo
 * and has no expiry, so a disabled job can stay dark for days without anyone noticing. This sentinel is visible to `git status`, carries the date it was set,
 * and pipeline-digest.mjs reports it every single day WITH A DAY COUNT, so an indefinite pause
 * cannot quietly become a permanent one.
 *
 * Related but different: data/_pipeline-skip-dates.txt pauses specific DATES and self-expires.
 * Use that for "not this weekend". Use this for "stop until I say otherwise".
 *
 * Usage:
 *   node scripts/pipeline.mjs status   # show current state (default)
 *   node scripts/pipeline.mjs off      # pause the pipeline indefinitely
 *   node scripts/pipeline.mjs on       # resume
 */

import { existsSync, writeFileSync, rmSync, readFileSync } from 'fs';

const SENTINEL = new URL('../data/PIPELINE_OFF', import.meta.url);
const cmd = (process.argv[2] || 'status').toLowerCase();
const isOff = () => existsSync(SENTINEL);

// LOCAL date, never toISOString(): a UTC date points at tomorrow from 5pm Pacific onward, and this
// stamp is what the digest counts days from.
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const setOn = () => localDay();
const pausedSince = () => {
  try { return (readFileSync(SENTINEL, 'utf-8').match(/^since:\s*(\d{4}-\d{2}-\d{2})/m) || [])[1] || null; }
  catch { return null; }
};
const daysSince = (iso) => {
  if (!iso) return null;
  const then = new Date(`${iso}T00:00:00`), now = new Date(`${localDay()}T00:00:00`);
  return Math.max(0, Math.round((now - then) / 864e5));
};

const offText = (reason) => `since: ${setOn()}
reason: ${reason}

The career-finder pipeline is PAUSED (toggled via scripts/pipeline.mjs).

While this file exists, scripts/pipeline-cron.sh exits immediately at 06:00 without taking its
lock: no index sweep, no LinkedIn comb, no scoring, no outreach bullets, no token spend. The
launchd job itself is untouched and still fires, which is deliberate — a job that still runs and
reports "paused" is recoverable, a job disabled in launchd is easily forgotten.

pipeline-digest.mjs reports this pause and how many days it has been in effect, every day.

Turn it back ON:   node scripts/pipeline.mjs on
Check the state:   node scripts/pipeline.mjs status
`;

switch (cmd) {
  case 'on':
  case 'enable':
  case 'resume': {
    if (isOff()) {
      const since = pausedSince(), d = daysSince(since);
      rmSync(SENTINEL);
      console.log(`✅ Pipeline is now ON — the next 06:00 run will scan and score again.` +
        (since ? `  (was paused ${d} day${d === 1 ? '' : 's'}, since ${since})` : ''));
    } else console.log('✅ Pipeline is already ON.');
    break;
  }
  case 'off':
  case 'disable':
  case 'pause': {
    const reason = process.argv.slice(3).join(' ') || 'paused on request, no reason given';
    if (!isOff()) {
      writeFileSync(SENTINEL, offText(reason));
      console.log('⛔ Pipeline is now PAUSED — the 06:00 job will exit immediately and spend nothing.');
      console.log('   Resume with:  node scripts/pipeline.mjs on');
    } else console.log(`⛔ Pipeline is already PAUSED (since ${pausedSince() || 'unknown'}).`);
    break;
  }
  case 'status': {
    if (!isOff()) { console.log('✅ Pipeline is ON. Pause with:  node scripts/pipeline.mjs off'); break; }
    const since = pausedSince(), d = daysSince(since);
    console.log(`⛔ Pipeline is PAUSED (data/PIPELINE_OFF present)` +
      (since ? ` since ${since} — ${d} day${d === 1 ? '' : 's'}` : '') +
      `.\n   Resume with:  node scripts/pipeline.mjs on`);
    break;
  }
  default:
    console.log('Usage: node scripts/pipeline.mjs [on|off|status] ["reason"]');
    process.exit(1);
}
