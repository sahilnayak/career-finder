#!/usr/bin/env node
/**
 * test-nominate.mjs — offline tests for build-plan steps 5-6 and the HiringCafe browser default.
 * No network, temp dirs only.   node scripts/test-nominate.mjs
 */
import './fixtures/use-test-profile.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'cf-test-nominate-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ ${m}`); } };
const src = (f) => readFileSync(join(REPO, f), 'utf8');

const H = await import('./lib/hiringcafe-fetch.mjs');
const N = await import('./lib/nominate.mjs');
const HL = await import('./lib/health.mjs');
const { detectApi } = await import('./scan-core.mjs');

console.log('\n1. HiringCafe: browser-first transport');
ok((await H.chooseTransport({ alive: async () => true })).first === 'browser', 'Chrome alive -> browser first');
ok((await H.chooseTransport({ alive: async () => false })).first === 'plain', 'no Chrome -> plain GET');
ok((await H.chooseTransport({ alive: async () => { throw new Error('x'); } })).first === 'plain', 'a throwing probe counts as no Chrome');
ok((await H.chooseTransport({ noBrowser: true, alive: async () => true })).first === 'plain', '--no-browser wins over a live Chrome');
ok(H.skipReason() === 'hiringcafe: Cloudflare 403 and no Chrome; run npm run linkedin:login to start the browser profile', 'skip reason text is the specified one');
ok(/browser is disabled/.test(H.skipReason({ noBrowser: true })), 'skip reason names the flag when the browser was disabled on purpose');
ok(H.EXIT_SKIPPED === 4, 'skip exit code is 4');
const scan = src('scripts/hiringcafe-scan.mjs'), morning = src('scripts/morning.mjs');
ok(/chooseTransport/.test(scan) && /skipReason/.test(scan) && /EXIT_SKIPPED/.test(scan) && /--allow-browser/.test(scan), 'hiringcafe-scan uses the transport helpers and accepts --allow-browser');
ok(/'hiringcafe'[\s\S]{0,80}'--allow-browser'[\s\S]{0,60}skipExit: 4/.test(morning), 'morning.mjs runs the hiringcafe lane browser-first and maps exit 4 to a logged skip');
ok(/429/.test(scan) && /BACKOFF_S/.test(scan), 'HTTP 429 retry is still there');

console.log('\n2. HiringCafe: __NEXT_DATA__ handling');
const page = (o) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: o } })}</script></html>`;
ok(H.parseNextData(page({ ssrHits: [1] })).ok, 'parses a good page');
ok(H.parseNextData('<html>cf</html>').reason === 'no-next-data', 'missing script -> no-next-data');
ok(H.parseNextData('<script id="__NEXT_DATA__" type="application/json">{bad</script>').reason === 'bad-json', 'broken JSON -> bad-json');
{
  const logs = [];
  const nd = () => Object.assign(new Error('no __NEXT_DATA__'), { noNextData: true });
  const fetchPage = async (p) => { if (p === 2) throw nd(); return { hits: [`h${p}`], last: p === 3, total: 9 }; };
  const r = await H.collectPages(fetchPage, { maxPages: 5, log: (m) => logs.push(m) });
  ok(r.hits.join() === 'h0,h1,h3' && r.skippedPages.join() === '2', 'a later page without __NEXT_DATA__ is skipped, the other pages are kept');
  ok(logs.length === 1 && /page 2/.test(logs[0]), 'the skipped page is logged');
  const r2 = await H.collectPages(async (p) => { if (p === 4) throw nd(); return { hits: [p], last: false }; }, { maxPages: 5 });
  ok(r2.hits.length === 4 && r2.truncated === true, 'a skipped FINAL page still reports truncated, never a clean sweep');
  let threw = false;
  try { await H.collectPages(async () => { throw nd(); }, { maxPages: 5 }); } catch { threw = true; }
  ok(threw, 'page 0 without __NEXT_DATA__ still fails loudly (SSR contract changed)');
  let threw2 = false;
  try { await H.collectPages(async (p) => { if (p === 1) throw new Error('HTTP 500'); return { hits: [1], last: false }; }, { maxPages: 3 }); } catch { threw2 = true; }
  ok(threw2, 'other errors on a later page are not swallowed');
}

console.log('\n3. Board roots');
ok(N.boardRootFromUrl('https://job-boards.greenhouse.io/acme/jobs/123') === 'https://job-boards.greenhouse.io/acme', 'greenhouse job url -> board root');
ok(N.boardRootFromUrl('https://jobs.ashbyhq.com/beta/0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f') === 'https://jobs.ashbyhq.com/beta', 'ashby job url -> board root');
ok(N.boardRootFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/x_R1') === 'https://acme.wd5.myworkdayjobs.com/External', 'workday url skips the locale segment');
ok(N.boardRootFromUrl('https://www.linkedin.com/jobs/view/123') === null && N.boardRootFromUrl('https://hiring.cafe/x') === null, 'LinkedIn and aggregator urls are not boards');
ok(N.controlRoot('https://jobs.ashbyhq.com/beta', 'zz9') === 'https://jobs.ashbyhq.com/zz9', 'control root swaps the slug');
ok(N.applyHrefTierOn({}) === false && N.applyHrefTierOn({ linkedin: true }) === false, 'Apply-href tier defaults OFF');
ok(N.applyHrefTierOn({ linkedin_apply_href_tier: true }) && N.applyHrefTierOn({ linkedin: { apply_href_tier: true } }), 'tier ON via the flat key or the nested key');
ok(/linkedin_apply_href_tier: false/.test(src('config/profile.example.yml')), 'example profile documents the flag, default false');
ok(/LI_APPLY_HREF_TIER/.test(morning) && /LI_APPLY_HREF_TIER \? Math\.max/.test(morning), 'morning.mjs gates the crawl rescue on the tier flag');

console.log('\n4. Nomination flow (fixtures, no network)');
const mk = (name) => { const d = join(TMP, name); mkdirSync(d, { recursive: true }); return d; };
const idxHeader = 'company\thq\tcareers_url\tats_type\tats_api_url\tsource\tdate_added\tlast_scanned\tlast_status\n';
const webHeader = 'date\tcompany\trole\tlocation\tposted\turl\tsource\n';
const BOARDS = {
  'https://boards-api.greenhouse.io/v1/boards/acme/jobs': [1, 2, 3],
  'https://api.ashbyhq.com/posting-api/job-board/beta?includeCompensation=true': [1],
  'https://api.lever.co/v0/postings/epsilon': [1, 2],
  // SPA host: answers for ANY slug, so a 200 proves nothing
  'https://api.smartrecruiters.com/v1/companies/gamma/postings?limit=100': [1],
  'https://api.smartrecruiters.com/v1/companies/zz-control/postings?limit=100': [1],
};
const fetchBoard = async (api) => BOARDS[api.url] || [];
const deps = {
  fetchBoard, detectApi,
  probeName: async (n) => (n === 'Epsilon' ? 'https://jobs.lever.co/epsilon' : null),
  workdayTenant: async () => null,
};
function setup(name) {
  const d = mk(name);
  writeFileSync(join(d, 'company-index.tsv'), idxHeader + 'Existing Co\t\thttps://job-boards.greenhouse.io/existing\tgreenhouse\thttps://boards-api.greenhouse.io/v1/boards/existing/jobs\tstarter\t2026-10-01\t\t\n');
  writeFileSync(join(d, '_web-roles.tsv'), webHeader + [
    ['2026-10-06', 'Beta', 'AE', 'SF', '', 'https://jobs.ashbyhq.com/beta/0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f', 'hiringcafe'],
    ['2026-10-06', 'Gamma', 'AE', 'SF', '', 'https://jobs.smartrecruiters.com/gamma/744000-ae', 'linkedin-loggedin'],
    ['2026-10-06', 'Delta', 'AE', 'SF', '', 'https://www.linkedin.com/jobs/search-results/?keywords=ae', 'linkedin-email-alert'],
    ['2026-10-06', 'Epsilon', 'AE', 'SF', '', 'https://www.linkedin.com/jobs/view/999', 'linkedin-loggedin'],
    ['2026-10-06', 'Zeta Staffing', 'AE', 'SF', '', 'https://jobs.lever.co/zeta/0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f', 'hiringcafe'],
    ['2026-10-06', 'Existing Co', 'AE', 'SF', '', 'https://job-boards.greenhouse.io/existing/jobs/1', 'hiringcafe'],
    ['2026-10-06', 'Websearch Only', 'AE', 'SF', '', 'https://jobs.lever.co/ws/0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f', 'websearch'],
  ].map((r) => r.join('\t')).join('\n') + '\n');
  writeFileSync(join(d, '_hiringcafe.tsv'), 'date\tcompany\trole\turl\tmin_yoe\tseniority\trole_type\tworkplace_type\tcomp_min\tcomp_max\tbachelors\tclearance\tats\thiringcafe_claimed_date\tfit\n' +
    ['2026-10-06', 'Acme', 'AE', 'https://acme.example/careers/1', '', '', '', '', '', '', '', '', 'grnhse/acme', '', ''].join('\t') + '\n');
  writeFileSync(join(d, '_speed-li.json'), JSON.stringify([{ title: 'AE', company: 'Eta Guest', url: 'https://www.linkedin.com/jobs/view/123456789', loc: 'SF' }]));
  return d;
}
const d1 = setup('run1');
const res = await N.runNominationLoop({ dataDir: d1, deps, noise: ['staffing'], nonsense: 'zz-control', now: () => '2026-10-06' });
const by = Object.fromEntries(res.results.map((r) => [r.company, r.status]));
ok(by.Acme === 'resolved' && by.Beta === 'resolved' && by.Epsilon === 'resolved', 'HiringCafe token, apply url and slug probe each resolve to a board');
ok(by.Gamma === 'control-failed', 'a host that answers for a nonsense slug is rejected (control check)');
ok(by.Delta === 'unresolved' && by['Eta Guest'] === 'unresolved', 'employers with no board are unresolved, not guessed');
ok(by['Zeta Staffing'] === 'noise' && by['Existing Co'] === 'already-indexed', 'noise and already-indexed employers are skipped');
ok(!('Websearch Only' in by), 'only HiringCafe / LinkedIn / alert lanes nominate');
const idx = readFileSync(join(d1, 'company-index.tsv'), 'utf8').trim().split('\n');
ok(idx.length === 1 + 1 + 3 && /Acme\t\thttps:\/\/job-boards\.greenhouse\.io\/acme\tgreenhouse\thttps:\/\/boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\tnomination:hiringcafe\t2026-10-06/.test(idx.join('\n')), 'resolved boards are appended to the index with the 9-column shape');
const nb = readFileSync(join(d1, '_new-boards.tsv'), 'utf8').trim().split('\n');
ok(nb[0] === 'company\tcareers_url' && nb.length === 4, '_new-boards.tsv lists exactly the new boards (scan-index --only reads it)');
const ledger = N.readLedger(d1);
ok(ledger.length === 6 && !ledger.some((r) => r.status === 'noise' || r.status === 'already-indexed'), 'ledger records attempts only');
const rr = N.resolveRate(ledger);
ok(rr.resolved === 3 && rr.attempts === 6 && Math.abs(rr.rate - 0.5) < 1e-9, 'resolve rate = resolved / attempts (3/6)');
ok(/resolve rate 50% \(3\/6, target 70%\)/.test(res.summary), 'summary prints the rate against the 70% target');
const res2 = await N.runNominationLoop({ dataDir: d1, deps, noise: ['staffing'], nonsense: 'zz-control', now: () => '2026-10-07' });
ok(res2.added.length === 0 && res2.results.filter((r) => r.status === 'skipped-recent-fail').length === 3, 'a rerun adds nothing and does not re-probe recent failures');
ok(readFileSync(join(d1, '_new-boards.tsv'), 'utf8').trim() === 'company\tcareers_url', '_new-boards.tsv is rewritten each run (no stale boards)');
const dry = setup('dry');
await N.runNominationLoop({ dataDir: dry, deps, noise: [], nonsense: 'zz-control', dryRun: true, now: () => '2026-10-06' });
ok(!existsSync(join(dry, '_nominations.tsv')) && !existsSync(join(dry, '_new-boards.tsv')) && readFileSync(join(dry, 'company-index.tsv'), 'utf8').split('\n').length === 3, '--dry-run writes nothing');

console.log('\n5. Probe and Workday caps; LinkedIn budget');
{
  const d = mk('caps');
  writeFileSync(join(d, 'company-index.tsv'), idxHeader);
  writeFileSync(join(d, '_web-roles.tsv'), webHeader + ['P1', 'P2', 'P3', 'P4'].map((c) => `2026-10-06\t${c}\tAE\tSF\t\thttps://www.linkedin.com/jobs/search-results/?k=1\tlinkedin-loggedin`).join('\n') + '\n');
  let probed = 0, wd = 0;
  const r = await N.runNominationLoop({ dataDir: d, probeCap: 2, workdayCap: 1, nonsense: 'zz', now: () => '2026-10-06',
    deps: { ...deps, probeName: async () => { probed++; return null; }, workdayTenant: async () => { wd++; return null; } } });
  ok(probed === 2 && wd === 1, 'probe cap 2 and workday cap 1 are honoured');
  ok(r.results.filter((x) => x.status === 'deferred').length === 2, 'employers past the probe cap are deferred, not counted as failures');
  const lg = N.resolveRate(r.results);
  ok(lg.failed === r.results.filter((x) => x.status === 'unresolved').length && lg.attempts === 2, 'deferrals are not attempts, so they never lower the resolve rate');
}
{
  // ONE counter: the 3/day cap is read back from li-budget's event log; nothing else is written.
  const ev = join(mk('ev'), 'li-events.tsv');
  const fakeLi = { EVENTS_PATH: ev, claims: 0, claim(kind, note) { this.claims++; writeFileSync(ev, (existsSync(ev) ? readFileSync(ev, 'utf8') : '') + [new Date().toISOString(), kind, 'spend', note, '', 1].join('\t') + '\n'); return { ok: true }; } };
  const sleeps = [];
  const nowD = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const b = N.makeGuestBudget({ li: fakeLi, sleep: async (ms) => sleeps.push(ms), now: nowD });
  const got = [await b.take(), await b.take(), await b.take(), await b.take()];
  ok(got.join() === 'true,true,true,false', 'at most 3 Apply-href lookups a day');
  ok(fakeLi.claims === 3, 'each lookup is exactly ONE li-budget charge (no second counter)');
  ok(sleeps.length === 2 && sleeps.every((ms) => ms >= 10_000), 'requests are paced at least 10s apart');
  const b2 = N.makeGuestBudget({ li: fakeLi, sleep: async () => {}, now: nowD });
  ok(!(await b2.take()) && fakeLi.claims === 3, 'the daily count survives a new process (read from li-budget events)');
  const b3 = N.makeGuestBudget({ li: fakeLi, sleep: async () => {}, now: () => '2099-01-01' });
  ok(await b3.take(), 'the count resets on a new day');
  const refused = N.makeGuestBudget({ li: { EVENTS_PATH: ev, claim: () => ({ ok: false }) }, sleep: async () => {}, now: () => '2099-02-02' });
  ok(!(await refused.take()), 'a refused li-budget claim refuses the lookup');
  const src = readFileSync(new URL('./lib/nominate.mjs', import.meta.url), 'utf8');
  ok(!/writeFileSync\([^)]*_nominate-state/.test(src) && !/claim\('jobsearch', 'nominate applyurl'\)/.test(src), 'no second counter file and applyHref does not double-charge');
}
{
  // tier ON: guest cap bounds the logged-in lookups too; tier OFF never calls applyHref
  const mkd = (n) => { const d = mk(n); writeFileSync(join(d, 'company-index.tsv'), idxHeader);
    writeFileSync(join(d, '_web-roles.tsv'), webHeader + [1, 2, 3, 4, 5].map((i) => `2026-10-06\tL${i}\tAE\tSF\t\thttps://www.linkedin.com/jobs/view/${100000000 + i}\tlinkedin-loggedin`).join('\n') + '\n'); return d; };
  let calls = 0;
  const dd = { ...deps, probeName: async () => null, applyHref: async () => { calls++; return null; } };
  await N.runNominationLoop({ dataDir: mkd('tier-off'), deps: dd, tierOn: false, nonsense: 'zz', now: () => '2026-10-06', budget: { take: async () => true, used: () => 0 } });
  ok(calls === 0, 'tier OFF: applyHref is never called');
  await N.runNominationLoop({ dataDir: mkd('tier-on'), deps: dd, tierOn: true, nonsense: 'zz', now: () => '2026-10-06', budget: (() => { let n = 0; return { take: async () => n++ < 3, used: () => n }; })() });
  ok(calls === 3, `tier ON: bounded by the 3/day guest cap (got ${calls})`);
}

console.log('\n6. The 527 HiringCafe boards would have been ingested');
{
  const d = mk('bulk');
  writeFileSync(join(d, 'company-index.tsv'), idxHeader);
  const rows = Array.from({ length: 527 }, (_, i) => ['2026-10-06', `Emp ${i}`, 'AE', `https://x.example/${i}`, '', '', '', '', '', '', '', '', `${['grnhse', 'ashby', 'lever'][i % 3]}/emp-${i}`, '', ''].join('\t'));
  writeFileSync(join(d, '_hiringcafe.tsv'), 'date\tcompany\trole\turl\tmin_yoe\tseniority\trole_type\tworkplace_type\tcomp_min\tcomp_max\tbachelors\tclearance\tats\thiringcafe_claimed_date\tfit\n' + rows.join('\n') + '\n');
  let probed = 0;
  const r = await N.runNominationLoop({ dataDir: d, nonsense: 'zz', now: () => '2026-10-06',
    deps: { ...deps, fetchBoard: async (api) => (/zz/.test(api.url) ? [] : [1]), probeName: async () => { probed++; return null; } } });
  ok(r.added.length === 527 && probed === 0, 'all 527 source-token boards resolve with zero probes');
}

console.log('\n7. Kill switch');
{
  const d = setup('off-file');
  writeFileSync(join(d, 'NOMINATE_OFF'), '');
  const r = await N.runNominationLoop({ dataDir: d, deps, now: () => '2026-10-06' });
  ok(r.off && r.results.length === 0 && readFileSync(join(d, 'company-index.tsv'), 'utf8').split('\n').length === 3, 'data/NOMINATE_OFF stops the loop and writes nothing');
  ok(N.nominateOff({ dataDir: mk('off-env'), env: { NOMINATE_OFF: '1' } }) !== null, 'NOMINATE_OFF=1 stops the loop');
  const d2 = mk('off-pipe'); writeFileSync(join(d2, 'PIPELINE_OFF'), '');
  ok(N.nominateOff({ dataDir: d2, env: {} }) !== null, 'PIPELINE_OFF also stops it');
  ok(N.nominateOff({ dataDir: mk('on'), env: {} }) === null, 'no switch -> runs');
  ok(/nominateOff/.test(morning) && /'nominate', 'scripts\/resolve-nominations\.mjs'/.test(morning), 'morning.mjs checks the switch and runs the nominate lane');
  ok(/data\/NOMINATE_OFF/.test(src('scripts/schedule.mjs')) && /NOMINATE_OFF/.test(src('docs/SCHEDULING.md')), 'schedule status and docs list the switch');
}

console.log('\n8. Lane order in morning.mjs');
{
  const at = (s) => morning.indexOf(s);
  ok(at("'scripts/hiringcafe-scan.mjs'") < at("node('nominate'") && at("node('linkedin:email-alerts'") < at("node('nominate'"), 'nominate runs after hiringcafe and the LinkedIn lanes');
  ok(at("node('nominate'") < at("node('ats:new-boards'") && at("node('nominate'") < at("claude('score'") , 'nominate runs before the new-board sweep and before scoring');
}

console.log('\n9. Health signals');
{
  const agg = new Map([['hiringcafe', { requests: 20, statuses: { 403: 12, cdp: 8 } }], ['ashby', { requests: 50, statuses: { 200: 50 } }]]);
  const sb = HL.statusBreakdown(agg);
  ok(sb.find((f) => f.family === 'hiringcafe').bad['403'] === 12 && !sb.find((f) => f.family === 'hiringcafe').bad.cdp, 'per-family status counts split 403 from the neutral cdp marker');
  const idxRows = [
    { company: 'A', ats_type: 'workday', last_status: '200 jobs / 3 kept' }, { company: 'B', ats_type: 'ashby', last_status: '37 jobs / 1 kept' },
    { company: 'C', ats_type: 'workday', last_status: '10000 jobs / 9 kept' }, { company: 'D', ats_type: 'greenhouse', last_status: 'error: HTTP 404' },
  ];
  const caps = HL.roundCapBoards(idxRows);
  ok(caps.total === 2 && caps.byFamily.workday.length === 2 && !caps.byFamily.ashby, 'round-cap boards are found per family');
  const pr = HL.unprovenRoles({ roles: ['Data Engineer', 'Registered Nurse'], synonymsFor: (r) => (r === 'Registered Nurse' ? ['RN'] : ['Analytics Engineer']), titles: ['Senior Data Engineer', 'Learning Coordinator'] });
  ok(pr[0].hits === 1 && !pr[0].unproven, 'a role with a matching title has hits');
  ok(pr[1].unproven && pr[1].hits === 0, 'a role with no hits is Unproven 0 ("RN" does not match "Learning")');
  const led = [...Array(3)].map(() => ({ status: 'resolved' })).concat([...Array(4)].map(() => ({ status: 'unresolved' })), [{ status: 'already-indexed' }, { status: 'deferred' }]);
  const nh = HL.nominationHealth(led);
  ok(nh.attempts === 7 && nh.belowTarget, 'resolve rate ignores skips and flags below 70%');
  const h = HL.healthLines({ agg, indexRows: idxRows, roles: ['Registered Nurse'], synonymsFor: () => ['RN'], titles: [], ledgerRows: led });
  const text = h.lines.join('\n');
  ok(/Registered Nurse: Unproven 0/.test(text), 'digest block carries the "Unproven 0" label');
  ok(/hiringcafe: 20 \(403:12 cdp:8\)/.test(text), 'digest block carries per-status counts per family');
  ok(h.warnings.some((w) => /ROUND CAP: workday has 2 board/.test(w)), 'a round cap is a loud warning');
  ok(h.warnings.some((w) => /hiringcafe returned non-2xx/.test(w)) && h.warnings.some((w) => /below the 70% target/.test(w)), 'blocked family and low resolve rate are loud warnings');
  const clean = HL.healthLines({ agg: new Map([['ashby', { requests: 50, statuses: { 200: 50 } }]]), ledgerRows: [{ status: 'resolved' }, { status: 'resolved' }, { status: 'unresolved' }] });
  ok(clean.warnings.length === 1 && /below the 70%/.test(clean.warnings[0]), 'a clean ledger with 2/3 resolved warns only about the resolve rate');
  ok(HL.healthLines({ agg: new Map([['ashby', { requests: 50, statuses: { 200: 50 } }]]), ledgerRows: [{ status: 'resolved' }, { status: 'resolved' }, { status: 'resolved' }, { status: 'unresolved' }] }).warnings.length === 0, 'a healthy run (3/4 resolved, all 200) raises no warnings');
  const scanSrc = src('scripts/scan-index.mjs');
  const m = scanSrc.match(/ROUND_CAPS = \[([^\]]+)\]/);
  ok(m && m[1].replace(/ATS_MAX_JOBS/, '10000').split(',').map((x) => Number(x.trim())).join() === HL.ROUND_CAPS.join(), 'health ROUND_CAPS matches scan-index ROUND_CAPS');
  ok(/healthLines/.test(src('scripts/pipeline-digest.mjs')) && /healthLines/.test(src('scripts/doctor.mjs')), 'doctor and the digest both print the health block');
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
