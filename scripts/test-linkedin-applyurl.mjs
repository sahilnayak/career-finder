#!/usr/bin/env node
/**
 * Offline tests for the Apply-href → ATS resolution parsers and the LinkedIn job-alert
 * subject parser. No browser, no network, no LinkedIn budget — the same reason
 * test-linkedin-parse.mjs exists: a parser that can only run against a live logged-in
 * LinkedIn is a parser that rots silently.
 */
import './fixtures/use-test-profile.mjs'; // must stay first: pins targets.mjs to the fixture profile
import { parseAtsUrl, unwrapSafety } from './linkedin-applyurl.mjs';
import { parseJobSubject } from './linkedin-email-alerts.mjs';
import { SEARCH_KEYWORDS } from './role-filters.mjs';
import { loadTargets } from './targets.mjs';
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`  ✗ ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};
const ok = (name, cond) => { cond ? pass++ : fail++; if (!cond) console.log(`  ✗ ${name}`); };

console.log('unwrapSafety');
eq('greenhouse behind /safety/go',
  unwrapSafety('https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjob-boards%2Egreenhouse%2Eio%2Fintercom%2Fjobs%2F8123007%3Fgh_src%3Dm3lq2e1&urlhash=LdL2'),
  'https://job-boards.greenhouse.io/intercom/jobs/8123007?gh_src=m3lq2e1');
eq('Easy Apply (internal link) yields null',
  unwrapSafety('https://www.linkedin.com/jobs/view/123/apply'), null);
eq('null href', unwrapSafety(null), null);

console.log('parseAtsUrl');
const gh = parseAtsUrl('https://job-boards.greenhouse.io/intercom/jobs/8123007?gh_src=m3lq2e1');
eq('greenhouse slug', gh.slug, 'intercom');
eq('greenhouse jobId', gh.jobId, '8123007');
eq('greenhouse exact-req api', gh.apiUrl, 'https://boards-api.greenhouse.io/v1/boards/intercom/jobs/8123007');
const ash = parseAtsUrl('https://jobs.ashbyhq.com/corridor/32951312-54c9-4239-bad6-183a02540249');
eq('ashby slug', ash.slug, 'corridor');
eq('ashby type', ash.atsType, 'ashby');
const lev = parseAtsUrl('https://jobs.lever.co/finchapi/6b1f2c3d-4e5f-6789-abcd-ef0123456789');
eq('lever type', lev.atsType, 'lever');
eq('lever exact-req api', lev.apiUrl, 'https://api.lever.co/v0/postings/finchapi/6b1f2c3d-4e5f-6789-abcd-ef0123456789');
eq('workday family', parseAtsUrl('https://cisco.wd1.myworkdayjobs.com/en-US/x/job/y').atsType, 'workday');
// An unknown careers host is still useful: it names the employer's real domain for the index.
const unk = parseAtsUrl('https://careers.someco.com/jobs/42');
eq('unknown family kept', unk.atsType, 'unknown');
eq('unknown keeps host', unk.host, 'careers.someco.com');
eq('garbage url', parseAtsUrl('not a url'), null);

console.log('parseJobSubject (real observed subjects)');
eq('saved-search shape',
  (({ company, title }) => ({ company, title }))(parseJobSubject('“data engineer”: Box - Senior Data Engineer posted on 6/8/26')),
  { company: 'Box', title: 'Senior Data Engineer' });
eq('title-with-comma survives',
  parseJobSubject('“data engineer posted in the past…”: Anrok - Data Engineer, Platform posted on 7/3/26').title,
  'Data Engineer, Platform');
eq('salary shape', (({ company, title }) => ({ company, title }))(parseJobSubject('Analytics Engineer at Kastel Group: up to $160K/year')),
  { company: 'Kastel Group', title: 'Analytics Engineer' });
eq('possessive shape', (({ company, title }) => ({ company, title }))(parseJobSubject('You may be a fit for Valon’s Data Engineer role - 1 connection')),
  { company: 'Valon', title: 'Data Engineer' });
eq('similar-to shape', (({ company, title }) => ({ company, title }))(parseJobSubject('New jobs similar to Data Platform Engineer at Jagger')),
  { company: 'Jagger', title: 'Data Platform Engineer' });
eq('bracket tag stripped', parseJobSubject('Sales Development Representative [SDR] at Metriport').title,
  'Sales Development Representative');
// "X is hiring for a Y role" names a CATEGORY, not a requisition — it must be flagged vague so
// it is never treated as a scoreable req.
ok('category subject flagged vague', parseJobSubject('Deepgram is hiring for a Network role').vague === true);
eq('unparseable subject', parseJobSubject('A six-figure, AI-proof job'), null);

console.log('SEARCH_KEYWORDS comes from targets.roles in config/profile.yml');
eq('searched titles = targets.roles, lowercased', [...SEARCH_KEYWORDS],
  loadTargets().targets.roles.map((r) => r.toLowerCase()));
ok('frozen so no lane can mutate it', Object.isFrozen(SEARCH_KEYWORDS));
// The lanes and the cron must DERIVE this list from config, never restate a hard-coded one.
for (const f of ['linkedin-crawl.mjs', 'linkedin-jobsearch.mjs', 'speed-linkedin.mjs']) {
  const src = readFileSync(`scripts/${f}`, 'utf-8');
  ok(`${f} imports SEARCH_KEYWORDS`, /SEARCH_KEYWORDS/.test(src));
}
const morning = readFileSync('scripts/morning.mjs', 'utf-8');
ok('the morning run derives LinkedIn keywords from config, does not hard-code its own list',
  /searchKeywords\(\)/.test(morning) && !/--keywords',\s*'[a-z]/i.test(morning));

console.log(`\n\u{1F4CA} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
