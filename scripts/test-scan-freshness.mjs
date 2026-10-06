#!/usr/bin/env node
/**
 * test-scan-freshness.mjs — offline tests for Workday early stop / 429 backoff, the first-seen
 * ledger labels, Oracle HCM early stop, the empty-index exit code and the harness window/data-dir
 * guards. No network: global fetch is stubbed; the ledger is pointed at a temp dir BEFORE import.
 *
 *   node scripts/test-scan-freshness.mjs
 */
import './fixtures/use-test-profile.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(tmpdir(), 'cf-test-fresh-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
process.env.CAREER_FINDER_FIRST_SEEN = join(TMP, '_first-seen.tsv');
process.env.CAREER_FINDER_LEDGER = join(TMP, '_request-ledger.tsv');
process.env.CAREER_FINDER_LEDGER_OFF = '1';
process.env.CAREER_FINDER_LI_EVENTS = join(TMP, 'li-events.tsv');
process.env.CAREER_FINDER_LI_DIR = join(TMP, 'li-usage');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ ${m}`); } };

const SC = await import('./scan-core.mjs');
const F = await import('./lib/freshness.mjs');
const A = await import('./discovery-audit.mjs');
SC.net.sleep = async () => {};   // never wait in tests

const realFetch = globalThis.fetch;
const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const status = (code) => ({ ok: false, status: code, json: async () => ({}), text: async () => '' });
const wdRow = (i, posted, extra = {}) => ({ title: `Role ${i}`, externalPath: `/job/Santa-Clara-CA/Role-${i}_JR${2000000 + i}`, postedOn: posted, locationsText: 'Santa Clara, CA', ...extra });
const WD = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs';

try {
  console.log('\n1. Workday early stop, page cap, --full');
  {
    // 1000 reqs; rows 0-4 fresh, then "Posted 2 Days Ago": the list is newest-first.
    let calls = 0;
    globalThis.fetch = async (u, init) => {
      calls++; const { offset } = JSON.parse(init.body);
      const rows = Array.from({ length: 20 }, (_, i) => wdRow(offset + i, offset === 0 && i < 5 ? 'Posted Today' : (offset === 0 ? 'Posted 2 Days Ago' : 'Posted 30+ Days Ago')));
      return reply({ total: offset === 0 ? 1000 : 0, jobPostings: rows });
    };
    const r = await SC.fetchWorkday(WD, { windowDays: 1, maxPages: 10 });
    ok(calls === 1 && r.earlyStopped && r.jobPostings.length === 20, `old row on page 1 -> stops after ${calls} request(s), earlyStopped=${r.earlyStopped} (was 50 pages)`);

    // all fresh -> the 3-page cap bites and is RECORDED, not silent
    calls = 0;
    globalThis.fetch = async (u, init) => {
      calls++; const { offset } = JSON.parse(init.body);
      return reply({ total: offset === 0 ? 1000 : 0, jobPostings: Array.from({ length: 20 }, (_, i) => wdRow(offset + i, 'Posted Today')) });
    };
    const before = SC.scanStats.workdayPageCap.length;
    const c = await SC.fetchWorkday(WD, { windowDays: 1, label: 'Acme' });
    ok(calls === SC.WORKDAY_MAX_PAGES && c.pageCapHit && c.partial === true && c.jobPostings.length === SC.WORKDAY_MAX_PAGES * 20, `all-fresh tenant capped at ${calls} pages (cap ${SC.WORKDAY_MAX_PAGES}) and reported PARTIAL, not silent`);
    ok(SC.scanStats.workdayPageCap.length === before + 1 && SC.scanStats.workdayPageCap.at(-1) === 'Acme', 'page cap hit is logged in scanStats.workdayPageCap');
    calls = 0;
    const full = await SC.fetchWorkday(WD, { windowDays: 1, full: true });
    ok(calls === 50 && full.jobPostings.length === 1000 && !full.pageCapHit, `--full pages the whole board (${calls} requests, ${full.jobPostings.length} rows)`);
    ok(SC.WORKDAY_CONCURRENCY <= 2, `per-tenant concurrency is ${SC.WORKDAY_CONCURRENCY} (<= 2)`);
  }

  console.log('\n2. 429 backoff');
  {
    const delays = []; SC.net.sleep = async (ms) => { delays.push(ms); };
    let hits429 = 0;
    globalThis.fetch = async (u, init) => {
      const { offset } = JSON.parse(init.body);
      if (offset === 20 && hits429 < 3) { hits429++; return status(429); }
      return reply({ total: offset === 0 ? 40 : 0, jobPostings: Array.from({ length: 20 }, (_, i) => wdRow(offset + i, 'Posted Today')) });
    };
    const b0 = SC.scanStats.backoff429;
    const r = await SC.fetchWorkday(WD, { windowDays: 1 });
    ok(r.jobPostings.length === 40 && !r.partial, `3x HTTP 429 on page 2 retried to success (${r.jobPostings.length}/40 rows)`);
    ok(SC.scanStats.backoff429 - b0 === 3 && delays.length === 3 && delays[1] > delays[0] && delays[2] > delays[1], `delays grow exponentially (${delays.join(', ')} ms)`);
    // permanent 429 -> the page is reported as PARTIAL, never silently empty
    globalThis.fetch = async (u, init) => { const { offset } = JSON.parse(init.body); return offset === 20 ? status(429) : reply({ total: offset === 0 ? 40 : 0, jobPostings: Array.from({ length: 20 }, (_, i) => wdRow(offset + i, 'Posted Today')) }); };
    const g0 = SC.scanStats.backoffGaveUp;
    const p = await SC.fetchWorkday(WD, { windowDays: 1 });
    ok(p.partial === true && p.expected === 40 && SC.scanStats.backoffGaveUp === g0 + 1, 'retries exhausted -> partial=true with expected count (was a silent []).');
    SC.net.sleep = async () => {};
  }

  console.log('\n3. Workday detail fetches only after the date + title filter');
  {
    const rows = [0, 1, 2, 3, 4].map((i) => wdRow(i, i < 2 ? 'Posted Today' : 'Posted 2 Days Ago', { locationsText: '2 Locations', title: i < 2 ? 'Data Engineer' : 'Chef' }));
    let detail = 0;
    globalThis.fetch = async (u, init) => {
      if (init?.method === 'POST') return reply({ total: 5, jobPostings: rows.map((r) => ({ ...r })) });
      detail++; return reply({ jobPostingInfo: { location: 'San Jose, CA', additionalLocations: [] } });
    };
    const d0 = SC.scanStats.workdayDetailFetched;
    const r = await SC.fetchWorkday(WD, { windowDays: 1, full: true, prefilter: (j) => SC.workdayAgeDays(j.postedOn) <= 1 && /engineer/i.test(j.title) });
    ok(detail === 2 && SC.scanStats.workdayDetailFetched - d0 === 2, `5 multi-site rows, 2 pass date+title -> ${detail} detail requests (was 5)`);
    ok(r.jobPostings.filter((j) => j.locationsText === 'San Jose, CA').length === 2 && r.jobPostings.filter((j) => j.locationsText === SC.WORKDAY_LOC_UNRESOLVED).length === 3, 'filtered-out rows get the unresolved marker without a request');
  }

  console.log('\n4. Repost flags (no extra requests)');
  {
    const fresh = Array.from({ length: 6 }, (_, i) => wdRow(i, 'Posted Today'));
    const odd = [
      wdRow(100, 'Posted Today', { externalPath: '/job/X/Role-100_JR2000100-1' }),
      wdRow(101, 'Posted Today', { title: 'Renamed Title', externalPath: '/job/X/Old-Title_JR2000101' }),
      wdRow(102, 'Posted Today', { externalPath: '/job/X/Role-102_JR1700000' }),
    ];
    const f = SC.flagWorkdayReposts([...fresh, ...odd]);
    ok(f.slice(0, 6).every((x) => x.length === 0), 'ordinary fresh rows carry no flag');
    ok(f[6].includes('req-suffix'), '"-1" suffix flagged req-suffix');
    ok(f[7].includes('slug-mismatch'), 'retitled req flagged slug-mismatch');
    ok(f[8].includes('jr-distance'), 'req id 300k below the fresh median flagged jr-distance');
    const parsed = SC.PARSERS.workday({ jobPostings: [{ ...odd[0] }] }, 'Acme', { _wd: { tenant: 'acme', shard: 'wd5', site: 'External' } });
    ok(parsed[0].repostFlags.includes('req-suffix'), 'parseWorkday carries repostFlags onto the job');
  }

  console.log('\n5. Greenhouse date source');
  {
    const gh = SC.PARSERS.greenhouse({ jobs: [
      { title: 'A', absolute_url: 'https://x/1', first_published: '2026-10-06T10:00:00Z', updated_at: '2026-10-06T11:00:00Z' },
      { title: 'B', absolute_url: 'https://x/2', updated_at: '2026-10-06T11:00:00Z' }] }, 'X');
    ok(gh[0].dateSource === 'first_published' && gh[0].postedAt.toISOString() === '2026-10-06T10:00:00.000Z', 'first_published is the posting date');
    ok(gh[1].dateSource === 'updated_at' && gh[1].postedAt === null, 'updated_at-only row: postedAt null, dateSource updated_at');
  }

  console.log('\n5b. Review fixes: Workday ordering, Retry-After, host timeouts, dead-lane floor, seed cwd');
  {
    // a pinned OLD row at the top of page 1 must not hide fresh rows on page 2
    let calls = 0;
    globalThis.fetch = async (u, init) => {
      calls++; const { offset } = JSON.parse(init.body);
      const rows = Array.from({ length: 20 }, (_, i) => wdRow(offset + i, offset === 0 && i === 0 ? 'Posted 30+ Days Ago' : (offset < 40 ? 'Posted Today' : 'Posted 5 Days Ago')));
      return reply({ total: offset === 0 ? 100 : 0, jobPostings: rows });
    };
    const r = await SC.fetchWorkday(WD, { windowDays: 1, maxPages: 10 });
    ok(r.jobPostings.length === 60 && calls === 3 && r.earlyStopped, `pinned old row on page 1 does not stop paging; stops at the first page that ENDS old (${calls} requests, ${r.jobPostings.length} rows)`);

    ok(SC.retryAfterMs('7') === 7000 && SC.retryAfterMs('') === null && SC.retryAfterMs('9999') === 60000, 'retryAfterMs parses seconds and caps at 60s');
    ok(SC.retryAfterMs(new Date(Date.now() + 5000).toUTCString()) <= 5000 && SC.retryAfterMs('nonsense') === null, 'retryAfterMs parses an HTTP date and rejects junk');
    const delays = []; SC.net.sleep = async (ms) => { delays.push(ms); };
    let n = 0;
    globalThis.fetch = async () => (n++ === 0 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '3' }), json: async () => ({}) } : reply({ ok: 1 }));
    await SC.fetchJsonBackoff('https://ra.example/x', {}, { baseMs: 1000 });
    ok(delays.length === 1 && delays[0] === 3000, `a 429 with Retry-After: 3 waits 3000ms, not the 2^n schedule (${delays})`);
    SC.net.sleep = async () => {};
    // repeated timeouts on one host: that host is skipped, others are not
    globalThis.fetch = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
    for (let i = 0; i < SC.HOST_TIMEOUT_LIMIT; i++) await SC.fetchJsonBackoff('https://slow.example/a').catch(() => {});
    let skipped = null; globalThis.fetch = async () => { skipped = false; return reply({}); };
    const e1 = await SC.fetchJsonBackoff('https://slow.example/b').catch((e) => e);
    ok(e1?.status === 'skipped' && skipped === null, `host past ${SC.HOST_TIMEOUT_LIMIT} timeouts is skipped without another request`);
    ok((await SC.fetchJsonBackoff('https://other.example/b').catch(() => null)) !== null, 'other hosts are unaffected');

    const H = await import('./lib/health.mjs');
    ok(!H.deadLaneFatal({ ok: 3, jobs: 0 }, true) && !H.deadLaneFatal({ ok: 6, jobs: 0 }, false) && H.deadLaneFatal({ ok: 5, jobs: 0 }, true) && !H.deadLaneFatal({ ok: 9, jobs: 2 }, true), 'dead lane is fatal only at >=5 empty boards AND a history of jobs');
    ok(H.isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' })) && H.isTimeoutError({ status: 'skipped' }) && !H.isTimeoutError({ status: 404, message: 'HTTP 404' }), 'timeouts are told apart from dead boards');

    const IT = await import('./lib/index-tsv.mjs');
    const cwd = mkdtempSync(join(tmpdir(), 'cf-seed-cwd-'));
    const res = IT.ensureSeedIndex({ root: cwd, index: 'data/company-index.tsv', seedRoot: REPO });
    ok(res.restored && existsSync(join(cwd, 'data/company-index.tsv')), 'ensureSeedIndex restores into the CWD index (not the repo root) when asked');
    const r2 = spawnSync('node', [join(REPO, 'scripts/build-company-index.mjs'), '--help'], { cwd: REPO, encoding: 'utf8' });
    const before = readFileSync(join(REPO, 'data/company-index.tsv'), 'utf8');
    ok(r2.status === 0 && /Usage/.test(r2.stdout) && readFileSync(join(REPO, 'data/company-index.tsv'), 'utf8') === before, 'build-company-index --help prints usage and writes nothing');
    const r3 = spawnSync('node', [join(REPO, 'scripts/build-company-index.mjs'), '--hlep'], { cwd: REPO, encoding: 'utf8' });
    ok(r3.status === 2 && /Unknown flag/.test(r3.stderr) && readFileSync(join(REPO, 'data/company-index.tsv'), 'utf8') === before, 'build-company-index rejects unknown flags before any write');
    rmSync(cwd, { recursive: true, force: true });
  }

  console.log('\n6. First-seen labels (new / re-promoted / unverified / edge)');
  {
    const now = new Date('2026-10-06T16:00:00Z');
    const start = new Date(now.getTime() - 24 * 3600e3);
    const lds = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
    const win = { start, isRecent: (d) => d >= start && d <= now, localDateStr: lds };
    const L = (job, fam, known) => F.labelFreshness(job, fam, known, win);

    ok(L({ postedAt: new Date('2026-10-06T15:00:00Z') }, 'workday', null).label === 'new', 'day-level, never seen, dated today -> new (fresh)');
    ok(L({ postedAt: new Date('2026-10-06T15:00:00Z') }, 'workday', null).fresh, 'new counts as fresh');
    ok(L({ postedAt: new Date('2026-10-01T00:00:00Z') }, 'oracle', null).label === 'unverified', 'day-level date before the window start -> unverified, even though never seen');
    ok(!L({ postedAt: new Date('2026-10-01T00:00:00Z') }, 'oracle', null).fresh, 'unverified is not fresh');
    ok(L({ postedAt: new Date('2026-10-06T00:00:00Z') }, 'oracle', { first_seen: '2026-09-01T00:00:00Z', last_date: '2026-09-01' }).label === 're-promoted', 'known id + new day -> re-promoted');
    ok(L({ postedAt: new Date('2026-10-06T00:00:00Z') }, 'oracle', { first_seen: '2026-10-06T12:00:00Z', last_date: '2026-10-06' }).label === 'new', 'known id first seen INSIDE this window stays new (a rerun must not drop an unscored candidate)');
    ok(L({ postedAt: new Date('2026-10-06T00:00:00Z') }, 'oracle', { first_seen: '2026-10-04T12:00:00Z', last_date: '2026-10-06' }).label === 'known', 'known id first seen before the window, same day -> known (not fresh)');
    ok(L({ postedAt: new Date('2026-10-06T10:00:00Z') }, 'ashby', null).label === 'fresh', 'minute-level in window -> fresh');
    // sticky: ledgerPut overwrote last_date with the bumped date, the next run must STILL say re-promoted
    ok(L({ postedAt: new Date('2026-10-06T10:00:00Z') }, 'ashby', { first_seen: '2026-09-01T00:00:00Z', last_date: '2026-10-06T10:00:00.000Z' }).label === 're-promoted', 're-promoted is sticky on the next run (no ledger marker needed)');
    ok(L({ postedAt: new Date('2026-10-06T10:00:00Z') }, 'ashby', { first_seen: '2026-10-06T10:30:00Z', last_date: '2026-10-06T10:00:00.000Z' }).label === 'fresh', 'a second run in the same window keeps a genuinely fresh id fresh');
    const oldRow = L({ postedAt: new Date('2026-08-01T10:00:00Z') }, 'ashby', null);
    ok(oldRow.label === 'old' && oldRow.record === true, 'an out-of-window id is recorded once, so a later bump is detectable');
    ok(L({ postedAt: new Date('2026-08-01T10:00:00Z') }, 'ashby', { first_seen: '2026-09-01T00:00:00Z', last_date: '2026-08-01T10:00:00.000Z' }).record === false, 'an already-recorded old id is not re-written');
    ok(L({ postedAt: new Date('2026-10-06T10:00:00Z') }, 'ashby', { first_seen: '2026-09-01T00:00:00Z', last_date: '2026-08-01T10:00:00.000Z' }).label === 're-promoted', 'the 82-day-old req case: first seen old, later bumped into the window -> re-promoted, not fresh');
    ok(L({ postedAt: new Date('2026-10-06T10:00:00Z') }, 'ashby', { first_seen: '2026-09-01T00:00:00Z', last_date: '2026-09-01T10:00:00.000Z' }).label === 're-promoted', 'minute-level known id with a bumped date -> re-promoted');
    const e = L({ postedAt: new Date(start.getTime() + 20 * 60e3) }, 'lever', null);
    ok(e.label === 'fresh' && e.edge, 'posting 20 min inside the window edge -> fresh + edge flag');
    const e2 = L({ postedAt: new Date(start.getTime() - 20 * 60e3) }, 'lever', null);
    ok(e2.label === 'old' && e2.edge, 'posting 20 min outside the window edge -> old + edge flag');
    ok(!L({ postedAt: new Date(start.getTime() + 3 * 3600e3) }, 'lever', null).edge, 'posting 3h inside the edge is not flagged');
    ok(L({ postedAt: null, dateSource: 'updated_at' }, 'greenhouse', null).label === 'unverified', 'greenhouse updated_at-only -> unverified');
    const t = F.newTally(); F.tally(t, { label: 'new', edge: false }, {}); F.tally(t, { label: 'unverified', edge: true }, { dateSource: 'updated_at' });
    ok(/new 1/.test(F.formatTally(t)) && /unverified 1/.test(F.formatTally(t)) && /edge 1/.test(F.formatTally(t)), `tally prints label counts (${F.formatTally(t)})`);

    // ledger round trip: put -> flush -> reload keeps first_seen, updates last_date
    SC._resetFirstSeen();
    SC.ledgerPut('https://x.myworkdayjobs.com/en-US/S/job/A_JR123', { now: new Date('2026-10-01T00:00:00Z'), lastDate: '2026-10-01' });
    SC.ledgerFlush();
    SC.ledgerPut('https://x.myworkdayjobs.com/en-US/S/job/A_JR123', { now: new Date('2026-10-06T00:00:00Z'), lastDate: '2026-10-06' });
    SC.ledgerFlush();
    SC._resetFirstSeen();
    const g = SC.ledgerGet('https://x.myworkdayjobs.com/en-US/S/job/A_JR123');
    ok(g && g.first_seen === '2026-10-01T00:00:00.000Z' && g.last_date === '2026-10-06' && g.source === 'scan-index', 'ledger keeps the earliest first_seen and the latest last_date');
    ok(readFileSync(process.env.CAREER_FINDER_FIRST_SEEN, 'utf8').startsWith('url_key\tfirst_seen_iso\tsource\tlast_date\n'), 'ledger file has the 4-column header');
  }

  console.log('\n7. Oracle HCM early stop by PostedDate');
  {
    const api = SC.detectApi({ careers_url: 'https://iazuqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions' });
    let calls = 0;
    globalThis.fetch = async (u) => {
      calls++; const o = Number(String(u).match(/offset=(\d+)/)[1]);
      const day = o === 0 ? '2026-10-06' : '2026-09-01';
      return reply({ items: [{ TotalJobsCount: 1000, requisitionList: Array.from({ length: 200 }, (_, i) => ({ Id: String(o + i), Title: 'T', PostedDate: day, PrimaryLocation: 'San Francisco, CA' })) }] });
    };
    const stop = new Date('2026-10-05T16:00:00Z');
    const r = await SC.fetchOracle(api, { stopBefore: stop });
    ok(r.earlyStopped && calls <= 3 && SC.PARSERS.oracle(r, 'UCSF', api).length <= 600, `window sweep stops once PostedDate falls before the window (${calls} of 5 pages)`);
    calls = 0; const all = await SC.fetchOracle(api);
    ok(calls === 5 && !all.earlyStopped, 'no stopBefore -> whole board paged (old behaviour)');
  }
} finally { globalThis.fetch = realFetch; }

console.log('\n8. scan-index fails loudly on an empty index');
{
  const d = join(TMP, 'empty'); mkdirSync(join(d, 'data'), { recursive: true });
  writeFileSync(join(d, 'data/company-index.tsv'), 'company\thq\tcareers_url\tats_type\tats_api_url\tsource\tdate_added\tlast_scanned\tlast_status\n');
  const run = (extra = []) => spawnSync(process.execPath, [join(REPO, 'scripts/scan-index.mjs'), '--dry-run', ...extra], { cwd: d, encoding: 'utf8', env: { ...process.env, CAREER_FINDER_LEDGER_OFF: '1', CAREER_FINDER_SEED_OFF: '1', CAREER_FINDER_REGISTRY_DIR: join(d, 'no-registries') }, timeout: 60000 });
  const r = run();
  ok(r.status === 1 && /FATAL: the company index has no scannable boards/.test(r.stderr), `header-only index -> exit ${r.status} with a FATAL message`);
  writeFileSync(join(d, 'data/company-index.tsv'), '');
  const r2 = run();
  ok(r2.status !== 0, `zero-byte index -> non-zero exit (${r2.status})`);
}

console.log('\n9. scan-index source wiring');
{
  const src = readFileSync(join(REPO, 'scripts/scan-index.mjs'), 'utf8');
  ok(/HTTP by family/.test(src) && /requestSummary\(\)/.test(src), 'summary prints per-status HTTP counts per family');
  ok(/ROUND_CAPS = \[20, 40, 200, ATS_MAX_JOBS\]/.test(src) && /round cap/.test(src), 'round caps 20/40/200/10,000 are warned');
  ok(/lane parsed 0 jobs from/.test(src) && /process\.exitCode = 1/.test(src), 'a lane that parsed 0 rows from 200-OK boards exits non-zero');
  ok(/Freshness labels:/.test(src) && /labelFreshness/.test(src), 'summary prints freshness label counts');
}

console.log('\n10. discovery-audit guards');
{
  const empty = join(TMP, 'noscan'); mkdirSync(empty, { recursive: true });
  let threw = false; try { A.resolveDataDir(empty); } catch (e) { threw = /no data files/.test(e.message); }
  ok(threw, '--data with no data files is rejected');
  let threw2 = false; try { A.resolveDataDir(join(TMP, 'does-not-exist')); } catch (e) { threw2 = /does not exist/.test(e.message); }
  ok(threw2, '--data on a missing directory is rejected');
  const parent = join(TMP, 'harness'); mkdirSync(join(parent, 'data'), { recursive: true });
  writeFileSync(join(parent, 'data/_candidates-new.tsv'), 'date\tcompany\trole\tlocation\tposted\turl\tats\n');
  const r = A.resolveDataDir(parent);
  ok(r.dir === join(parent, 'data') && r.note, '--data <harness dir> resolves to <dir>/data');
  const cli = spawnSync(process.execPath, [join(REPO, 'scripts/discovery-audit.mjs'), '--truth', join(REPO, 'scripts/fixtures/discovery/2026-10-06-weekday/truth.tsv'), '--data', empty], { encoding: 'utf8' });
  ok(cli.status === 2 && /ERROR: no data files/.test(cli.stderr), `CLI exits 2 on an empty --data dir (exit ${cli.status})`);
  const m = A.readManifest(join(REPO, 'scripts/fixtures/discovery/2026-10-06-weekday/manifest.json'));
  ok(m && m.hours === 24 && m.start.toISOString() === '2026-10-05T16:00:00.000Z', 'weekday manifest = 09:00 PT to 09:00 PT, 24h');
  const w = A.readManifest(join(REPO, 'scripts/fixtures/discovery/2026-10-04-weekend/manifest.json'));
  ok(w && w.hours === 24, 'weekend manifest loads');
  const src = readFileSync(join(REPO, 'scripts/discovery-audit.mjs'), 'utf8');
  ok(/CAREER_FINDER_WINDOW_START: manifest\.start/.test(src), 'live lanes receive the truth window, not their start time');
  process.env.CAREER_FINDER_WINDOW_START = '2026-10-05T16:00:00Z'; process.env.CAREER_FINDER_WINDOW_END = '2026-10-06T16:00:00Z';
  const pred = SC.makeHoursPredicate(24);
  ok(pred(new Date('2026-10-05T20:00:00Z')) && !pred(new Date('2026-10-07T00:00:00Z')) && SC.windowStartFor({ hours: 24 }).toISOString() === '2026-10-05T16:00:00.000Z', 'CAREER_FINDER_WINDOW_* pins makeHoursPredicate and windowStartFor');
  delete process.env.CAREER_FINDER_WINDOW_START; delete process.env.CAREER_FINDER_WINDOW_END;
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
