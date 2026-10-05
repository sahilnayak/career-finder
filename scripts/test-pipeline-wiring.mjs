#!/usr/bin/env node

/**
 * test-pipeline-wiring.mjs — static guard on how morning.mjs wires lanes to modes (item #27).
 *
 * OFFLINE and read-only: it parses scripts/morning.mjs, the router table in
 * .claude/skills/career-finder/SKILL.md and modes/*.md as text. It never runs a lane,
 * never calls claude, never touches data/.
 *
 *   (a) every claude -p prompt names its mode file (and that file exists)
 *   (b) the expected lanes exist per mode (daily / speed / hot)
 *   (c) logged-in LinkedIn (linkedin-crawl, linkedin-jobsearch) runs only inside DAILY
 *   (d) no claude call on an empty cycle: candidate-driven LLM lanes are count-gated
 *   (e) build-se-watchlist is absent
 *   (f) schedule.mjs --print: no /Users/YOU, only com.career-finder labels (skipped if absent)
 *   (g) every modes/*.md is in the router Automation column with a lane or "interactive-only"
 *
 *   node scripts/test-pipeline-wiring.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0, warnings = 0;
const pass = m => { console.log(`  ✅ ${m}`); passed++; };
const fail = m => { console.log(`  ❌ ${m}`); failed++; };
const warn = m => { console.log(`  ⚠️  ${m}`); warnings++; };
const check = (ok, m, why = '') => (ok ? pass(m) : fail(why ? `${m} — ${why}` : m));

const SRC = readFileSync(join(ROOT, 'scripts/morning.mjs'), 'utf8');
const LINES = SRC.split('\n');
const lineOf = idx => SRC.slice(0, idx).split('\n').length;

/** Index range [open, close] of the brace block opened by the first `{` at or after `from`. */
function blockAt(from) {
  const open = SRC.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return [open, i];
  }
  return [open, SRC.length];
}

/** Text of the nearest enclosing `if (...)` heads above line n (up to `span` lines back). */
function guardsAbove(n, span = 20) {
  return LINES.slice(Math.max(0, n - 1 - span), n).filter(l => /\bif \(/.test(l)).join('\n');
}

// Every claude('name', prompt...) call site (the helper definition excluded).
const CALLS = [...SRC.matchAll(/\bclaude\((['`])([^'`]+)\1,\s*/g)].map(m => {
  const at = m.index, n = lineOf(at);
  const next = SRC.indexOf('\n  claude(', at + 1);
  const body = SRC.slice(at, Math.min(next > 0 ? next : SRC.length, at + 6000));
  return { name: m[2], at, line: n, head: SRC.slice(m.index + m[0].length, m.index + m[0].length + 400), body };
});

// ── (a) prompts name their mode file ───────────────────────────────────
console.log('\n(a) every claude -p prompt names its mode file');
check(CALLS.length >= 8, `found ${CALLS.length} claude() call sites`);
const FOLLOW = (SRC.match(/const FOLLOW_OFFER = '([^']+)'/) || [])[1] || '';
for (const c of CALLS) {
  const head = c.head.replace('${FOLLOW_OFFER}', FOLLOW).replace(/\$\{headless\('([^']+)'\)\}/g, 'modes/$1.md');
  const files = [...head.matchAll(/modes\/([\w-]+)\.md/g)].map(m => m[1]);
  if (!files.length) { fail(`${c.name} (morning.mjs:${c.line}) prompt opens without naming a modes/*.md file`); continue; }
  const missing = files.filter(f => !existsSync(join(ROOT, 'modes', `${f}.md`)));
  check(!missing.length, `${c.name} -> modes/${files[0]}.md`, missing.length ? `missing ${missing.join(', ')}` : '');
}
for (const mode of [...new Set([...SRC.matchAll(/headless\('([\w-]+)'\)/g)].map(m => m[1]))]) {
  const md = existsSync(join(ROOT, 'modes', `${mode}.md`)) ? readFileSync(join(ROOT, 'modes', `${mode}.md`), 'utf8') : '';
  check(/^## Headless\b/m.test(md), `modes/${mode}.md has the "## Headless" section the prompt loads`);
}
if (/modes\/feedback\.md/.test(SRC)) {
  const fb = readFileSync(join(ROOT, 'modes/feedback.md'), 'utf8');
  check(/^## Outcomes \(headless\)/m.test(fb), 'modes/feedback.md has "## Outcomes (headless)"');
}
check(!/auto-pipeline\.md/.test(CALLS.find(c => c.name === 'reports')?.head || ''), 'reports prompt names offer.md, not auto-pipeline.md');

// ── (b) expected lanes per mode ────────────────────────────────────────
console.log('\n(b) expected lanes exist per mode');
const hotStart = SRC.indexOf("if (MODE === 'hot') {");
const [hotOpen, hotClose] = hotStart >= 0 ? blockAt(hotStart) : [-1, -1];
const HOT = hotStart >= 0 ? SRC.slice(hotOpen, hotClose) : '';
check(hotStart >= 0, 'hot mode block exists');
for (const l of ['hot:sweep', 'hot:score', 'reconcile', 'quota']) check(HOT.includes(`'${l}'`), `hot: lane ${l}`);
check(/process\.exit\(/.test(HOT), 'hot: exits before the daily/speed lanes');

/** Index of the lane's CALL SITE (node/claude/lane/verify), not a mention in the lane->skill map. */
const laneIdx = name => {
  const re = new RegExp(`\\b(node|claude|lane)\\((['\`])${name.replace(/[:.]/g, '\\$&')}\\2`);
  const m = SRC.match(re);
  if (m) return m.index;
  const v = SRC.indexOf(`const name = '${name}'`);
  return v;
};
const DAILY_ONLY = ['discover', 'websearch', 'portals-scan', 'hiringcafe', 'workable', 'browser-boards', 'probe-ats',
  'discover-companies', 'resolve-nominations', 'reports', 'merge-tracker', 'pipeline-owed', 'outreach-bullets',
  'near-miss:score', 'keep-search:score', 'outcomes', 'feedback-outcomes', 'digest', 'linkedin:email-alerts', 'hot-list:build'];
for (const l of DAILY_ONLY) {
  const i = laneIdx(l);
  if (i < 0) { fail(`daily: lane ${l} missing`); continue; }
  const n = lineOf(i);
  check(/DAILY/.test(LINES[n - 1]) || /DAILY/.test(guardsAbove(n)), `daily: lane ${l} (morning.mjs:${n}) behind a DAILY gate`);
}
const elseSpeed = SRC.indexOf('} else {', laneIdx('ats:index'));
const SPEED = elseSpeed > 0 ? SRC.slice(elseSpeed, SRC.indexOf('\n}\n', elseSpeed)) : '';
for (const l of ['ats:index', 'speed:primary-gap']) check(SPEED.includes(`'${l}'`), `speed: lane ${l} in the non-daily branch`);
for (const l of ['score', 'linkedin:guest', 'snapshot-jd']) check(laneIdx(l) > hotClose, `speed+daily: lane ${l} outside the hot block`);
check(/\['--hours', '12'/.test(SPEED) && !/--browser-queue/.test(SPEED.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), 'speed: ats:index 12h, no --browser-queue (#19)');

// ── (c) logged-in LinkedIn only inside DAILY ───────────────────────────
console.log('\n(c) logged-in LinkedIn only inside DAILY');
const liStart = SRC.indexOf('} else if (DAILY && liWanted) {');
check(liStart >= 0, 'logged-in LinkedIn block is `else if (DAILY && liWanted)`');
const [liOpen, liClose] = liStart >= 0 ? blockAt(liStart + 2) : [-1, -1];
const oneShot = blockAt(SRC.indexOf("if (flag('--linkedin-test'))"));
for (const m of SRC.matchAll(/linkedin-(crawl|jobsearch)\.mjs/g)) {
  const n = lineOf(m.index);
  const inDaily = m.index > liOpen && m.index < liClose;
  const inOneShot = m.index > oneShot[0] && m.index < oneShot[1];   // --linkedin-test: manual, interactive
  check(inDaily || inOneShot, `linkedin-${m[1]} at morning.mjs:${n} is ${inOneShot ? 'the manual --linkedin-test' : 'inside DAILY'}`);
}
check(!/linkedin-(crawl|jobsearch)/.test(HOT) && !/linkedin-(crawl|jobsearch)/.test(SPEED), 'no logged-in LinkedIn in hot or speed');
check(/T\.integrations\?\.linkedin !== false/.test(SRC), 'integrations.linkedin defaults ON (only explicit false disables)');
check(/DAILY && liWanted && !PRE\.chrome/.test(SRC), 'no Chrome -> "linkedin: SKIPPED (no Chrome)", not a crash');

// ── (d) no claude call on an empty cycle ───────────────────────────────
console.log('\n(d) no claude call on an empty cycle');
// Candidate-driven lanes must be count-gated (`when:` on a row count, or an enclosing rowsIn/status check).
const GATES = {
  'hot:score': /when: DRY \|\| n > 0/,
  'score': /when: DRY \|\| ATS_N \+ LI_N \+ WEB_N > 0/,
  'outcomes': /when: applied > 0/,
};
for (const [name, re] of Object.entries(GATES)) {
  const c = CALLS.find(x => x.name === name);
  check(c && re.test(c.body), `${name}: gated on a non-empty input (${re.source})`);
}
const ctx = name => { const c = CALLS.find(x => x.name === name); return c ? guardsAbove(c.line, 6) : ''; };
check(/rowsIn\('data\/_candidates-primary-backstop\.tsv'\) > 0/.test(SRC), 'keep-search:score: only when the backstop file has rows');
check(/qs\.status === 0/.test(SRC.slice(laneIdx('quota-replay:score') - 400, laneIdx('quota-replay:score'))), 'quota-replay:score: only when quota-guard reports a backlog');
check(/!q\.met/.test(guardsAbove(CALLS.find(c => c.name === 'near-miss:score')?.line || 0, 12)), 'near-miss:score: only when the quota is short');
check(/onceToday\('discover'\)/.test(ctx('discover')), 'discover: at most once a day');
check(/no outreach drafts/.test(SRC.slice(SRC.indexOf('function verifyOutreach'), SRC.indexOf('function verifyOutreach') + 1500)), 'verify-outreach: no drafts -> no claude call');
// The two cost leaks found while writing this test; reported, not failed (morning.mjs is not this test's file).
const rep = CALLS.find(c => c.name === 'reports');
if (rep && !/when:/.test(rep.body.slice(0, rep.body.indexOf('\n}') > 0 ? rep.body.indexOf('\n}') : 4000)))
  warn(`reports (morning.mjs:${rep.line}) calls claude every daily run even when pipeline-owed reports nothing owed`);
if (!/onceToday\('websearch'\)/.test(ctx('websearch')))
  warn('websearch: no onceToday sentinel, so a second daily run (manual or retry) repeats the LLM call');
// Dry evidence: hot with no hot list exits before any claude call.
check(HOT.indexOf("rowsIn('data/hot-companies.tsv') === 0") < HOT.indexOf("claude('hot:score'"), 'hot: empty hot list exits before claude');

// ── (e) build-se-watchlist absent ──────────────────────────────────────
console.log('\n(e) build-se-watchlist absent');
check(!existsSync(join(ROOT, 'scripts/build-se-watchlist.mjs')), 'scripts/build-se-watchlist.mjs does not exist');
const g = spawnSync('git', ['grep', '-l', 'build-se-watchlist', '--', 'scripts', 'modes', '.claude', 'package.json'], { cwd: ROOT, encoding: 'utf8' });
const refs = (g.stdout || '').split('\n').filter(f => f && !/test-pipeline-wiring\.mjs$/.test(f));
check(!refs.length, 'no reference to build-se-watchlist in scripts/modes/.claude/package.json', refs.join(', '));
check(!/se-watchlist/.test(SRC), 'morning.mjs has no se-watchlist logic');

// ── (f) scheduler --print ──────────────────────────────────────────────
console.log('\n(f) schedule.mjs --print');
if (!existsSync(join(ROOT, 'scripts/schedule.mjs'))) {
  warn('SKIPPED: scripts/schedule.mjs not present yet (item #23); --print not checked');
} else {
  const r = spawnSync(process.execPath, ['scripts/schedule.mjs', '--print'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  check(r.status === 0, 'schedule.mjs --print exits 0', `exit ${r.status}`);
  check(!/\/Users\/YOU/.test(out), 'no /Users/YOU placeholder in --print output');
  const labels = [...out.matchAll(/\bcom\.[\w.-]+/g)].map(m => m[0]).filter(l => !/^com\.apple\./.test(l));
  check(labels.length > 0, 'prints at least one launchd label', 'none found (crontab-only host?)');
  const bad = labels.filter(l => !l.startsWith('com.career-finder'));
  check(!bad.length, 'only com.career-finder.* labels (never com.careerops.*)', [...new Set(bad)].join(', '));
  check(/morning\.mjs/.test(out), 'scheduled entries target morning.mjs');
}

// ── (g) router covers every mode ───────────────────────────────────────
console.log('\n(g) every mode is routed with a lane or interactive-only');
const SKILL = readFileSync(join(ROOT, '.claude/skills/career-finder/SKILL.md'), 'utf8');
const rows = new Map();
for (const l of SKILL.split('\n')) {
  const cells = l.split('|').map(s => s.trim());
  if (cells.length < 5) continue;
  for (const m of cells[2].matchAll(/`([\w-]+)`/g)) rows.set(m[1], cells[3]);
}
for (const f of readdirSync(join(ROOT, 'modes')).filter(f => f.endsWith('.md') && !f.startsWith('_'))) {
  const mode = f.replace(/\.md$/, '');
  const auto = rows.get(mode);
  if (auto === undefined) { fail(`modes/${f}: no router row`); continue; }
  check(/interactive-only/.test(auto) || /`[^`]+`|mode \(opt-in|rubric/.test(auto), `modes/${f}: ${auto.slice(0, 70)}`);
}

console.log(`\n📊 ${passed} passed, ${failed} failed, ${warnings} warnings`);
process.exit(failed ? 1 : 0);
