#!/usr/bin/env node

/**
 * test-li-safety.mjs — prove the LinkedIn guardrails actually fire.
 *
 * The scorer has tests (test-roster-score.mjs); this covers the other half: the
 * things that stand between a normal run and a banned account. Every assertion is
 * OFFLINE — no network, no browser, no LinkedIn. Run it freely, and run it after
 * ANY change to li-budget.mjs or the guard/claim path in scan-roster.mjs.
 *
 * It snapshots the real counter + event log up front and restores them at exit, so
 * running it never spends real budget or pollutes telemetry.
 *
 *   node scripts/test-li-safety.mjs
 */

import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = join(REPO, 'data/li-events.tsv');
const COOLDOWN = join(REPO, 'data/LI_COOLDOWN');
const KILL = join(REPO, 'data/LINKEDIN_OFF');
const day = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const USAGE = join(process.env.CAREER_FINDER_LI_DIR || join(REPO, 'data/li-usage'), `usage-${day()}.json`);

// ── snapshot real state so the test is non-destructive ──────────────────
mkdirSync(dirname(USAGE), { recursive: true });
const BAK = {
  events: existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8') : null,
  usage: existsSync(USAGE) ? readFileSync(USAGE, 'utf8') : null,
  cooldown: existsSync(COOLDOWN) ? readFileSync(COOLDOWN, 'utf8') : null,
};
function restore() {
  BAK.events === null ? rmSync(EVENTS, { force: true }) : writeFileSync(EVENTS, BAK.events);
  BAK.usage === null ? rmSync(USAGE, { force: true }) : writeFileSync(USAGE, BAK.usage);
  BAK.cooldown === null ? rmSync(COOLDOWN, { force: true }) : writeFileSync(COOLDOWN, BAK.cooldown);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✅ ${msg}`); pass++; } else { console.log(`  ❌ ${msg}`); fail++; } };

const li = await import('./li-budget.mjs');

// Start each group from a clean slate (the real state is restored at exit).
const reset = () => {
  rmSync(COOLDOWN, { force: true });
  writeFileSync(EVENTS, '');
  writeFileSync(USAGE, '{}');
};

console.log('\n1. The circuit breaker blocks every lane');
reset();
li.cooldown('unit test — synthetic', 6);
ok(li.inCooldown() !== null, 'a tripped cooldown is readable by a SEPARATE process (persisted, not in-memory)');
for (const lane of ['profile', 'search', 'pageview']) {
  ok(li.claim(lane, 'should be refused').ok === false, `claim('${lane}') is refused while cooling down`);
}
rmSync(COOLDOWN, { force: true });
ok(li.claim('profile', 'test').ok === true, 'claims resume once the cooldown is cleared');

console.log('\n2. An expired cooldown self-clears (it cannot wedge the pipeline shut)');
reset();
writeFileSync(COOLDOWN, JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), reason: 'expired', lane: 'all' }));
ok(li.inCooldown() === null, 'a past `until` reads as not-in-cooldown');
ok(!existsSync(COOLDOWN), '...and the stale sentinel file is removed');

console.log('\n3. Daily caps actually stop the loop');
reset();
const dayCap = li.HORIZONS.profile.day;
let refusedAt = null;
for (let i = 0; i < dayCap + 5; i++) {
  if (!li.claim('profile', `burn ${i}`).ok) { refusedAt = i; break; }
}
ok(refusedAt !== null, `profile claims are eventually refused (not unbounded)`);
ok(refusedAt <= dayCap, `refused at or before the day cap (${refusedAt} <= ${dayCap})`);

console.log('\n4. The rolling-hour burst window sees ALL account lanes together');
reset();
// The burst window must be the ONLY thing that stops us, so every lane used here needs a
// day cap comfortably above BURST_PER_HOUR and must be an ACCOUNT lane.
// (Recalibrated 2026-07-29 when BURST_PER_HOUR went 12 -> 40: the old lane mix was
// profile/search/pageview, but profile and search cap at 12/day so they refused on 'day'
// long before 40, and `pageview` is OFF_ACCOUNT so it never counts toward the burst at all.
// The test then passed only by accident of the caps, not because the window worked.)
// Account lanes only. `jobsearch` moved onto its own high-ceiling low-risk window, so leaving
// it in here made the loop spend 44 jobsearch claims that by design never touch the account
// burst counter -- the window never refused and the test failed for the right reason.
const burstLanes = Object.entries(li.HORIZONS)
  .filter(([k, h]) => h.day > 0 && !['pageview', 'page', 'guest'].includes(k) && !li.LOW_RISK_LANES.has(k))
  .map(([k]) => k);
ok(burstLanes.length > 0, `account lanes exist to burst-test (${burstLanes.join(', ') || 'NONE'})`);
// The window is only a guardrail if it can actually bind. If BURST_PER_HOUR ever drifts back
// above the SUM of the account daily caps, it becomes unreachable dead code again.
const accountDayTotal = burstLanes.reduce((n, k) => n + li.HORIZONS[k].day, 0);
ok(li.BURST_PER_HOUR < accountDayTotal,
  `BURST_PER_HOUR (${li.BURST_PER_HOUR}) is below the account lanes' combined day cap (${accountDayTotal}) — otherwise it can never fire`);
let burstRefusal = null;
for (let i = 0; i < accountDayTotal + 4; i++) {
  const lane = burstLanes[i % burstLanes.length];
  const r = li.claim(lane, `burst ${i}`);
  if (!r.ok && /hour/.test(r.reason || '')) { burstRefusal = { i, reason: r.reason }; break; }
}
ok(burstRefusal !== null, `the burst window fires across mixed lanes (BURST_PER_HOUR=${li.BURST_PER_HOUR})`);
if (burstRefusal) ok(/hour/.test(burstRefusal.reason), `...and names 'hour' as the blocked horizon: "${burstRefusal.reason}"`);

console.log('\n5. claim() writes telemetry; spend() does NOT (the bug that hid visits)');
reset();
li.claim('profile', 'telemetry check');
ok(li.horizons('profile').week === 1, "claim() is visible to the WEEKLY horizon");
ok(li.horizons('profile').hourAll === 1, "claim() is visible to the BURST window");
reset();
li.spend('profile');
ok(li.horizons('profile').week === 0, "spend() is INVISIBLE to horizons — never use it for a navigation");

console.log('\n6. The guest lane is off-account but still bounded');
reset();
ok(li.HORIZONS.guest.day > 0, 'guest has a daily bound (a stuck cron cannot hammer the endpoint)');
li.claim('guest', 'guest check');
ok(li.horizons('profile').hourAll === 0, 'guest does NOT consume the account-lane burst window');

console.log('\n6b. ONE jobsearch cap, derived from the morning workload');
ok(li.CAPS.jobsearch === li.HORIZONS.jobsearch.day && li.HORIZONS.jobsearch.day === li.JOBSEARCH_DAY_CAP, `CAPS.jobsearch == HORIZONS.jobsearch.day == JOBSEARCH_DAY_CAP (${li.JOBSEARCH_DAY_CAP})`);
ok(li.jobsearchDailyCap({ pages: 2 }) === 52, 'default: 2 x 4 roles x (2 crawl pages + faceted + semantic) + 20 rescues = 52');
ok(li.jobsearchDailyCap({ pages: 2, remote: true }) === 60, 'remote-country adds ONE faceted search per role (60), not a doubled form set');
ok(li.jobsearchDailyCap({ pages: 99 }) === li.jobsearchDailyCap({ pages: 4 }), 'linkedin_pages clamps at 4');
const ex = readFileSync(join(REPO, 'config/profile.example.yml'), 'utf8');
ok(/52\/day/.test(ex) && /li-budget\.mjs/.test(ex), 'config/profile.example.yml documents the default jobsearch cap');
const ljs = readFileSync(join(REPO, 'scripts/linkedin-jobsearch.mjs'), 'utf8');
ok(/claim\('jobsearch'/.test(ljs) && !/\bspend\('jobsearch'\)/.test(ljs), 'linkedin-jobsearch charges via claim() (events logged), not bare spend()');
reset();
li.claim('jobsearch', 'linkedin-jobsearch "x" faceted/local');
ok(/\tjobsearch\tspend\tlinkedin-jobsearch/.test(readFileSync(EVENTS, 'utf8')), 'a jobsearch claim lands in li-events.tsv');

console.log('\n7. The kill-switch hard-stops the account-risk scraper');
const killWasSet = existsSync(KILL);
writeFileSync(KILL, '');
const { spawnSync } = await import('child_process');
const r = spawnSync('node', [join(REPO, 'scripts/scan-roster.mjs'), '--company', 'unit-test-should-never-load'],
  { encoding: 'utf8', timeout: 30000, cwd: REPO, env: { ...process.env, CAREER_FINDER_PROFILE: process.env.CAREER_FINDER_PROFILE || join(REPO, 'scripts/fixtures/profile.test.yml') } });
ok(/LinkedIn activity is OFF/.test(r.stderr + r.stdout), 'scan-roster refuses to start while data/LINKEDIN_OFF exists');
ok(!/connectOverCDP|browser/i.test(r.stderr), '...and exits before touching the browser');
if (!killWasSet) unlinkSync(KILL);

console.log('\n' + '='.repeat(50));
console.log(`📊 ${pass} passed, ${fail} failed`);
if (fail) { console.log('🔴 A GUARDRAIL IS NOT WORKING — do not run against LinkedIn until this is green.'); process.exit(1); }
console.log('🟢 Guardrails verified (offline).');
