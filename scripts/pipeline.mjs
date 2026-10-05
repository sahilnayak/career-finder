#!/usr/bin/env node

/**
 * pipeline.mjs — master on/off switch for the whole daily pipeline.
 *
 * Toggles the data/PIPELINE_OFF sentinel that scripts/morning.mjs checks at startup (every mode:
 * daily, speed, hot), before it takes its lock and before the deferred-backlog replay. While OFF the
 * scheduled job (launchd on macOS, crontab on Linux) still fires, finds the sentinel, writes one
 * "run SKIPPED ... (since: DATE)" line to its log and exits 0. Nothing is scanned, scored or spent.
 *
 * WHY A SENTINEL AND NOT disabling the scheduler: a disabled launchd/cron entry is invisible from
 * inside the repo and has no expiry, so a disabled job can stay dark for days without anyone noticing. This sentinel is visible to `git status`, carries the date it was set,
 * and pipeline-digest.mjs reports it every single day WITH A DAY COUNT, so an indefinite pause
 * cannot quietly become a permanent one.
 *
 * Related but different: data/_pipeline-skip-dates.txt pauses specific DATES and self-expires.
 * Use that for "not this weekend". Use this for "stop until I say otherwise".
 *
 * Usage:
 *   node scripts/pipeline.mjs status   # state, HOT_OFF, skip-dates, today's claude calls vs daily_claude_cap
 *   node scripts/pipeline.mjs off      # pause the pipeline indefinitely      (npm run pipeline:off)
 *   node scripts/pipeline.mjs on       # resume                               (npm run pipeline:on)
 *   node scripts/pipeline.mjs hot-off  # pause hot mode only (data/HOT_OFF)
 *   node scripts/pipeline.mjs hot-on   # resume hot mode
 */

import { existsSync, writeFileSync, rmSync, readFileSync } from 'fs';

const SENTINEL = new URL('../data/PIPELINE_OFF', import.meta.url);
const HOT_OFF = new URL('../data/HOT_OFF', import.meta.url);
const SKIP_DATES = new URL('../data/_pipeline-skip-dates.txt', import.meta.url);
const CALL_LOG = new URL('../data/_claude-calls.log', import.meta.url);
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

While this file exists, scripts/morning.mjs (daily, speed and hot) logs a SKIPPED line and exits
before taking its lock: no index sweep, no LinkedIn comb, no scoring, no outreach bullets, no token
spend. The scheduled job itself is untouched and still fires, which is deliberate — a job that
still runs and reports "paused" is recoverable, a job disabled in the scheduler is easily forgotten.

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
      console.log(`✅ Pipeline is now ON — the next scheduled run will scan and score again.` +
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
      console.log('⛔ Pipeline is now PAUSED — scheduled runs will log SKIPPED and spend nothing.');
      console.log('   Resume with:  node scripts/pipeline.mjs on');
    } else console.log(`⛔ Pipeline is already PAUSED (since ${pausedSince() || 'unknown'}).`);
    break;
  }
  case 'hot-off': {
    writeFileSync(HOT_OFF, `since: ${localDay()}\n`);
    console.log('⛔ Hot mode PAUSED (data/HOT_OFF). Resume with:  node scripts/pipeline.mjs hot-on');
    break;
  }
  case 'hot-on': {
    if (existsSync(HOT_OFF)) rmSync(HOT_OFF);
    console.log('✅ Hot mode is ON (if scheduled with --with-hot).');
    break;
  }
  case 'status': {
    if (!isOff()) console.log('✅ Pipeline is ON. Pause with:  npm run pipeline:off');
    else {
      const since = pausedSince(), d = daysSince(since);
      console.log(`⛔ Pipeline is PAUSED (data/PIPELINE_OFF present)` +
        (since ? ` since ${since} — ${d} day${d === 1 ? '' : 's'}` : '') +
        `.\n   Resume with:  npm run pipeline:on`);
    }
    if (existsSync(HOT_OFF)) console.log('   hot mode: PAUSED (data/HOT_OFF)');
    try {
      const today = localDay();
      const upcoming = readFileSync(SKIP_DATES, 'utf-8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(x => x >= today);
      if (upcoming.length) console.log(`   skip-dates: ${upcoming.join(', ')}${upcoming.includes(today) ? '  (TODAY is skipped)' : ''}`);
    } catch { /* no skip-dates file */ }
    let calls = 0;
    try { calls = readFileSync(CALL_LOG, 'utf-8').split('\n').filter(l => l.startsWith(localDay() + '\t')).length; } catch {}
    let cap = 40;
    try {
      const { loadTargets } = await import('./targets.mjs');
      cap = Number(loadTargets().pipeline?.daily_claude_cap) || 40;
    } catch { /* no profile yet: default cap */ }
    console.log(`   claude calls today: ${calls}/${cap} (pipeline.daily_claude_cap; data/_claude-calls.log)`);
    break;
  }
  default:
    console.log('Usage: node scripts/pipeline.mjs [on|off|status|hot-on|hot-off] ["reason"]');
    process.exit(1);
}
