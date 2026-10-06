#!/usr/bin/env node
/**
 * test-filters.mjs — offline tests for the location + title filters (build-plan step 2).
 * No network. Two parts:
 *   1. Unit checks: multi-value location parsing, any-place-in-area, flags, role synonyms,
 *      profile-driven seniority negatives, the loadNoise() wiring in every employer lane.
 *   2. Truth fixture: every row of scripts/fixtures/discovery/2026-10-06-weekday/truth.tsv (postings
 *      the employer ATS dated inside the 2026-10-05 window, found by hand) must survive the title
 *      and location filters under a generic SF Bay Area profile for its role. The only rows allowed
 *      to fail are listed in EXCEPTIONS below, each with the reason.
 *
 *   node scripts/test-filters.mjs
 */

import './fixtures/use-test-profile.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIX = join(HERE, 'fixtures/discovery');

// ── child mode: score one role's truth rows under the profile in CAREER_FINDER_PROFILE ──────
if (process.argv[2] === '--child') {
  const T = await import('./targets.mjs');
  const S = await import('./scan-core.mjs');
  const verdict = S.buildLocationVerdict();
  const rows = JSON.parse(process.argv[3]);
  console.log(JSON.stringify(rows.map(r => {
    const lv = verdict(r.location, r.title, []);
    return { title: r.title, location: r.location, titleOk: T.titleMatches(r.title), locOk: lv.ok, flag: lv.flag,
      titleRule: T.explainTitle(r.title).rule, locRule: lv.rule };
  })));
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ✅ ${m}`); } else { failed++; console.log(`  ❌ ${m}`); } };

const T = await import('./targets.mjs');
const S = await import('./scan-core.mjs');
const verdict = S.buildLocationVerdict();
// Fixture profile: Chicago, hybrid-ish remote-country (US). Remote US passes, flagged.

console.log('\n1. splitLocations');
const sp = T.splitLocations;
ok(JSON.stringify(sp('San Francisco, CA | New York, NY')) === '["San Francisco, CA","New York, NY"]', 'pipe separates places, state suffix stays attached');
ok(JSON.stringify(sp('Denver, CO; San Francisco, CA')) === '["Denver, CO","San Francisco, CA"]', 'semicolon separates places');
ok(JSON.stringify(sp('San Francisco HQ / Remote')) === '["San Francisco HQ","Remote"]', 'slash separates places');
ok(JSON.stringify(sp('SF or Remote')) === '["SF","Remote"]', '" or " separates places');
ok(JSON.stringify(sp('San Francisco, New York, Seattle')) === '["San Francisco","New York","Seattle"]', 'comma lists of cities split');
ok(JSON.stringify(sp('San Francisco, CA, US; Remote, US')) === '["San Francisco, CA, US","Remote, US"]', 'state and country suffixes stay with their city');
ok(JSON.stringify(sp('San Francisco, CA, New York, NY, Portland, OR, or Remote within Canada or United States'))
  === '["San Francisco, CA","New York, NY","Portland, OR","Remote within Canada","United States"]', 'a long mixed list splits into five places');
ok(JSON.stringify(sp('')) === '[]', 'empty string has no places');

console.log('\n2. Location verdicts (fixture profile: Chicago, remote_policy remote-country)');
const v = (loc, title = '', offices = []) => verdict(loc, title, offices);
ok(v('Chicago, IL').ok && v('Chicago, IL').flag === '', 'plain local row passes with no flag');
ok(v('New York, NY | Chicago, IL').ok && v('New York, NY | Chicago, IL').flag === 'multi-location', 'ANY place in area passes; multi-location flagged');
ok(v('Evanston or Remote').ok && v('Evanston or Remote').flag === 'also-remote', 'local-or-remote passes, flagged also-remote');
ok(v('Chicago HQ / Remote').ok, 'HQ slash Remote passes');
ok(v('Remote - Chicago').ok && v('Remote - Chicago').flag === 'remote-in-metro', 'Remote - <local city> is local, flagged remote-in-metro');
ok(v('US-CHI-HQ, US-NYC').ok === false, 'an airport-style code the profile does not name does not pass');
ok(v('Remote, US').ok && v('Remote, US').flag === 'remote-us', 'US-remote passes when policy allows, flagged remote-us');
ok(!v('Remote - EMEA').ok, 'foreign remote is still dropped');
ok(!v('Dubai | Remote job').ok, 'a foreign place cannot lend its remote segment a pass');
ok(!v('United States').ok, 'a bare country is not a local place');
ok(!v('New York, NY | Austin, TX').ok, 'no place in area is dropped');
ok(!v('West Coast - United States').ok, '"West Coast" alone proves nothing');
ok(v('West Coast - United States | Chicago').ok, '"West Coast" row that also lists a configured city passes');
ok(!v('Naperville, Ireland').ok, 'a city name followed by a foreign country is not local');
ok(!v('Chicago, GA').ok, 'a local city name pinned to another US state is not local');
ok(v('New York, NY', 'Data Engineer', ['Chicago Office']).ok && v('New York, NY', 'x', ['Chicago Office']).flag === 'via-offices',
  'a place in offices[] (Greenhouse/Ashby) passes the row, flagged via-offices');
ok(!v('New York, NY', 'x', ['Austin Office']).ok, 'offices[] with no local place do not pass');
ok(v('Chicago (+8 US locations)').flag === 'multi-location', '"(+N locations)" is flagged multi-location');
ok(!v('').ok, 'empty location is dropped (unknown proves nothing)');
ok(S.buildLocationFilter()(S.WORKDAY_LOC_UNRESOLVED, 'x') === true, 'unresolved Workday marker still passes to the scorer');
ok(S.buildLocationFilter()('Chicago, IL', 'x', []) === true, 'buildLocationFilter stays boolean');

console.log('\n3. offices[] reach the filter (parsers expose them already; no new field needed)');
const gh = S.PARSERS.greenhouse({ jobs: [{ title: 'Data Engineer', absolute_url: 'https://x/1', location: { name: 'New York' }, offices: [{ name: 'Chicago' }] }] }, 'Acme');
ok(gh[0].offices.includes('Chicago'), 'Greenhouse parser exposes offices[]');
const ab = S.PARSERS.ashby({ jobs: [{ title: 'Data Engineer', jobUrl: 'https://x/2', location: 'New York', secondaryLocations: [{ location: 'Chicago' }] }] }, 'Acme');
ok(ab[0].offices.includes('Chicago'), 'Ashby parser exposes secondaryLocations in offices[]');
ok(v(gh[0].location, gh[0].title, gh[0].offices).ok && v(ab[0].location, ab[0].title, ab[0].offices).ok, 'both rows pass on the secondary place');
const scanIdx = readFileSync(join(HERE, 'scan-index.mjs'), 'utf8');
ok(/locVerdict\(job\.location, job\.title, job\.offices\)/.test(scanIdx), 'scan-index passes offices[] to the gate');
ok(/loc_flag: \$\{c\.loc_flag\}/.test(scanIdx) && /c\.loc_flag \|\| ''/.test(scanIdx), 'scan-index prints loc_flag and writes it as the last TSV column');
ok(/job\.offices/.test(readFileSync(join(HERE, 'scan.mjs'), 'utf8')) && /job\.offices/.test(readFileSync(join(HERE, 'hunt.mjs'), 'utf8')), 'scan.mjs and hunt.mjs pass offices[] too');

console.log('\n4. Role synonyms (fixture roles: Data Engineer, Analytics Engineer, Data Platform Engineer)');
ok(T.synonymsFor('Software Engineer').includes('Member of Technical Staff'), 'built-in: software engineer -> Member of Technical Staff');
ok(T.synonymsFor('Senior Software Engineer').includes('SWE'), 'level words are stripped before the built-in lookup');
ok(T.synonymsFor('Data Engineer').includes('Analytics Engineer'), 'built-in: data engineer -> Analytics Engineer');
ok(['Solutions Engineer', 'Pre-Sales Engineer'].every(x => T.synonymsFor('Sales Engineer').includes(x)), 'built-in: sales engineer -> Solutions Engineer, Pre-Sales Engineer');
ok(!T.synonymsFor('Sales Engineer').some(x => /forward deployed|^fde$/i.test(x)), 'built-in: sales engineer does NOT widen to FDE (opt in via targets.synonyms)');
ok(['RN', 'Staff Nurse', 'Clinical Nurse'].every(x => T.synonymsFor('Registered Nurse').includes(x)), 'built-in: registered nurse -> RN, Staff Nurse, Clinical Nurse');
ok(T.synonymsFor('Underwater Welder').length === 0, 'an unknown role has no synonyms');
ok(T.explainTitle('Data Engineer II').decision === 'keep' && /role "Data Engineer"/.test(T.explainTitle('Data Engineer II').rule), 'explainTitle names the role that kept a title');
ok(/no role/.test(T.explainTitle('Pastry Chef').rule), 'explainTitle names the missing positive');
ok(/hard negative "!director"/.test(T.explainTitle('Director, Data Engineering').rule), 'explainTitle names the hard negative');

console.log('\n4b. Review fixes: portals positives do not mask the vocabulary; manager-ladder titles');
{
  const SC = await import('./scan-core.mjs');
  const portals = yaml.load(readFileSync(join(REPO, 'templates/portals.example.yml'), 'utf8'));
  const f = SC.buildTitleFilter(portals.title_filter, { dropSeniorityNegatives: true });
  ok(f('Data Platform Software Engineer'), 'with the shipped example portals.yml positives, "Data Platform Software Engineer" still passes (vocabulary OR-ed in)');
  ok(f('Data Engineer II'), 'a plain portals positive still matches');
  ok(!f('Pastry Chef'), 'an unrelated title still fails');
  ok(readFileSync(join(HERE, 'scan-core.mjs'), 'utf8').includes('viaTargets'), 'buildTitleFilterInner ORs titleMatches in when targets exist');
}

console.log('\n5. Profile-driven seniority (separate profiles, child processes)');
const TMP = mkdtempSync(join(tmpdir(), 'cf-test-filters-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const BAY = ['San Francisco', 'Oakland', 'Berkeley', 'San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Palo Alto', 'Menlo Park',
  'Redwood City', 'San Mateo', 'Burlingame', 'Belmont', 'Pleasanton', 'Dublin', 'Vallejo', 'Antioch', 'Santa Rosa', 'Castro Valley', 'Bay Area'];
function profileFor({ roles, kw = [], neg = [], years = 4, mgmt = false, extra = {}, remote = 'hybrid' }) {
  return { candidate: { years }, targets: { roles, title_keywords: kw, title_negatives: neg, primary_role: roles[0], include_management: mgmt, ...extra },
    location: { metro: 'San Francisco Bay Area', city: 'San Francisco', state: 'CA', country: 'United States', cities: BAY, remote_policy: remote } };
}
function runChild(name, prof, rows) {
  const f = join(TMP, `${name}.yml`);
  writeFileSync(f, yaml.dump(prof));
  const r = spawnSync('node', [join(HERE, 'test-filters.mjs'), '--child', JSON.stringify(rows)], { env: { ...process.env, CAREER_FINDER_PROFILE: f }, encoding: 'utf8', cwd: REPO });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}
const dir = [{ title: 'Director of Customer Success', location: 'San Francisco' }, { title: 'VP, Customer Success', location: 'San Francisco' },
  { title: 'Head of Customer Success', location: 'San Francisco' }, { title: 'Customer Success Manager', location: 'San Francisco' }];
const base = { roles: ['Customer Success Manager'], kw: ['Customer Success'] };
const dflt = runChild('default', profileFor(base), dir);
ok(dflt && dflt.every(r => r.titleOk), 'role-agnostic default: no director/vp/head-of negative drops a title');
const ic = runChild('ic', profileFor({ ...base, extra: { seniority: 'ic' } }), dir);
ok(ic && ic.map(r => r.titleOk).join() === 'false,false,false,true', 'targets.seniority: ic adds director/vp/head-of gates from the profile');
const mk2 = runChild('mktg', profileFor({ roles: ['Marketing Manager'], kw: [] }), [{ title: 'Director of Product Marketing', location: 'San Francisco' }, { title: 'Head of Marketing & Creative', location: 'San Francisco' }, { title: 'Product Designer', location: 'San Francisco' }]);
ok(mk2 && mk2.map(r => r.titleOk).join() === 'true,true,false', 'a "Marketing Manager" role also keeps Director of / Head of titles in that function, not other functions');
const mkIc = runChild('mktg-ic', profileFor({ roles: ['Marketing Manager'], kw: [], extra: { seniority: 'ic' } }), [{ title: 'Director of Product Marketing', location: 'San Francisco' }, { title: 'Marketing Manager', location: 'San Francisco' }]);
ok(mkIc && mkIc.map(r => r.titleOk).join() === 'false,true', 'targets.seniority: ic still drops the Director rung (the ladder match never overrides it)');
ok(ic && /targets\.seniority=ic/.test(ic[1].titleRule), 'seniority-derived gates are named in the rule');
const alias = runChild('alias', profileFor({ ...base, extra: { negatives: ['!vp'] } }), dir);
ok(alias && alias.map(r => r.titleOk).join() === 'true,false,true,true', 'targets.negatives is an alias of title_negatives');
const syn = runChild('syn', profileFor({ roles: ['Software Engineer'], extra: { synonyms: { 'software engineer': ['Code Wrangler'] } } }),
  [{ title: 'Code Wrangler', location: 'San Francisco' }, { title: 'Member of Technical Staff', location: 'San Francisco' }]);
ok(syn && syn[0].titleOk && !syn[1].titleOk, 'targets.synonyms replaces the built-in list for the roles it names');
const sw = runChild('sw', profileFor({ roles: ['Software Engineer'] }), [{ title: 'Member of Technical Staff', location: 'San Francisco' },
  { title: 'SWE II', location: 'San Francisco' }, { title: 'Software Developer', location: 'San Francisco' }, { title: 'Software Engineering Manager', location: 'San Francisco' },
  { title: 'Preswe Analyst', location: 'San Francisco' }]);
ok(sw && sw[0].titleOk && sw[1].titleOk && sw[2].titleOk, 'built-in synonyms keep MTS, SWE, Software Developer for a software engineer profile');
ok(sw && !sw[4].titleOk, 'synonyms match on word boundaries ("Preswe" is not SWE)');
const cli = spawnSync('node', [join(HERE, 'targets.mjs'), '--test', 'Director, Data Engineering', 'Chicago, IL'], { encoding: 'utf8', env: { ...process.env, CAREER_FINDER_PROFILE: join(HERE, 'fixtures/profile.test.yml') } });
ok(/"titleRule"/.test(cli.stdout) && /hard negative/.test(cli.stdout) && /"locationRule"/.test(cli.stdout), 'targets.mjs --test shows which rule decided, title and location');

console.log('\n6. Every lane that names an employer filters through loadNoise()');
for (const f of ['scan-index', 'hiringcafe-scan', 'workable-search', 'browser-boards', 'speed-linkedin', 'linkedin-jobsearch', 'resolve-nominations', 'discover-companies']) {
  const src = readFileSync(join(HERE, `${f}.mjs`), 'utf8');
  ok(/loadNoise\(\)/.test(src) && /(NOISE|noise)\b[^;\n]*\.some\(|blocked\(/.test(src), `${f}.mjs loads the blocklist and applies it`);
}

console.log('\n7. Truth fixture: every weekday truth row survives under a generic Bay Area profile');
// role -> profile pieces (the same families the 2026-10-04 audit used). Level gates are NOT included:
// the default carries none, and the profile gets only the role's own soft/hard words.
const ROLES = JSON.parse(readFileSync(join(FIX, '2026-10-04-weekend/roles.json'), 'utf8'));
const truth = readFileSync(join(FIX, '2026-10-06-weekday/truth.tsv'), 'utf8').split('\n').filter(Boolean);
const head = truth[0].split('\t');
const rows = truth.slice(1).map(l => Object.fromEntries(l.split('\t').map((c, i) => [head[i], c])));
ok(rows.length === 118, `fixture has 118 truth rows (found ${rows.length})`);
const EXCEPTIONS = {
  'software-engineer|New Grad Software Engineer, Product Engineering': 'entry-level title; the profile has 4 years, so the entry-level gate drops it by design',
  'software-engineer|NVIDIA 2027 Ignite Internships: Software Engineering': 'internship; same entry-level gate',
  'registered-nurse|Staff Nurse I, New Grad, Universal Care Unit': 'new-grad title; the profile has 3 years',
  'registered-nurse|Manager, Inpatient Nursing, Family Birth Center': 'nursing management, not the staff RN role (truth note: RN-licensed leadership)',
  'registered-nurse|Inpatient Nursing Manager, Medical Surgical Telemetry': 'nursing management, not the staff RN role (two rows, same title)',
  'account-executive|Strategic Core Account Executive': 'location is only "West Coast - United States"; the Bay shows up nowhere in the ATS record',
  'financial-analyst|Finance Pathways Rotation Analyst (Early Career)': 'early-career gate, and the ATS location says only "Georgia - Atlanta" (Bay sites are in the truth notes, not the field)',
};
const kept = [], dropped = [];
for (const [slug, R] of Object.entries(ROLES)) {
  const mine = rows.filter(r => r.role === slug);
  if (!mine.length) continue;
  const res = runChild(slug, profileFor({ roles: [R.role, ...(R.alt || [])], kw: R.kw || [], neg: R.neg || [], years: R.years, mgmt: !!R.mgmt }), mine);
  if (!res) { ok(false, `${slug}: child process produced no output`); continue; }
  res.forEach((r, i) => {
    const key = `${slug}|${mine[i].title}`;
    const good = r.titleOk && r.locOk;
    if (good) kept.push(key); else dropped.push({ key, why: !r.titleOk ? `title: ${r.titleRule}` : `location "${r.location}": ${r.locRule}` });
  });
}
const unexplained = dropped.filter(d => !(d.key in EXCEPTIONS));
unexplained.forEach(d => console.log(`     dropped without an exception: ${d.key} (${d.why})`));
ok(unexplained.length === 0, `no truth row is dropped except the ${Object.keys(EXCEPTIONS).length} listed exceptions (${kept.length} of ${rows.length} kept)`);
const stale = Object.keys(EXCEPTIONS).filter(k => !dropped.some(d => d.key === k));
stale.forEach(k => console.log(`     exception no longer needed: ${k}`));
ok(stale.length === 0, 'every listed exception is still needed (the list cannot rot)');
ok(kept.length + dropped.length === rows.length, 'every truth row was evaluated');
const multiKept = rows.filter(r => /[|;\/]| or |\(\+/.test(r.location)).length;
ok(multiKept >= 30, `fixture exercises ${multiKept} multi-value location rows`);

console.log(`\n📊 ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('🟢 Filters verified (offline).');
