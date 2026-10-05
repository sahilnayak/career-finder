#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-finder
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'fs';
import { NARRATIVE_MD, LEGACY_NARRATIVE_MD } from './lib/paths.mjs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

function checkCv() {
  if (existsSync(join(projectRoot, 'cv.md'))) {
    return { pass: true, label: 'cv.md found' };
  }
  return {
    pass: false,
    label: 'cv.md not found',
    fix: [
      'Create cv.md in the project root with your CV in markdown',
      'See examples/ for reference CVs',
    ],
  };
}

function checkProfile() {
  if (existsSync(join(projectRoot, 'config', 'profile.yml'))) {
    return { pass: true, label: 'config/profile.yml found' };
  }
  return {
    pass: false,
    label: 'config/profile.yml not found',
    fix: [
      'Run: cp config/profile.example.yml config/profile.yml',
      'Then edit it with your details',
    ],
  };
}

function checkPortals() {
  if (existsSync(join(projectRoot, 'portals.yml'))) {
    return { pass: true, label: 'portals.yml found' };
  }
  return {
    pass: false,
    label: 'portals.yml not found',
    fix: [
      'Run: cp templates/portals.example.yml portals.yml',
      'Then customize with your target companies',
    ],
  };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

// The narrative moved from LEGACY_NARRATIVE_MD to NARRATIVE_MD (see lib/paths.mjs).
// Migrate once, never overwrite, and remove the old top-level folder only when it is empty.
function checkModesProfile() {
  const cur = join(projectRoot, NARRATIVE_MD), legacy = join(projectRoot, LEGACY_NARRATIVE_MD);
  if (existsSync(legacy) && !existsSync(cur)) {
    try {
      renameSync(legacy, cur);
      console.log(`  ↪ Migrated ${LEGACY_NARRATIVE_MD} → ${NARRATIVE_MD}`);
    } catch (e) {
      return { pass: false, onboarding: true, label: `could not migrate ${LEGACY_NARRATIVE_MD}`, fix: `Run: mv ${LEGACY_NARRATIVE_MD} ${NARRATIVE_MD}` };
    }
  } else if (existsSync(legacy) && existsSync(cur)) {
    console.log(`  ⚠️  Both ${LEGACY_NARRATIVE_MD} and ${NARRATIVE_MD} exist; using ${NARRATIVE_MD}. Merge and delete the old one by hand.`);
  }
  const oldDir = join(projectRoot, 'modes');
  try { if (existsSync(oldDir) && readdirSync(oldDir).length === 0) rmdirSync(oldDir); } catch { /* leave it */ }
  if (existsSync(cur)) {
    return { pass: true, label: `${NARRATIVE_MD} found`, onboarding: true };
  }
  return { pass: false, onboarding: true, label: `${NARRATIVE_MD} not found`, fix: 'Created by onboarding (archetypes, narrative, scoring weights)' };
}

async function checkTargets() {
  if (!existsSync(join(projectRoot, 'config', 'profile.yml'))) {
    return { pass: false, onboarding: true, label: 'targets not configured', fix: 'Created by onboarding' };
  }
  try {
    const { loadTargets } = await import('./targets.mjs');
    const t = loadTargets({ fresh: true });
    return { pass: true, label: `targets: ${t.targets.roles.join(', ')} (primary: ${t.targets.primary_role}) · ${t.location.remote_policy}` };
  } catch (e) {
    return { pass: false, onboarding: true, label: 'config/profile.yml has no usable targets', fix: String(e.message).split('\n') };
  }
}

/**
 * LinkedIn lane status: ok / not logged in / checkpoint / Chrome down / geo missing / disabled.
 * integrations.linkedin defaults ON; only an explicit `false` disables it. The login check loads
 * linkedin.com/feed in a background tab over raw CDP (one page view, no search budget).
 * DOCTOR_LI_LOGIN_STATE=ok|logged-out|checkpoint forces the result (offline tests).
 */
async function linkedinLane(integ, browser) {
  if (integ.linkedin === false) return ['LinkedIn job lanes — disabled (integrations.linkedin: false)', null];
  let chromeBin = null;
  try { chromeBin = (await import('./chrome-debug.mjs')).resolveChromeBin(); } catch {}
  if (!chromeBin) return ['LinkedIn job lanes — SKIPPED (no Chrome): install Chrome/Chromium or set CAREER_FINDER_CHROME', false];
  if (existsSync(join(projectRoot, 'data', 'LINKEDIN_OFF'))) return ['LinkedIn job lanes — kill-switch on (npm run linkedin:on)', null];
  let geo = '';
  try { geo = (await import('./li-geo.mjs')).liGeoId() || ''; } catch {}
  const geoNote = geo ? `geo ${geo}` : 'geo missing: set location.linkedin_geo_id (falls back to location text)';
  if (!browser && !process.env.DOCTOR_LI_LOGIN_STATE) return [`LinkedIn job lanes — Chrome down on :${Number(process.env.CAREER_FINDER_CDP_PORT) || 9222} (morning auto-starts it; to log in: npm run linkedin:login) · ${geoNote}`, false];
  let state = process.env.DOCTOR_LI_LOGIN_STATE || '';
  if (!state) {
    let page;
    try {
      const { newPage } = await import('./cdp.mjs');
      page = await newPage();
      await page.navigate('https://www.linkedin.com/feed/', { waitMs: 3000, loadTimeout: 30000 });
      const d = await page.evaluate(() => ({
        url: location.href,
        nav: !!document.querySelector('#global-nav, .global-nav, [data-test-global-nav]'),
        form: !!document.querySelector('#session_key, input[name=session_key], #username'),
        text: (document.body?.innerText || '').slice(0, 3000),
      }));
      state = /\/checkpoint\/|\/challenge/.test(d.url) || /unusual activity|security verification|are you a human/i.test(d.text) ? 'checkpoint'
        : (/\/authwall|\/login|\/uas\/login|\/signup/.test(d.url) || d.form || !(d.nav || /linkedin\.com\/(feed|jobs|mynetwork)/.test(d.url))) ? 'logged-out' : 'ok';
    } catch (e) { state = 'error'; } finally { try { await page?.close(); } catch {} }
  }
  if (state === 'chrome-down') return [`LinkedIn job lanes — Chrome down on :${Number(process.env.CAREER_FINDER_CDP_PORT) || 9222} (morning auto-starts it; to log in: npm run linkedin:login) · ${geoNote}`, false];
  if (state === 'ok') return [`LinkedIn job lanes — logged in · ${geoNote}`, geo ? true : false];
  if (state === 'checkpoint') return ['LinkedIn job lanes — checkpoint/CAPTCHA: clear it by hand in the debug Chrome', false];
  return [`LinkedIn job lanes — not logged in (npm run linkedin:login) · ${geoNote}`, false];
}

/** Optional lanes: reported, never counted as failures. */
async function optionalLanes() {
  const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
  let browser = false;
  try { browser = (await fetch(`http://127.0.0.1:${Number(process.env.CAREER_FINDER_CDP_PORT) || 9222}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
  const gm = join(homedir(), '.gmail-mcp');
  const gmail = existsSync(join(gm, 'credentials.json')) && existsSync(join(gm, 'gcp-oauth.keys.json'));
  // LinkedIn and Gmail lanes are opt-in via integrations.* in config/profile.yml; host state alone
  // never turns them on, so report "available but not enabled" when the flag is off.
  let integ = {};
  try { integ = (await import('./targets.mjs')).loadTargets({ fresh: true }).integrations || {}; } catch {}
  const gated = (label, flag, ok) => integ[flag] === true
    ? [label, ok]
    : [`${label} — ${ok ? 'available but not enabled' : 'not enabled'} (integrations.${flag}: false)`, null];
  // #16: the outcomes lane needs the gmail MCP registered with claude, not just the OAuth files.
  let gmailMcp = null;
  if (integ.gmail === true && has('claude')) {
    const r = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 20000 });
    gmailMcp = r.error ? false : r.status === 0 && /gmail/i.test((r.stdout || '') + (r.stderr || ''));
  }
  return [
    ['claude CLI (scoring, reports, web search)', has('claude')],
    ...(gmailMcp === null ? [] : [[`Gmail MCP in \`claude mcp list\`${gmailMcp ? '' : ' — missing or timed out; the morning outcomes lane will be skipped with this reason'}`, gmailMcp]]),
    await linkedinLane(integ, browser),
    gated('Gmail OAuth in ~/.gmail-mcp (job alerts, outcome detection)', 'gmail', gmail),
    ['go (dashboard build)', has('go')],
  ];
}

async function main() {
  console.log('\ncareer-finder doctor');
  console.log('================\n');

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    { ...checkCv(), onboarding: true },
    { ...checkProfile(), onboarding: true },
    { ...checkPortals(), onboarding: true },
    checkModesProfile(),
    await checkTargets(),
    checkFonts(),
    checkAutoDir('data'),
    checkAutoDir('output'),
    checkAutoDir('reports'),
  ];

  let failures = 0;

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('\nOptional lanes (the morning run skips any that are missing):');
  for (const [label, ok] of await optionalLanes()) console.log(`  ${ok ? green('✓') : dim(ok === null ? 'o' : '-')} ${label}`);

  console.log('');
  if (checks.some(c => !c.pass && c.onboarding)) {
    console.log('Result: needs onboarding. Open Claude Code in this folder and say "set me up" (give it your resume).');
    process.exit(1);
  }
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    console.log('Result: All checks passed. You\'re ready to go! Run `npm run morning:dry` to preview the daily run.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
