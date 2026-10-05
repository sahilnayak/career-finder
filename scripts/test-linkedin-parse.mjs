#!/usr/bin/env node

/**
 * test-linkedin-parse.mjs — offline tests for the LinkedIn results-pane parser.
 *
 * No browser, no network, no LinkedIn budget. Run it after ANY change to
 * linkedin-parse.mjs, and after any run where the card count looks wrong.
 *
 * Fixtures are transcribed from real innerText captured from a real r86400 search (titles
 * and places anonymized; the parser is role- and geography-agnostic).
 *
 *   node scripts/test-linkedin-parse.mjs
 */

import { parseCards, ANCHOR, htmlToText } from './linkedin-parse.mjs';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(REPO, 'scripts/fixtures/linkedin');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✅ ${msg}`); pass++; } else { console.log(`  ❌ ${msg}`); fail++; } };
const eq = (got, want, msg) => ok(got === want, `${msg}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);

// A real page opens with the anchor line, then card after card. Each card is
// Title / Company / Location / "Posted N ago" / bare "N ago", plus chrome.
const PAGE = [
  ANCHOR,
  'Senior Data Engineer (Verified job)',
  'Acme Robotics',
  'Chicago, IL (On-site)',
  'Be an early applicant',
  'Posted 5 hours ago',
  '5 hours ago',
  'Data Engineer (Platform)- Small, Medium & Growth Business',
  'Salesforce',
  'Chicago, IL (Hybrid)',
  'Promoted',
  '$120,000/yr - $180,000/yr',
  'Posted 12 hours ago',
  '12 hours ago',
  'Analytics Engineer',
  'Example Labs',
  'Chicago, IL (On-site)',
  'Easy Apply',
  'Posted 20 hours ago',
  '20 hours ago',
].join('\n');

console.log('\n1. The slice anchor is not a job title (the bug that ate one card per page)');
const cards = parseCards(PAGE);
eq(cards.length, 3, 'all three cards parse (the first is not consumed by the anchor)');
eq(cards[0].title, 'Senior Data Engineer', 'card 1 title is the REAL title, not "How promoted jobs are ranked"');
eq(cards[0].company, 'Acme Robotics', 'card 1 company is the REAL company, not the shifted title');
ok(!cards.some(c => c.title === ANCHOR), 'no card anywhere carries the anchor as its title');
ok(!cards.some(c => /Verified job/.test(c.title)), '"(Verified job)" is stripped from titles');

console.log('\n2. Fields land in the right columns');
eq(cards[0].loc, 'Chicago, IL (On-site)', 'location is the location line');
eq(cards[0].age, '5 hours ago', 'age comes off the "Posted N ago" line');
eq(cards[1].company, 'Salesforce', 'a salary line does not become the company');
ok(!cards.some(c => /^\$/.test(c.company)), 'no card has a salary as its company');

console.log('\n3. The bare trailing age line does not become the next title');
eq(cards[1].title, 'Data Engineer (Platform)- Small, Medium & Growth Business', 'card 2 title survives the bare "5 hours ago" above it');
eq(cards[2].title, 'Analytics Engineer', 'card 3 title survives too');
eq(cards[2].company, 'Example Labs', 'card 3 company parses');

console.log('\n4. A page with no anchor still parses (page 2 does not always carry it)');
const noAnchor = parseCards(PAGE.split('\n').slice(1).join('\n'));
eq(noAnchor.length, 3, 'all three cards parse without the anchor line present');
eq(noAnchor[0].title, 'Senior Data Engineer', 'first card is correct without the anchor');

console.log('\n5. Degenerate input never throws');
for (const [input, label] of [['', 'empty string'], [null, 'null'], [undefined, 'undefined'], ['\n\n\n', 'blank lines'], [ANCHOR, 'anchor only']]) {
  let threw = false, n = -1;
  try { n = parseCards(input).length; } catch { threw = true; }
  ok(!threw && n === 0, `${label} -> 0 cards, no throw`);
}

console.log('\n6. Chrome lines never become cards');
const chromeOnly = [ANCHOR, 'Promoted', 'Easy Apply', 'Viewed', 'Posted 3 hours ago'].join('\n');
eq(parseCards(chromeOnly).length, 0, 'a card made only of chrome is discarded, not emitted with junk fields');

// ── saved fixtures (scripts/fixtures/linkedin/) ─────────────────────────────
{
  const cards = parseCards(htmlToText(readFileSync(join(FIX, 'search-results-24h.html'), 'utf8')));
  eq(cards.length, 8, 'fixture page: 8 posted cards (the promoted "Apply" card has no Posted line)');
  eq(cards[0].title, 'Senior Data Engineer', 'fixture: first title, (Verified job) stripped');
  eq(cards[1].company, 'Example Labs', 'fixture: salary line never becomes the company');
  eq(cards[2].loc, 'United States (Remote)', 'fixture: remote location line parsed');
  ok(!/noise|<div>/.test(htmlToText('<script>var x="<div>noise</div>";</script><div>a</div>')), 'htmlToText drops <script> bodies');
  eq(parseCards(htmlToText(readFileSync(join(FIX, 'search-results-empty.html'), 'utf8'))).length, 0, 'empty fixture: 0 cards');
  eq(parseCards(htmlToText(readFileSync(join(FIX, 'authwall.html'), 'utf8'))).length, 0, 'authwall fixture: 0 cards');
  const env = { ...process.env, CAREER_FINDER_PROFILE: process.env.CAREER_FINDER_PROFILE || join(REPO, 'scripts/fixtures/profile.test.yml') };
  const run = (script, extra) => execFileSync('node', [join(REPO, 'scripts', script), ...extra], { encoding: 'utf8', cwd: REPO, env, timeout: 30000 });
  const crawl = JSON.parse(run('linkedin-crawl.mjs', ['--fixture', join(FIX, 'search-results-24h.html')]).split('\n').find(l => l.startsWith('JSON ')).slice(5));
  const kept = crawl.kept.map(c => c.company).sort().join(',');
  eq(kept, 'Acme Robotics,Example Labs,Northwind Analytics,Tailspin Toys', 'crawl --fixture keeps local + remote-country target titles only');
  ok(crawl.rejects.some(r => r.company === 'Insight Global' && r.rule === 'staffing-agency-or-shell'), 'crawl --fixture drops the staffing agency');
  ok(crawl.rejects.some(r => r.company === 'Fabrikam' && r.rule === 'not-local-area'), 'crawl --fixture drops the out-of-area card');
  const js = JSON.parse(run('linkedin-jobsearch.mjs', ['--fixture', join(FIX, 'search-results-24h.html'), '--json']).split('\n').find(l => l.startsWith('JSON ')).slice(5));
  eq(js.nominated.map(c => c.company).sort().join(','), kept, 'jobsearch --fixture nominates the same four as the crawl');
  const urls = JSON.parse(run('linkedin-jobsearch.mjs', ['--urls']));
  ok(urls.length > 0 && urls.every(u => /f_TPR=r86400/.test(u.url)), 'every jobsearch URL carries the 24h facet');
  ok(urls.some(u => u.geo === 'remote' && /f_WT=2/.test(u.url)), 'remote-country profile adds an f_WT=2 search');
  ok(new Set(urls.map(u => u.q)).size <= 4, 'at most 4 roles searched');
  const curls = JSON.parse(run('linkedin-crawl.mjs', ['--urls']));
  ok(curls.every(u => /f_TPR=r86400/.test(u.url) && /sortBy=DD/.test(u.url)), 'every crawl URL is 24h + newest-first');
}

console.log('\nX. Cross-process nomination dedup + /jobs/view/<id> URLs');
{
  const lp = await import('./linkedin-parse.mjs');
  eq(lp.roleKey('Acme Robotics', 'Senior Data Engineer (Verified job)'), lp.roleKey('acme robotics', 'Senior  Data-Engineer'), 'roleKey normalises case, punctuation, (Verified job)');
  eq(lp.jobIdFromUrl('https://www.linkedin.com/jobs/view/4100000001/?refId=x'), '4100000001', 'jobIdFromUrl: /jobs/view/<id>');
  eq(lp.jobIdFromUrl('https://www.linkedin.com/jobs/search-results/?currentJobId=4100000002'), '4100000002', 'jobIdFromUrl: currentJobId');
  const prior = lp.existingWebRoleKeys('date\tcompany\trole\tlocation\tposted\turl\tsource\n2026-10-04\tExample Labs\tAnalytics Engineer\tChicago\tx\thttps://www.linkedin.com/jobs/view/4199999999/\tlinkedin-loggedin\n');
  ok(prior.keys.has(lp.roleKey('Example Labs', 'analytics engineer')) && prior.ids.has('4199999999'), 'existingWebRoleKeys reads company+title and job ids, skips the header');
  const html = readFileSync(join(FIX, 'search-results-24h.html'), 'utf8');
  const cards = lp.attachJobIds(parseCards(htmlToText(html)), lp.extractJobLinks(html));
  eq(cards.find(c => c.company === 'Acme Robotics')?.id, '4100000001', 'card gets its job id from the matching /jobs/view link');
  const env = { ...process.env, CAREER_FINDER_PROFILE: process.env.CAREER_FINDER_PROFILE || join(REPO, 'scripts/fixtures/profile.test.yml') };
  const { mkdtempSync, writeFileSync: wf } = await import('fs');
  const tmp = join(mkdtempSync(join((await import('os')).tmpdir(), 'cf-webroles-')), '_web-roles.tsv');
  wf(tmp, 'date\tcompany\trole\tlocation\tposted\turl\tsource\n2026-10-04\tExample Labs\tAnalytics Engineer\tChicago, IL\tlinkedin-claim:5 hours ago\thttps://x\tlinkedin-loggedin\n2026-10-04\tSomeone Else\tOther\tChicago, IL\tx\thttps://www.linkedin.com/jobs/view/4100000001/\tlinkedin-loggedin\n');
  const out = execFileSync('node', [join(REPO, 'scripts/linkedin-jobsearch.mjs'), '--fixture', join(FIX, 'search-results-24h.html'), '--json'], { encoding: 'utf8', cwd: REPO, env: { ...env, CAREER_FINDER_WEB_ROLES: tmp }, timeout: 30000 });
  const js2 = JSON.parse(out.split('\n').find(l => l.startsWith('JSON ')).slice(5));
  ok(!js2.nominated.some(c => c.company === 'Example Labs'), 'a role already in _web-roles.tsv (written by the other form) is not re-nominated');
  ok(!js2.nominated.some(c => c.company === 'Acme Robotics'), 'a card whose LinkedIn job id is already in _web-roles.tsv is not re-nominated');
  ok((js2.rejected['already nominated'] || 0) === 2, 'both counted as "already nominated"');
  const js3 = JSON.parse(execFileSync('node', [join(REPO, 'scripts/linkedin-jobsearch.mjs'), '--fixture', join(FIX, 'search-results-24h.html'), '--json'], { encoding: 'utf8', cwd: REPO, env: { ...env, CAREER_FINDER_WEB_ROLES: tmp + '.none' }, timeout: 30000 }).split('\n').find(l => l.startsWith('JSON ')).slice(5));
  eq(js3.nominated.find(c => c.company === 'Acme Robotics')?.id, '4100000001', 'nomination carries the id (row URL becomes /jobs/view/<id>)');
  const src = readFileSync(join(REPO, 'scripts/linkedin-jobsearch.mjs'), 'utf8');
  ok(/c\.id \? jobViewUrl\(c\.id\)/.test(src), 'jobsearch writes /jobs/view/<id> as the row URL when the card has an id');
  const urls = JSON.parse(execFileSync('node', [join(REPO, 'scripts/linkedin-jobsearch.mjs'), '--urls'], { encoding: 'utf8', cwd: REPO, env, timeout: 30000 }));
  const roles = new Set(urls.map(u => u.q)).size;
  eq(urls.filter(u => u.geo === 'local').length, roles * 2, 'faceted + semantic both run on the LOCAL geo, once per role');
  eq(urls.filter(u => u.geo === 'remote').length, roles, 'exactly ONE remote search per role');
  ok(urls.filter(u => u.geo === 'remote').every(u => u.form === 'faceted' && /f_WT=2/.test(u.url)), '...and it is the faceted form with f_WT=2');
  const curls = JSON.parse(execFileSync('node', [join(REPO, 'scripts/linkedin-crawl.mjs'), '--urls'], { encoding: 'utf8', cwd: REPO, env, timeout: 30000 }));
  ok(curls.every(u => u.geo === 'local'), 'the crawl searches the local geo only (remote is not crossed with every form)');
}

console.log('\n' + '='.repeat(52));
console.log(`📊 ${pass} passed, ${fail} failed`);
if (fail) { console.log('🔴 The LinkedIn parser is broken — the crawl will silently lose cards.'); process.exit(1); }
console.log('🟢 LinkedIn results parser verified (offline).');
