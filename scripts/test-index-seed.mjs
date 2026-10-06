#!/usr/bin/env node
/**
 * test-index-seed.mjs — offline tests for the starter index, --import mode, repair backoff and the
 * sector registries. No network. Temp dirs only; never writes the real data/ files.
 *
 *   node scripts/test-index-seed.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'cf-test-seed-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ ${m}`); } };
const src = f => readFileSync(join(REPO, f), 'utf8');

const T = await import('./lib/index-tsv.mjs');
const R = await import('./lib/repair-schedule.mjs');
const { detectApi, PARSERS } = await import('./scan-core.mjs');
const FX = join(REPO, 'scripts/fixtures/index-import');
const other = T.parseTsv(readFileSync(join(FX, 'other-index.tsv'), 'utf8')).rows;
const local = T.parseTsv(readFileSync(join(FX, 'local-index.tsv'), 'utf8')).rows;

console.log('\n1. dead-status and board key');
ok(['error: HTTP 404', 'migrated to workday', 'gone', 'dead board', 'HTTP 410'].every(T.isDeadStatus), 'dead statuses recognised (404/410/gone/dead/migrated)');
ok(!['', '12 jobs / 3 kept', 'error: HTTP 429', 'error: This operation was aborted', 'repaired 2026-10-01'].some(T.isDeadStatus), 'live and transient statuses are not dead');
ok(T.rowKey(local[0]) === T.rowKey(other[3 + 1]), 'includeCompensation flag does not change the key (Delta local vs incoming)');
ok(T.rowKey(other[2]) === T.rowKey(other[3]), 'trailing slash does not change the key (Gamma vs Gamma Dup)');
ok(T.rowKey(other[5]).startsWith('url:'), 'row without an API falls back to careers_url');

console.log('\n2. mergeImport');
{
  const { rows, stats } = T.mergeImport(local, other, { today: '2026-10-06' });
  const by = n => rows.find(r => r.company === n);
  ok(!by('Beta Dead') && !by('Foxtrot Moved'), 'rows marked 404 / migrated are skipped');
  ok(stats.skippedDead === 2, `2 dead rows counted (got ${stats.skippedDead})`);
  ok(rows.filter(r => /gamma/i.test(r.ats_api_url)).length === 1, 'duplicate api collapses to one row');
  ok(stats.skippedDuplicate === 1, 'the duplicate is counted once');
  ok(by('Delta Local') && !by('Delta') && by('Delta Local').source === 'mine' && by('Delta Local').last_status === '9 jobs / 1 kept', 'a live local row is never overwritten');
  ok(stats.skippedLiveLocal === 1, 'live-local skip counted');
  ok(by('Gamma') && !by('Gamma Old') && stats.revived === 1, 'a DEAD local row is replaced by the live incoming one');
  ok(by('Alpha') && by('Echo Browser') && stats.added === 2, 'new rows are added (api row and browser-only row)');
  ok(by('Echo Browser').ats_api_url === '', 'browser-only row keyed on careers_url, no API invented');
  const sc = T.mergeImport([], other, { scrub: true, source: 'starter', today: '2026-10-06' }).rows;
  ok(sc.length > 0 && sc.every(r => r.source === 'starter' && r.last_scanned === '' && r.last_status === ''), '--scrub resets last_scanned/last_status and stamps source=starter');
}

console.log('\n3. build-company-index.mjs --import (CLI)');
{
  const into = join(TMP, 'idx.tsv');
  copyFileSync(join(FX, 'local-index.tsv'), into);
  const r = spawnSync('node', ['scripts/build-company-index.mjs', '--import', join(FX, 'other-index.tsv'), '--into', into], { cwd: REPO, encoding: 'utf8', env: { ...process.env, CAREER_FINDER_PROFILE: '/nonexistent' } });
  const out = T.parseTsv(readFileSync(into, 'utf8'));
  ok(r.status === 0, `import runs without a profile (exit ${r.status})`);
  ok(out.header.join('\t') === T.INDEX_COLS.join('\t'), 'output keeps the canonical 9-column header');
  ok(out.rows.length === 4 && out.rows.some(x => x.company === 'Delta Local'), `merged file has 4 rows (got ${out.rows.length})`);
  const dry = join(TMP, 'dry.tsv');
  spawnSync('node', ['scripts/build-company-index.mjs', '--import', join(FX, 'other-index.tsv'), '--into', dry, '--dry-run'], { cwd: REPO, encoding: 'utf8' });
  ok(!existsSync(dry), '--dry-run writes nothing');
}

console.log('\n4. bundled starter index');
{
  const seed = T.parseTsv(src(T.SEED_PATH));
  ok(seed.header.join('\t') === T.INDEX_COLS.join('\t'), 'starter has the canonical header');
  ok(seed.rows.length >= 1000, `starter carries boards (${seed.rows.length})`);
  ok(seed.rows.every(r => r.source === 'starter' && !r.last_scanned && !r.last_status), 'starter is scrubbed (source=starter, no scan history)');
  ok(!seed.rows.some(r => T.isDeadStatus(r.last_status)), 'starter has no dead rows');
  const keys = seed.rows.map(T.rowKey); ok(new Set(keys).size === keys.length, 'starter has no duplicate boards');
  ok(seed.rows.filter(r => r.ats_api_url).length > 900, 'most starter rows carry an ATS API URL');
  // ensureSeedIndex on a throwaway root
  const root = join(TMP, 'root'); mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(join(root, 'templates'), { recursive: true });
  copyFileSync(join(REPO, T.SEED_PATH), join(root, T.SEED_PATH));
  const a = T.ensureSeedIndex({ root });
  ok(a.restored && a.rows === seed.rows.length, 'missing index is restored from the seed');
  writeFileSync(join(root, 'data/company-index.tsv'), T.INDEX_HEADER);
  ok(T.ensureSeedIndex({ root }).restored, 'header-only index is restored from the seed');
  writeFileSync(join(root, 'data/company-index.tsv'), T.INDEX_HEADER + 'Mine\t\thttps://jobs.ashbyhq.com/mine\tashby\t\tmine\t2026-10-06\t\t\n');
  const b = T.ensureSeedIndex({ root });
  ok(!b.restored && b.rows === 1, 'an index with rows is never overwritten');
  ok(/ensureSeedIndex/.test(src('scripts/doctor.mjs')) && /ensureSeedIndex/.test(src('scripts/scan-index.mjs')) && /ensureSeedIndex/.test(src('scripts/update-system.mjs')), 'doctor, scan-index and update-system apply all restore the seed');
}

console.log('\n5. repair backoff math');
{
  ok(R.BACKOFF_WEEKS.join(',') === '1,2,4', 'schedule is 1, 2, 4 weeks');
  ok([1, 2, 3, 4, 9].map(R.backoffWeeks).join(',') === '1,2,4,4,4', 'attempt 1/2/3 -> 1/2/4 weeks, then stays at 4');
  ok(R.nextCheckDate('2026-10-06', 1) === '2026-10-13', '1st failure -> +7 days');
  ok(R.nextCheckDate('2026-10-06', 2) === '2026-10-20', '2nd failure -> +14 days');
  ok(R.nextCheckDate('2026-10-06', 3) === '2026-11-03', '3rd failure -> +28 days');
  ok(R.nextCheckDate('2026-12-20', 2) === '2027-01-03', 'date math crosses a year boundary');
  ok(R.isDue(undefined, '2026-10-06') && !R.isDue({ next_check: '2026-10-13' }, '2026-10-12') && R.isDue({ next_check: '2026-10-13' }, '2026-10-13'), 'due when unscheduled or next_check <= today');
  let e = R.recordFailure(undefined, { key: 'k', company: 'X', today: '2026-10-06', result: 'no board found' });
  ok(e.attempts === '1' && e.next_check === '2026-10-13', 'first failure recorded');
  e = R.recordFailure(e, { key: 'k', company: 'X', today: '2026-10-13' });
  ok(e.attempts === '2' && e.next_check === '2026-10-27', 'second failure doubles the wait');
  const p = join(TMP, 'sched.tsv'); R.saveSchedule(p, new Map([['k', e]]));
  ok(R.loadSchedule(p).get('k').next_check === '2026-10-27', 'schedule round-trips through the sidecar file');
}

console.log('\n6. nonsense-slug control');
{
  const asked = [];
  const spa = await R.nonsenseControl(s => `https://h.example/${s}`, async u => { asked.push(u); return { ok: true, count: 5 }; }, () => 'abc');
  ok(spa.host200sAnything === true && /zz-nope-/.test(spa.controlUrl) && asked.length === 1, 'a host that returns jobs for a nonsense slug is flagged as SPA (one request)');
  const real = await R.nonsenseControl(s => `https://h.example/${s}`, async () => ({ ok: false, count: 0 }));
  ok(real.host200sAnything === false, 'a host that 404s a nonsense slug passes');
  const empty = await R.nonsenseControl(s => `https://h.example/${s}`, async () => ({ ok: true, count: 0 }));
  ok(empty.host200sAnything === false, '200 with zero jobs is not treated as SPA behaviour');
  const rep = src('scripts/repair-index.mjs');
  ok(/nonsenseControl/.test(rep) && /hostIsSpa/.test(rep) && /_repair-schedule\.tsv/.test(rep) && /isDue/.test(rep), 'repair-index wires the control and the backoff schedule');
  ok(/"repair"/.test(src('package.json')) && /Weekly repair/.test(src('docs/SCHEDULING.md')) && /repair-index\.mjs', \['--apply'\]/.test(src('scripts/morning.mjs')), 'npm run repair, SCHEDULING.md and the Monday lane are in place');
}

console.log('\n7. registries');
{
  const dir = join(REPO, T.REGISTRY_DIR);
  const files = readdirSync(dir).filter(f => f.endsWith('.tsv')).sort();
  ok(files.join(',') === 'bigtech.tsv,finance.tsv,healthcare.tsv', `three sector files (${files.join(',')})`);
  let all = [];
  for (const f of files) {
    const t = T.parseTsv(readFileSync(join(dir, f), 'utf8'));
    const errs = T.validateRegistryRows(t.rows, t.header);
    ok(errs.length === 0, `${f} schema clean${errs.length ? ': ' + errs.slice(0, 3).join('; ') : ''}`);
    ok(t.header.join('\t') === T.REGISTRY_COLS.join('\t'), `${f} header is the canonical registry header`);
    all = all.concat(t.rows.map(r => ({ ...r, sector: f.replace('.tsv', '') })));
  }
  ok(all.length >= 50, `about 50 boards listed (${all.length})`);
  const verified = all.filter(r => r.status === 'verified');
  ok(verified.length >= 30, `at least 30 verified boards (${verified.length})`);
  ok(new Set(all.map(r => r.company.toLowerCase())).size === all.length, 'no company listed twice');
  ok(['Sutter Health', 'UCSF Health', 'Wells Fargo', 'NVIDIA', 'Airbnb'].every(n => all.some(r => r.company === n)), 'named anchors present (Sutter, UCSF, Wells Fargo, NVIDIA, Airbnb)');
  ok(verified.every(r => { const a = detectApi({ api: r.ats_api_url, careers_url: r.careers_url }); return a && PARSERS[a.type]; }), 'every verified row resolves to a family scan-core can parse');
  ok(all.filter(r => r.status === 'unverified').every(r => !r.ats_api_url && r.note), 'unverified rows store no guessed URL and say why');
  const ucsf = all.find(r => r.company === 'UCSF Health');
  ok(ucsf && ucsf.ats_type === 'oracle' && detectApi({ api: ucsf.ats_api_url }).type === 'oracle', 'UCSF Oracle HCM (CX_1) is read by the existing oracle parser');
  const sutter = all.find(r => r.company === 'Sutter Health');
  ok(sutter && sutter.status === 'verified' && /myworkdaysite/.test(sutter.ats_api_url), 'Sutter (myworkdaysite host) is verified now that scan-core builds its apply URLs');
  const sapi = detectApi({ api: sutter.ats_api_url, careers_url: sutter.careers_url });
  const sjob = PARSERS.workday({ jobPostings: [{ title: 'RN', externalPath: '/job/Sacramento/RN_R-1', locationsText: 'Sacramento', postedOn: 'Posted Today' }] }, 'Sutter Health', sapi)[0];
  ok(sjob.url === 'https://wd1.myworkdaysite.com/en-US/recruiting/sutterhealth/SH/job/Sacramento/RN_R-1', `myworkdaysite apply URL is built on the myworkdaysite host (${sjob.url})`);
  const sapi2 = detectApi({ careers_url: sutter.careers_url });
  ok(sapi2?.type === 'workday' && sapi2.url === sutter.ats_api_url, 'the myworkdaysite careers URL alone resolves to the same Workday API');
  const scan = T.registryScanRows(all, []);
  ok(scan.length === verified.filter(r => r.ats_api_url).length && scan.every(r => r.source.startsWith('registry:')), 'registryScanRows returns exactly the verified rows');
  const dupe = T.registryScanRows(all, [{ ats_api_url: verified[0].ats_api_url }]);
  ok(dupe.length === scan.length - 1, 'a registry board already in the company index is not swept twice');
  ok(/loadRegistries/.test(src('scripts/scan-index.mjs')) && /data\/registries/.test(src('DATA_CONTRACT.md')), 'scan-index reads registries; DATA_CONTRACT documents them');
  ok(T.validateRegistryRows([{ company: 'X', status: 'verified', verified_on: '2026-10-06', how_verified: 'y', ats_api_url: '' }]).length > 0, 'validator rejects a verified row with no URL');
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
