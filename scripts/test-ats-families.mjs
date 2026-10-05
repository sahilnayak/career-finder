#!/usr/bin/env node
/**
 * test-ats-families.mjs — every ATS family scan-core parses, proven.
 *
 *   node scripts/test-ats-families.mjs            # offline: saved fixtures in scripts/fixtures/ats/
 *   node scripts/test-ats-families.mjs --live     # + one real public board per family (network)
 *   node scripts/test-ats-families.mjs --live --family oracle
 *
 * Offline checks, per family: detectApi() resolves the careers URL to the right type/board id,
 * the parser returns jobs with a non-empty title, an absolute human URL (never an API endpoint),
 * a location where the family publishes one, and a date where the family publishes one.
 * Plus: Workday / SmartRecruiters / iCIMS / Oracle / Taleo pagination against a stubbed fetch
 * (Workday's total-only-on-page-1 quirk; no page cap), and probe-ats-core detect-only logging.
 *
 * Live boards (public, no auth; verified 2026-10-04 — swap one out if a board disappears):
 */
export const LIVE_BOARDS = {
  greenhouse:      ['https://job-boards.greenhouse.io/anthropic'],
  ashby:           ['https://jobs.ashbyhq.com/openai'],
  lever:           ['https://jobs.lever.co/veeva'],
  workday:         ['https://visa.wd5.myworkdayjobs.com/Visa', 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site'],
  smartrecruiters: ['https://careers.smartrecruiters.com/westerndigital'],
  workable:        ['https://apply.workable.com/huggingface'],
  recruitee:       ['https://aikidosecurity.recruitee.com'],
  bamboohr:        ['https://plugandplaytechcenter.bamboohr.com'],
  teamtailor:      ['https://swishanalytics.na.teamtailor.com'],
  rippling:        ['https://ats.rippling.com/carbon-health/jobs'],
  icims:           ['https://careers-gdms.icims.com/jobs', 'https://careers-peraton.icims.com/jobs'],
  oracle:          ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions',
                    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/requisitions'],
  taleo:           ['https://aa224.taleo.net/careersection/ex/jobsearch.ftl'],
};
// Families whose list endpoint publishes no posting date (they never pass a recency window on
// their own; that is deliberate, see parseRippling). Location is always required.
const NO_DATE = new Set(['rippling', 'taleo', 'bamboohr']);

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  detectApi, PARSERS, SUPPORTED_FAMILIES, fetchProvider, fetchWorkday,
  fetchSmartRecruiters, fetchIcims, fetchOracle, fetchTaleo, ATS_MAX_JOBS,
  WORKDAY_LOC_UNRESOLVED, parseOnlyList, buildLocationFilter,
} from './scan-core.mjs';
import { detectFamily, probeCareersUrl, slugs, embeddedBoards } from './probe-ats-core.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ats');
const fx = (f) => readFileSync(join(FIX, f), 'utf8');
const LIVE = process.argv.includes('--live');
const ONLY = (() => { const i = process.argv.indexOf('--family'); return i > -1 ? process.argv[i + 1] : null; })();

let passed = 0, failed = 0;
const ok = (c, msg) => { if (c) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

function checkJobs(fam, jobs, { min = 1, label = fam } = {}) {
  ok(jobs.length >= min, `${label}: ${jobs.length} jobs parsed (>= ${min})`);
  if (!jobs.length) return;
  const bad = jobs.filter((j) => !j.title || !/^https:\/\//.test(j.url || '') || /\/api\/|hcmRestApi|posting-api|\/wday\/cxs\/|jobsearch\.ajax/.test(j.url));
  ok(bad.length === 0, `${label}: every job has a title and a human https URL${bad.length ? ` (bad: ${JSON.stringify(bad[0]).slice(0, 160)})` : ''}`);
  const locd = jobs.filter((j) => j.location).length;
  ok(locd / jobs.length >= 0.8, `${label}: location on ${locd}/${jobs.length}`);
  if (!NO_DATE.has(fam)) {
    const dated = jobs.filter((j) => j.postedAt instanceof Date && !isNaN(j.postedAt)).length;
    ok(dated / jobs.length >= 0.8, `${label}: postedAt on ${dated}/${jobs.length}`);
  }
}

// ── 1. Family inventory ──────────────────────────────────────────────
console.log('\n1. Family inventory');
const EXPECT = ['greenhouse', 'ashby', 'lever', 'workday', 'bamboohr', 'teamtailor', 'smartrecruiters', 'workable', 'recruitee', 'rippling', 'icims', 'oracle', 'taleo'];
for (const f of EXPECT) ok(SUPPORTED_FAMILIES.includes(f), `scan-core parses ${f}`);
ok(Object.keys(LIVE_BOARDS).sort().join() === [...SUPPORTED_FAMILIES].sort().join(), 'every supported family has a live board listed');

// ── 2. Careers URL -> family + board id ──────────────────────────────
console.log('\n2. detectApi: careers URL -> family + board');
const DETECT = [
  ['https://job-boards.greenhouse.io/anthropic', 'greenhouse'],
  ['https://jobs.ashbyhq.com/openai', 'ashby'],
  ['https://jobs.lever.co/veeva', 'lever'],
  ['https://visa.wd5.myworkdayjobs.com/en-US/Visa', 'workday'],
  ['https://careers.smartrecruiters.com/westerndigital', 'smartrecruiters'],
  ['https://apply.workable.com/huggingface', 'workable'],
  ['https://aikidosecurity.recruitee.com', 'recruitee'],
  ['https://plugandplaytechcenter.bamboohr.com/careers', 'bamboohr'],
  ['https://swishanalytics.na.teamtailor.com/jobs', 'teamtailor'],
  ['https://ats.rippling.com/carbon-health/jobs', 'rippling'],
  ['https://careers-gdms.icims.com/jobs/search?ss=1', 'icims', 'careers-gdms.icims.com'],
  ['https://uscareers-acme.icims.com/jobs/1234/foo/job', 'icims', 'uscareers-acme.icims.com'],
  ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions', 'oracle', 'jpmc.fa.oraclecloud.com/CX_1001'],
  ['https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3/job/123', 'oracle', 'x.fa.us2.oraclecloud.com/CX_3'],
  ['https://aa224.taleo.net/careersection/ex/jobsearch.ftl?lang=en', 'taleo', 'aa224.taleo.net/ex'],
  ['https://aa224.taleo.net/careersection/ex/jobdetail.ftl?job=JR1', 'taleo', 'aa224.taleo.net/ex'],
];
for (const [u, t, board] of DETECT) {
  const a = detectApi({ careers_url: u });
  ok(a?.type === t && (!board || a.board === board), `${u} -> ${a?.type}${a?.board ? ' ' + a.board : ''}`);
  // The stored ats_api_url must round-trip through detectApi({api}) (that is how scan-index reads it).
  if (a) ok(detectApi({ api: a.url, careers_url: u })?.type === t, `  api_url round-trips (${t})`);
}
ok(detectApi({ careers_url: 'https://cdn02.icims.com/a/x.js' }) === null, 'iCIMS CDN host is not a board');
ok(detectApi({ careers_url: 'https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/' }) === null, 'Oracle without siteNumber is not resolvable offline');
ok(detectApi({ careers_url: 'https://acme.tbe.taleo.net/acme/ats/careers' }) === null, 'Taleo Business Edition is not Taleo Enterprise');

console.log('\n3. Detect-only (unsupported) families are named, not silent');
for (const [u, fam] of [
  ['https://career4.successfactors.com/career?company=Acme', 'successfactors'],
  ['https://jobs.jobvite.com/acme/jobs', 'jobvite'],
  ['https://recruitingbypaycor.com/career/CareerHome.action?clientId=1', 'paycor'],
  ['https://acme.tbe.taleo.net/acme/ats/careers', 'taleo-business'],
  ['https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/', 'oracle-hcm'],
  ['https://careers-gdms.icims.com/jobs', null],
]) ok(detectFamily(u) === fam, `detectFamily(${u.slice(8, 50)}…) = ${fam}`);

// ── 4. Parsers against fixtures ──────────────────────────────────────
console.log('\n4. Parsers vs saved fixtures');
const PFX = [
  ['greenhouse', 'greenhouse.json', 'https://job-boards.greenhouse.io/anthropic'],
  ['ashby', 'ashby.json', 'https://jobs.ashbyhq.com/openai'],
  ['lever', 'lever.json', 'https://jobs.lever.co/veeva'],
  ['workday', 'workday.json', 'https://visa.wd5.myworkdayjobs.com/Visa'],
  ['smartrecruiters', 'smartrecruiters.json', 'https://careers.smartrecruiters.com/westerndigital'],
  ['workable', 'workable.json', 'https://apply.workable.com/huggingface'],
  ['recruitee', 'recruitee.json', 'https://aikidosecurity.recruitee.com'],
  ['bamboohr', 'bamboohr.json', 'https://plugandplaytechcenter.bamboohr.com'],
  ['teamtailor', 'teamtailor.rss', 'https://swishanalytics.na.teamtailor.com'],
  ['rippling', 'rippling.json', 'https://ats.rippling.com/carbon-health/jobs'],
  ['icims', 'icims-cards.html', 'https://careers-gdms.icims.com/jobs'],
  ['oracle', 'oracle.json', 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions'],
  ['taleo', 'taleo-page1.html', 'https://aa224.taleo.net/careersection/ex/jobsearch.ftl'],
];
for (const [fam, file, u] of PFX) {
  const api = detectApi({ careers_url: u });
  const raw = fx(file);
  const payload = /\.json$/.test(file) ? JSON.parse(raw) : raw;
  const jobs = PARSERS[fam](['icims', 'oracle', 'taleo'].includes(fam) ? { pages: [payload] } : payload, 'Acme', api);
  checkJobs(fam, jobs);
}
{
  // Workable regression: the widget API has no `location` object (every location used to be '').
  const jobs = PARSERS.workable(JSON.parse(fx('workable.json')), 'HF', { _slug: 'huggingface' });
  ok(jobs.every((j) => j.location), 'workable: location read from city/locations[] (was always empty)');
  // iCIMS older table layout + Oracle remote workplace type.
  const legacy = `<table><tr class="iCIMS_JobListingRow"><td><span class="sr-only field-label">Job Location</span> <span>US-CA-San Jose</span></td>
    <td><a href="https://careers-acme.icims.com/jobs/42/solutions-engineer/job?in_iframe=1" class="iCIMS_Anchor" title="42 - Solutions Engineer"><span class="sr-only field-label">Title</span> Solutions Engineer</a></td></tr></table>`;
  const lj = PARSERS.icims({ pages: [legacy] }, 'Acme', {});
  ok(lj.length === 1 && lj[0].title === 'Solutions Engineer' && lj[0].location === 'US-CA-San Jose' && !/in_iframe/.test(lj[0].url), `icims legacy row layout: ${JSON.stringify(lj[0])}`);
  const oj = PARSERS.oracle({ pages: [{ items: [{ requisitionList: [{ Id: '9', Title: 'SE', PostedDate: '2026-10-01', PrimaryLocation: 'Austin, TX', WorkplaceType: 'Remote', secondaryLocations: [{ Name: 'Denver, CO' }] }] }] }] }, 'Acme', { _host: 'h', _site: 'CX_1' });
  const rj = PARSERS.rippling([{ uuid: 'a', name: 'SE', url: 'https://ats.rippling.com/x/jobs/a', workLocation: { label: 'Austin, TX' } }, { uuid: 'a', name: 'SE', url: 'https://ats.rippling.com/x/jobs/a', workLocation: { label: 'Remote (United States)' } }], 'Acme', {});
  ok(rj.length === 1 && !('locs' in rj[0]) && rj[0].location === 'Austin, TX; Remote (United States)', `rippling: collapsed by uuid, no internal locs Set leaked (${JSON.stringify(rj[0])})`);
  ok(oj[0]?.location === 'Austin, TX; Denver, CO; Remote', `oracle: primary + secondary + remote locations (${oj[0]?.location})`);
}

// ── 5. Pagination (stubbed fetch, no network) ────────────────────────
console.log('\n5. Pagination: no page cap, Workday total-only-on-page-1');
const realFetch = globalThis.fetch;
const reply = (body, text = false) => ({ ok: true, status: 200, json: async () => body, text: async () => (text ? body : JSON.stringify(body)) });
try {
  // Workday: 1,234 jobs, `total` present ONLY on page 1 (offset>0 returns total:0).
  let calls = 0;
  globalThis.fetch = async (u, init) => {
    calls++; const { offset, limit } = JSON.parse(init.body);
    const n = Math.max(0, Math.min(limit, 1234 - offset));
    return reply({ total: offset === 0 ? 1234 : 0, jobPostings: Array.from({ length: n }, (_, i) => ({ title: `J${offset + i}`, externalPath: `/job/x_${offset + i}`, postedOn: 'Posted Today' })) });
  };
  const wd = await fetchWorkday('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs');
  ok(wd.jobPostings.length === 1234 && new Set(wd.jobPostings.map((j) => j.title)).size === 1234, `workday: 1234/1234 fetched in ${calls} calls (old code stopped at 40, then 200)`);

  globalThis.fetch = async (u) => {
    const o = Number(new URL(u).searchParams.get('offset')); const n = Math.max(0, Math.min(100, 317 - o));
    return reply({ totalFound: 317, content: Array.from({ length: n }, (_, i) => ({ id: String(o + i), name: 'x' })) });
  };
  const sr = await fetchSmartRecruiters({ url: 'https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100', _slug: 'acme' });
  ok(sr.content.length === 317, `smartrecruiters: 317/317 (was capped at 100)`);

  const card = (id) => `<li class="iCIMS_JobCardItem"><span class="sr-only field-label">Posted Date</span><span title="10/1/2026 9:00 AM">x</span><a href="https://careers-acme.icims.com/jobs/${id}/t/job?in_iframe=1" class="iCIMS_Anchor" title="${id} - Role ${id}"><h3>Role ${id}</h3></a><dt><span class="sr-only field-label">Job Location</span></dt><dd><span>US-TX-Austin</span></dd></li>`;
  globalThis.fetch = async (u) => {
    const pr = Number(new URL(u).searchParams.get('pr') || 0);
    return reply(`Page ${pr + 1} of 7 ${Array.from({ length: 20 }, (_, i) => card(pr * 20 + i)).join('')}`, true);
  };
  const icApi = detectApi({ careers_url: 'https://careers-acme.icims.com/jobs' });
  const ic = PARSERS.icims(await fetchIcims(icApi), 'Acme', icApi);
  ok(ic.length === 140, `icims: 7 pages -> ${ic.length}/140 jobs`);

  globalThis.fetch = async (u) => {
    const o = Number(String(u).match(/offset=(\d+)/)[1]); const n = Math.max(0, Math.min(200, 650 - o));
    return reply({ items: [{ TotalJobsCount: 650, requisitionList: Array.from({ length: n }, (_, i) => ({ Id: String(o + i), Title: 'T', PostedDate: '2026-10-01', PrimaryLocation: 'Austin, TX' })) }] });
  };
  const orApi = detectApi({ careers_url: 'https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions' });
  const or = PARSERS.oracle(await fetchOracle(orApi), 'Acme', orApi);
  ok(or.length === 650, `oracle: limit=200 paging -> ${or.length}/650`);

  const req = (id) => `!|!${id}!|!Role ${id}!|!${id}!|!Role ${id}!|!${id}!|!JR${id}!|!United States-Texas-Austin!|!false!|!`;
  globalThis.fetch = async (u, init) => {
    if (!init?.method || init.method === 'GET') return reply(`x listRequisition.nbElements!|!60!|! ${Array.from({ length: 25 }, (_, i) => req(1000 + i)).join('')}`, true);
    const p = Number(new URLSearchParams(String(init.body)).get('rlPager.currentPage'));
    return reply(Array.from({ length: Math.min(25, 60 - (p - 1) * 25) }, (_, i) => req(1000 + (p - 1) * 25 + i)).join(''), true);
  };
  const tlApi = detectApi({ careers_url: 'https://acme.taleo.net/careersection/2/jobsearch.ftl' });
  const tl = PARSERS.taleo(await fetchTaleo(tlApi), 'Acme', tlApi);
  ok(tl.length === 60 && tl[0].url.includes('jobdetail.ftl?job=JR1000'), `taleo: ajax paging -> ${tl.length}/60`);
  // Lazy-loaded section (tgh.taleo.net/ex): the .ftl has no stream and no total; ajax page 1 does.
  globalThis.fetch = async (u, init) => {
    if (!init?.method || init.method === 'GET') return reply('<html>loading…</html>', true);
    const p = Number(new URLSearchParams(String(init.body)).get('rlPager.currentPage'));
    return reply(`listRequisition.nbElements!|!60!|! ` + Array.from({ length: Math.min(25, 60 - (p - 1) * 25) }, (_, i) => req(1000 + (p - 1) * 25 + i)).join(''), true);
  };
  const tlLazy = await fetchTaleo(tlApi);
  const tl2 = PARSERS.taleo(tlLazy, 'Acme', tlApi);
  ok(tl2.length === 60 && !tlLazy.partial, `taleo: lazy-loaded section falls back to ajax page 1 -> ${tl2.length}/60 (was 0)`);
  // A dropped page is reported as partial, not silently shortened.
  globalThis.fetch = async (u, init) => {
    if (!init?.method || init.method === 'GET') return reply(`x listRequisition.nbElements!|!60!|! ${Array.from({ length: 25 }, (_, i) => req(1000 + i)).join('')}`, true);
    return { ok: false, status: 503, text: async () => '' };
  };
  const tlPart = await fetchTaleo(tlApi);
  ok(tlPart.partial === true, `taleo: failed pages flag the result partial`);
  // TGH column layout: id repeats twice more before jobNo; location must not be the req id.
  const tgh = '!|!684043!|!Physical Therapist!|!684043!|!Physical Therapist!|!684043!|!684043!|!684043!|!260003B0!|!Healthplex Brandon!|!10740 Palm River Rd!|! !|!Tampa!|!33619!|!Full-time!|!x!|!Sep 15, 2026!|!';
  const tg = PARSERS.taleo({ pages: [tgh] }, 'TGH', tlApi);
  ok(tg.length === 1 && tg[0].location === 'Healthplex Brandon' && tg[0].url.includes('job=260003B0'), `taleo TGH layout: location ${JSON.stringify(tg[0]?.location)} (was req id)`);
  ok(tg[0]?.postedAt?.startsWith('2026-09-15'), `taleo: per-req date parsed -> ${tg[0]?.postedAt}`);
  ok(ATS_MAX_JOBS >= 10000, `ATS_MAX_JOBS safety ceiling = ${ATS_MAX_JOBS} (env CAREER_FINDER_ATS_MAX_JOBS)`);
} finally { globalThis.fetch = realFetch; }

// ── 5b. Workday "N Locations" placeholder (stubbed fetch) ────────────
console.log('\n5b. Workday multi-site placeholder is resolved, never filtered on');
try {
  const detailCalls = [];
  globalThis.fetch = async (u, init) => {
    if (init?.method === 'POST') return reply({ total: 3, jobPostings: [
      { title: 'A', externalPath: '/job/a_1', locationsText: '2 Locations', postedOn: 'Posted Today' },
      { title: 'B', externalPath: '/job/b_2', locationsText: '3 Locations', bulletFields: ['R-123', 'San Francisco, CA'], postedOn: 'Posted Today' },
      { title: 'C', externalPath: '/job/c_3', locationsText: '4 Locations', postedOn: 'Posted Today' },
    ] });
    detailCalls.push(u);
    if (u.endsWith('/job/a_1')) return reply({ jobPostingInfo: { location: 'Austin, TX', additionalLocations: ['San Jose, CA'] } });
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  const api = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs';
  const wd = await fetchWorkday(api);
  const by = Object.fromEntries(wd.jobPostings.map((j) => [j.title, j.locationsText]));
  ok(by.A === 'Austin, TX; San Jose, CA', `detail fetch resolves "2 Locations" -> ${by.A}`);
  ok(detailCalls.includes('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/a_1'), 'detail URL = cxs base + externalPath');
  ok(by.B === 'San Francisco, CA', 'bulletFields location used without a detail fetch (req id ignored)');
  ok(!detailCalls.some((u) => u.endsWith('/job/b_2')), '...so no detail call is spent on it');
  ok(by.C === WORKDAY_LOC_UNRESOLVED, 'a failed detail fetch leaves the unresolved marker, not the placeholder');
  const parsed = PARSERS.workday({ jobPostings: [{ title: 'D', externalPath: '/job/d', locationsText: '5 Locations' }] }, 'Acme', detectApi({ api }));
  ok(parsed[0].location === WORKDAY_LOC_UNRESOLVED, 'parseWorkday never emits the raw "N Locations" placeholder');
  ok(buildLocationFilter()(WORKDAY_LOC_UNRESOLVED, 'Engineer') === true, 'location filter passes the unresolved marker through to the scorer');
} finally { globalThis.fetch = realFetch; }

// ── 5c. scan-index --only list parsing ───────────────────────────────
console.log('\n5c. --only accepts files with or without a header');
ok([...parseOnlyList('company\tcareers_url\nAcme\thttps://x\nBeta\thttps://y\n')].join() === 'acme,beta', 'TSV with a company header');
ok([...parseOnlyList('Acme\thttps://x\nBeta\thttps://y\n')].join() === 'acme,beta', 'headerless TSV keeps its first company');
ok([...parseOnlyList('Company\nAcme\n')].join() === 'acme', 'bare "Company" header');
ok([...parseOnlyList('Acme\nBeta\n')].join() === 'acme,beta', 'plain list keeps its first company');
ok([...parseOnlyList('score\tcompany\turl\nAcme\t1\n')].join() === 'acme', 'header detected by a company token in any column');

// ── 5d. probe-ats name variants + embedded careers-page boards ───────
console.log('\n5d. probe-ats: slug variants and embedded Greenhouse/Lever/Ashby links');
const sv = slugs('Acme Health Inc');
ok(sv[0] === 'acmehealthinc' && sv.includes('acmehealth') && sv.includes('acme-health') && sv.includes('acme'), `slugs("Acme Health Inc") -> ${sv.join(',')}`);
ok(slugs('Tempus Labs').includes('tempus') && slugs('Tempus Labs')[0] === 'tempuslabs', 'slugs drops Labs and keeps the full form first');
ok(slugs('Northwind Analytics').at(-1) === 'northwind', 'first word is the last (loosest) variant');
const eb = embeddedBoards('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeco"></script><a href="https://acme.com/careers?gh_jid=4012345">Role</a>');
ok(eb.boards[0] === 'https://job-boards.greenhouse.io/acmeco' && eb.ghJid, 'greenhouse embed ?for=<token> + gh_jid detected (not "embed" as the board)');
ok(!embeddedBoards('<a href="https://boards.greenhouse.io/embed/job_app?token=1">x</a>').boards.length, '"embed" is never taken as a board token');
ok(embeddedBoards('<a href="https://jobs.lever.co/foo/abc-123">x</a>').boards[0] === 'https://jobs.lever.co/foo', 'jobs.lever.co link');
ok(embeddedBoards('<iframe src="https://jobs.ashbyhq.com/bar/embed?version=2"></iframe>').boards[0] === 'https://jobs.ashbyhq.com/bar', 'jobs.ashbyhq.com embed');
ok(embeddedBoards('{"u":"https:\\/\\/boards.greenhouse.io\\/zeta\\/jobs\\/1"}').boards[0] === 'https://job-boards.greenhouse.io/zeta', 'JSON-escaped boards.greenhouse.io link');
try {
  globalThis.fetch = async () => reply('<html><a href="/jobs?gh_jid=99">Eng</a><script src="https://boards.greenhouse.io/embed/job_board/js?for=widgetco"></script></html>', true);
  const r = await probeCareersUrl('https://widget.example.com/careers');
  ok(r?.family === 'greenhouse' && r.supported && /widgetco/.test(r.careers_url), `probeCareersUrl resolves an embedded board -> ${r?.careers_url}`);
  globalThis.fetch = async () => reply('<html><a href="/jobs?gh_jid=99">Eng</a></html>', true);
  const r2 = await probeCareersUrl('https://widget2.example.com/careers');
  ok(r2?.family === 'greenhouse' && !r2.supported, 'gh_jid with no board token = detect-only greenhouse');
} finally { globalThis.fetch = realFetch; }

// ── 6. Live ──────────────────────────────────────────────────────────
if (LIVE) {
  console.log('\n6. LIVE: one+ real public board per family');
  for (const [fam, urls] of Object.entries(LIVE_BOARDS)) {
    if (ONLY && fam !== ONLY) continue;
    for (const u of urls) {
      const api = detectApi({ careers_url: u });
      if (!api) { ok(false, `${fam} ${u}: detectApi returned null`); continue; }
      const t0 = Date.now();
      try {
        const jobs = PARSERS[api.type](await fetchProvider(api), fam, api);
        checkJobs(fam, jobs, { label: `${fam} ${new URL(u).host} (${((Date.now() - t0) / 1000).toFixed(1)}s)` });
      } catch (e) { ok(false, `${fam} ${u}: ${e.message}`); }
    }
  }
  console.log('\n7. LIVE: probeCareersUrl on vanity / bare URLs');
  for (const [u, fam] of [['https://careers.oracle.com/jobs/', 'oracle'], ['https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/', 'oracle'], ['https://careers-gdms.icims.com/jobs', 'icims']]) {
    const r = await probeCareersUrl(u).catch(() => null);
    ok(r?.family === fam && r.supported, `probeCareersUrl(${u}) -> ${r?.family} ${r?.board} via ${r?.via}`);
  }
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
