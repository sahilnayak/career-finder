#!/usr/bin/env node
/**
 * test-discovery-audit.mjs — offline tests for the measurement harness (request ledger,
 * truth fixture, recall math). No network, no browser, no LinkedIn. Never touches the real
 * data/li-events.tsv or data/_request-ledger.tsv: both are pointed at a temp dir BEFORE import.
 *
 *   node scripts/test-discovery-audit.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync , readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'cf-test-audit-'));
process.env.CAREER_FINDER_LI_EVENTS = join(TMP, 'li-events.tsv');
process.env.CAREER_FINDER_LI_DIR = join(TMP, 'li-usage');
// Clean up even when a check throws partway through.
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
process.env.CAREER_FINDER_LEDGER = join(TMP, '_request-ledger.tsv');
process.env.CAREER_FINDER_LEDGER_OFF = '1'; // no exit-time flush from the test process itself
delete process.env.CAREER_FINDER_RUN_ID;

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ ${m}`); } };

const L = await import('./request-ledger.mjs');
const li = await import('./li-budget.mjs');
const A = await import('./discovery-audit.mjs');

console.log('\n1. host -> family');
ok(L.familyOf('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?x=1') === 'linkedin-guest', 'guest API is linkedin-guest');
ok(L.familyOf('https://www.linkedin.com/jobs/search-results/?keywords=x') === 'linkedin-loggedin', 'logged-in search is linkedin-loggedin');
ok(L.familyOf('https://hiringcafe.com/?searchState=x') === 'hiringcafe', 'hiringcafe');
ok(L.familyOf('https://boards-api.greenhouse.io/v1/boards/x/jobs') === 'greenhouse', 'greenhouse');
ok(L.familyOf('https://api.lever.co/v0/postings/x') === 'lever', 'lever');
ok(L.familyOf('https://api.ashbyhq.com/posting-api/job-board/x') === 'ashby', 'ashby');
ok(L.familyOf('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/X/jobs') === 'workday', 'workday');
ok(L.familyOf('https://api.smartrecruiters.com/v1/companies/x/postings') === 'smartrecruiters', 'smartrecruiters');
ok(L.familyOf('careers-x.icims.com') === 'icims', 'icims (bare host)');
ok(L.familyOf('https://x.fa.us2.oraclecloud.com/hcmRestApi') === 'oracle', 'oracle');
ok(L.familyOf('https://example.com/jobs') === 'other', 'other');

console.log('\n2. ledger aggregation (in-process + li-budget events, no second LinkedIn counter)');
for (let i = 0; i < 3; i++) L.record('https://api.ashbyhq.com/posting-api/job-board/a', { status: 200 });
L.record('https://api.ashbyhq.com/posting-api/job-board/dead', { status: 404 });
L.record('https://boards-api.greenhouse.io/v1/boards/b/jobs', { status: 429 });
// LinkedIn: two guest fetches (http events only) + one logged-in claim() (spend event) with no HTTP status.
L.record('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?k=a', { status: 200 });
L.record('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?k=b', { status: 429 });
const c = li.claim('jobsearch', 'test search');
ok(c.ok, 'claim(jobsearch) succeeds against the temp counter');
const s = Object.fromEntries(L.summary().map(r => [r.family, r]));
ok(s.ashby?.requests === 4 && s.ashby.statuses['200'] === 3 && s.ashby.statuses['404'] === 1, 'ashby: 4 requests, 200:3 404:1');
ok(s.greenhouse?.requests === 1 && s.greenhouse.statuses['429'] === 1, 'greenhouse: 1 request, 429:1');
ok(s['linkedin-guest']?.requests === 2 && s['linkedin-guest'].statuses['429'] === 1, 'linkedin-guest counted from li-events http rows');
ok(s['linkedin-loggedin']?.requests === 1 && s['linkedin-loggedin'].statuses.claimed === 1, 'linkedin-loggedin counted from claim() spend events');
const ev = readFileSync(process.env.CAREER_FINDER_LI_EVENTS, 'utf8').trim().split('\n');
ok(ev.every(l => l.split('\t')[5] === String(process.pid)), 'li-events rows carry the pid column');
ok(li.horizons('jobsearch').week === 1, 'ledger http rows do not inflate the jobsearch horizon');
ok(li.check('guest').used === 0, 'ledger never spends the guest budget');
ok(!L.summary().some(r => r.family === 'linkedin-loggedin' && r.requests > 1), 'no double count of LinkedIn');

console.log('\n3. flush / readLedger / aggregate');
const n = L.flush({ mode: 'test', date: '2026-10-05T14:00:00.000Z' });
ok(n === 4, `flush wrote one row per family (${n})`);
ok(L.flush() === 0, 'flush is idempotent per process');
const text = readFileSync(process.env.CAREER_FINDER_LEDGER, 'utf8');
ok(text.startsWith(L.LEDGER_HEADER.join('\t')), 'ledger has the documented header');
// A second process's rows under the same run id, then aggregate across both.
writeFileSync(process.env.CAREER_FINDER_LEDGER, text + ['2026-10-05T14:01:00.000Z', L.RUN_ID, 'other-lane', 'ashby', '6', '200:5,timeout:1'].join('\t') + '\n'
  + ['2026-10-05T14:02:00.000Z', 'some-other-run', 'x', 'ashby', '100', '200:100'].join('\t') + '\n');
const agg = L.aggregate(L.readLedger({ runId: L.RUN_ID }));
ok(agg.get('ashby').requests === 10 && agg.get('ashby').statuses['200'] === 8 && agg.get('ashby').statuses.timeout === 1, 'aggregate sums rows of one run across processes');
ok(!L.readLedger({ runId: L.RUN_ID }).some(r => r.run_id === 'some-other-run'), 'readLedger filters by run id');
ok(L.readLedger({ sinceIso: '2026-10-05T14:01:30Z' }).length === 1, 'readLedger filters by since');
ok(/REQUEST LEDGER \(\d+ requests\)/.test(L.formatSummary(agg)), 'formatSummary prints a total');
ok(L.parseStatuses('200:3,404:1,claimed:2').claimed === 2, 'parseStatuses round-trips');

console.log('\n4. truth fixture parses');
const FX = join(REPO, 'scripts/fixtures/discovery/2026-10-04-weekend');
const truth = A.readTsv(join(FX, 'truth.tsv'));
ok(truth.length === 14, `14 truth rows (${truth.length})`);
ok(truth.every(t => t.role && t.company && t.title && /^https:\/\//.test(t.url) && t.ats_date), 'every row has role/company/title/url/ats_date');
ok(!truth.some(t => /clera/i.test(t.company)), 'Clera excluded');
ok(truth.filter(t => t.flags).length === 5, 'five rows flagged (4 repost suspects + JR1997214 out-of-window)');
ok(truth.every(t => A.atsJobId(t.url)), 'every truth URL yields an ATS job id');
ok(A.atsJobId(truth.find(t => /JR2020348/.test(t.url)).url) === 'workday:jr2020348-1', 'workday id keeps the -1 repost suffix');
ok(existsSync(join(FX, 'README.md')) && existsSync(join(FX, 'roles.json')), 'README.md and roles.json present');
const roles = JSON.parse(readFileSync(join(FX, 'roles.json'), 'utf8'));
ok(new Set(truth.map(t => t.role)).size === 4 && truth.every(t => roles[t.role]), 'every truth role exists in roles.json');

console.log('\n5. recall math on a synthetic case');
const T = [
  { role: 'pm', company: 'Acme', title: 'Product Manager', url: 'https://jobs.ashbyhq.com/acme/11111111-1111-1111-1111-111111111111' },
  { role: 'pm', company: 'Beta Inc', title: 'Sr. Product Manager', url: 'https://boards.greenhouse.io/beta/jobs/12345' },
  { role: 'pm', company: 'Gamma', title: 'Product Manager', url: 'https://gamma.wd1.myworkdayjobs.com/Ext/job/SF/PM_JR55555', flags: 'repost-suspect:-1-suffix' },
  { role: 'swe', company: 'Delta', title: 'Software Engineer', url: 'https://delta.example.com/careers/1' },
  { role: 'swe', company: 'Epsilon', title: 'Software Engineer', url: 'https://jobs.lever.co/epsilon/22222222-2222-2222-2222-222222222222' },
  { role: 'swe', company: 'Zeta', title: 'Backend Engineer', url: 'https://jobs.ashbyhq.com/zeta/33333333-3333-3333-3333-333333333333' },
];
const F = [
  // id match despite a different URL shape (api vs public) and a different title
  { lane: 'scan-index', company: 'Acme', title: 'PM, Core', url: 'https://jobs.ashbyhq.com/acme/11111111-1111-1111-1111-111111111111/application' },
  // company + normalized title fallback (Sr. -> senior, Inc dropped), no URL
  { lane: 'hiringcafe', company: 'Beta', title: 'Senior Product Manager', url: '' },
  // canonical URL match (query + trailing slash ignored)
  { lane: 'hiringcafe', company: 'Epsilon', title: 'x', url: 'https://jobs.lever.co/epsilon/22222222-2222-2222-2222-222222222222/?lever-source=hc' },
  { lane: 'scan-index', company: 'Epsilon', title: 'Software Engineer', url: '' },
  { lane: 'scan', company: 'Unrelated', title: 'Product Manager', url: 'https://jobs.ashbyhq.com/unrelated/44444444-4444-4444-4444-444444444444' },
];
const IDX = { size: 2, names: new Set([A.normCompany('Gamma Corp')]), tokens: new Set(['ashby:zeta']) };
const r = A.audit(T, F, IDX);
ok(r.total.found === 3 && r.total.truth === 6 && r.total.recall_pct === 50, `total 3/6 = 50% (${r.total.found}/${r.total.truth})`);
ok(r.byRole.pm.found === 2 && r.byRole.pm.truth === 3 && r.byRole.pm.recall_pct === 66.7, 'pm 2/3 = 66.7%');
ok(r.byRole.swe.found === 1 && r.byRole.swe.recall_pct === 33.3, 'swe 1/3 = 33.3%');
ok(r.byLane['scan-index'].found === 2 && r.byLane.hiringcafe.found === 2 && r.byLane.scan.found === 0, 'per-lane: scan-index 2, hiringcafe 2, scan 0');
ok(r.byLane.scan.rows_written === 1, 'per-lane rows_written counts lane output, not matches');
const b = Object.fromEntries(r.rows.map(x => [x.company, x.bucket]));
ok(b.Gamma === 'in-index-missed', 'indexed by company name -> in-index-missed');
ok(b.Zeta === 'in-index-missed', 'indexed by board token -> in-index-missed');
ok(b.Delta === 'no-public-ATS', 'non-ATS URL, not indexed -> no-public-ATS');
const r2 = A.audit(T, F, IDX, { excludeFlagged: true });
ok(r2.total.truth === 5 && r2.total.found === 3, '--exclude-flagged drops flagged rows from the denominator');
ok(A.audit([], F, IDX).total.recall_pct === null, 'empty truth -> recall n/a, not 0%');
const gh = (id) => `https://job-boards.greenhouse.io/acme/jobs/${id}`;
ok(!A.matchTruth({ company: 'Acme', title: 'Account Executive', url: gh(1111111) }, [{ company: 'Acme', title: 'Account Executive', url: gh(2222222), lane: 'scan' }]).matched, 'same title, different ATS ids -> no match (repost / other city)');
ok(A.matchTruth({ company: 'Acme', title: 'Account Executive', url: gh(1111111) }, [{ company: 'Acme', title: 'Account Executive', url: '', lane: 'hiringcafe' }]).matched, 'title fallback still matches when one side has no id');
ok(A.boardTokens('https://api.ashbyhq.com/posting-api/job-board/sentry?includeCompensation=true')[0] === 'ashby:sentry', 'api-column board token');
ok(A.boardTokens('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs')[0] === 'workday:nvidia', 'workday tenant token');

console.log('\n6. loadFound reads the lane files of a data dir');
const D = join(TMP, 'data'); mkdirSync(D, { recursive: true });
writeFileSync(join(D, '_candidates-new.tsv'), 'date\tcompany\trole\tlocation\tposted\turl\tats\n2026-10-05\tAcme\tPM\tSF\t\thttps://jobs.ashbyhq.com/acme/11111111-1111-1111-1111-111111111111\tashby\n');
writeFileSync(join(D, '_web-roles.tsv'), 'date\tcompany\trole\tlocation\tposted\turl\tsource\n2026-10-05\tB\tR\tSF\t\thttps://x\thiringcafe-claim:2026-10-05\n2026-10-05\tC\tR\tSF\t\thttps://y\tlinkedin-crawl\n');
writeFileSync(join(D, 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tposted_at\tupdated_at\nhttps://z\t2026-10-05\tgh\tEngineer\tD\tadded\t\t\n');
const lanes = A.loadFound(D).map(f => f.lane).sort().join(',');
ok(lanes === 'hiringcafe,linkedin,scan,scan-index', `lanes from files: ${lanes}`);

console.log('\n7. CLI smoke (offline)');
const cli = spawnSync(process.execPath, [join(REPO, 'scripts/discovery-audit.mjs'), '--truth', join(FX, 'truth.tsv'), '--data', D, '--json'], { encoding: 'utf8', env: process.env });
let j = null; try { j = JSON.parse(cli.stdout); } catch { /* fall through */ }
ok(cli.status === 0 && j?.total?.truth === 14 && j.buckets['not-in-index'] === 14, 'offline CLI --json runs and buckets every miss');
const led = spawnSync(process.execPath, [join(REPO, 'scripts/request-ledger.mjs'), '--json'], { encoding: 'utf8', env: process.env });
ok(led.status === 0 && JSON.parse(led.stdout).ashby?.requests >= 10, 'request-ledger CLI aggregates the TSV');

console.log('\n8. wiring (static): every shared fetch path records to the ledger');
const src = (f) => readFileSync(join(REPO, 'scripts', f), 'utf8');
for (const f of ['scan-core.mjs', 'hiringcafe-scan.mjs', 'speed-linkedin.mjs', 'probe-ats-core.mjs'])
  ok(/from '\.\/request-ledger\.mjs'/.test(src(f)) && /recordRequest\(/.test(src(f)), `${f} records requests`);
for (const f of ['linkedin-jobsearch.mjs', 'linkedin-crawl.mjs'])
  ok(/import '\.\/request-ledger\.mjs'/.test(src(f)) && /claim\('jobsearch'/.test(src(f)), `${f} flushes ledger rows from claim() events`);
// Every outbound fetch( in scripts/*.mjs must go through the ledger. Grep, not a hand-picked list:
// a new lane that calls fetch() directly fails here. Allowlist = localhost CDP probes only.
const FETCH_ALLOW = new Set(['cdp.mjs', 'chrome-debug.mjs', 'doctor.mjs', 'morning.mjs', 'request-ledger.mjs']);
const unwired = [];
for (const f of readdirSync(join(REPO, 'scripts')).filter(f => f.endsWith('.mjs') && !f.startsWith('test-') && !FETCH_ALLOW.has(f))) {
  const code = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const lines = code.split('\n').filter(l => /(^|[^\w.])fetch\(/.test(l));
  if (!lines.length) continue;
  // Direct fetch( is allowed only when the same file records each call itself (recordRequest).
  if (!/recordRequest\(|trackedFetch\(|tracked\(/.test(code)) unwired.push(`${f} (${lines.length})`);
}
ok(unwired.length === 0, `every scripts/*.mjs fetch( is counted (unwired: ${unwired.join(', ') || 'none'})`);
ok(/trackedFetch\(url/.test(src('linkedin-applyurl.mjs')), 'linkedin-applyurl guestJobIds counts its /jobs-guest/ requests');
ok(/SIGTERM/.test(src('request-ledger.mjs')), 'ledger flushes on SIGTERM/SIGINT (lane timeouts)');
ok(!/\bspend\(|\bclaim\(/.test(src('request-ledger.mjs').replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'request-ledger never spends LinkedIn budget itself');
ok(/REQUEST LEDGER/.test(src('morning.mjs')) && /CAREER_FINDER_RUN_ID/.test(src('morning.mjs')), 'morning.mjs sets a run id and prints the ledger');
ok(/readLedger/.test(src('pipeline-digest.mjs')), 'pipeline-digest shows the ledger');
ok(/NO_BROWSER/.test(src('hiringcafe-scan.mjs')), 'hiringcafe-scan can be kept off :9222');
const live = src('discovery-audit.mjs');
ok(!/claude\s+-p|'claude'|linkedin-(crawl|jobsearch)\.mjs|speed-linkedin/.test(live.split('// ── live mode')[1] || ''), '--live runs no claude -p and no LinkedIn lane');
ok(live.includes("CAREER_FINDER_NO_BROWSER: args['allow-browser'] ? '0' : '1'"),'--live disables the browser fallback');

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
