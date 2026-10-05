#!/usr/bin/env node

/**
 * guest-verify.mjs — confirm a LinkedIn profile's CURRENT employer anonymously.
 *
 * Unauthenticated GET of linkedin.com/in/<slug> returns og:title "Name - Headline | LinkedIn"
 * (~40% hit rate; misses/authwalls return nothing). Costs ZERO account budget — charges the
 * shared `guest` lane (2000/day) via li-budget.mjs and paces between slugs. Off-account but on the
 * residential IP: cheap, not free — never run at volume (linkedin-stealth skill).
 *
 * Born 2026-08-18: this exact check verified Sudhir Tonse and Taylor Rachor at Galileo
 * without spending a single search or profile action.
 *
 * Usage: node scripts/guest-verify.mjs <slug> [<slug> ...]
 * Output (TSV): slug<TAB>og:title-or-MISS
 */

import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import { spend as liSpend } from './li-budget.mjs';

// INTERACTIVE-ONLY (item #21). Spends the shared LinkedIn profile budget. The scheduled run (morning.mjs) sets UNATTENDED=1 and runs
// claude with --dangerously-skip-permissions, so this must never fire from cron.
if (!process.stdout.isTTY || process.env.UNATTENDED === '1') {
  console.error('guest-verify: refused — interactive-only (no TTY or UNATTENDED=1). Run it yourself from a terminal.');
  process.exit(2);
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36';
const slugs = process.argv.slice(2).map(s => s.replace(/^.*\/in\//, '').replace(/\/.*$/, '')).filter(Boolean);
if (!slugs.length) { console.error('usage: node scripts/guest-verify.mjs <slug> [<slug> ...]'); process.exit(1); }
if (slugs.length > 15) { console.error('refusing >15 slugs in one run — guest is cheap, not free (stealth skill).'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const slug of slugs) {
  if (!liSpend('guest').ok) { console.error('guest budget cap reached — stopping.'); process.exit(3); }
  try {
    const html = execFileSync('curl', ['-s', '--max-time', '20', '-A', UA, `https://www.linkedin.com/in/${slug}`],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const m = html.match(/<meta property="og:title" content="([^"]*)"/);
    console.log(`${slug}\t${m ? m[1] : 'MISS (authwall or bad slug)'}`);
  } catch { console.log(`${slug}\tMISS (fetch error)`); }
  if (slugs.length > 1) await sleep(3000 + Math.random() * 4000);
}
