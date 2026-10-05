#!/usr/bin/env node

/**
 * linkedin.mjs — master on/off switch for ALL LinkedIn scraping activity.
 *
 * Toggles the data/LINKEDIN_OFF sentinel that scan-roster.mjs (logged-in /people/
 * scraping) and speed-linkedin.mjs (guest job-card comb) hard-check on startup.
 * While OFF, both scripts refuse to run and the hourly pipeline's LinkedIn step no-ops;
 * ATS + web-search scanning keep running.
 *
 * Usage:
 *   node scripts/linkedin.mjs status   # show current state (default)
 *   node scripts/linkedin.mjs off      # disable all LinkedIn scraping
 *   node scripts/linkedin.mjs on       # re-enable LinkedIn scraping
 */

import { existsSync, writeFileSync, rmSync } from 'fs';

const SENTINEL = new URL('../data/LINKEDIN_OFF', import.meta.url);
const cmd = (process.argv[2] || 'status').toLowerCase();
const isOff = () => existsSync(SENTINEL);

const OFF_TEXT = `LinkedIn activity is DISABLED (toggled via scripts/linkedin.mjs).

While this file exists, all LinkedIn scraping is hard-blocked:
  - scripts/scan-roster.mjs    (logged-in /people/ + persona-search scraping)
  - scripts/speed-linkedin.mjs (guest job-card comb)
The hourly pipeline still runs ATS + web-search; its LinkedIn step no-ops.

Turn it back ON:   node scripts/linkedin.mjs on
Check the state:   node scripts/linkedin.mjs status
`;

switch (cmd) {
  case 'on':
  case 'enable':
    if (isOff()) { rmSync(SENTINEL); console.log('✅ LinkedIn activity is now ON — scan-roster + speed-linkedin will run again.'); }
    else console.log('✅ LinkedIn activity is already ON.');
    break;
  case 'off':
  case 'disable':
    if (!isOff()) { writeFileSync(SENTINEL, OFF_TEXT); console.log('⛔ LinkedIn activity is now OFF — scan-roster + speed-linkedin are blocked; the hourly pipeline keeps ATS + web only.'); }
    else console.log('⛔ LinkedIn activity is already OFF.');
    break;
  case 'status':
    console.log(isOff()
      ? '⛔ LinkedIn activity is OFF (data/LINKEDIN_OFF present). Turn on:  node scripts/linkedin.mjs on'
      : '✅ LinkedIn activity is ON. Turn off:  node scripts/linkedin.mjs off');
    break;
  default:
    console.log('Usage: node scripts/linkedin.mjs [on|off|status]');
    process.exit(1);
}
