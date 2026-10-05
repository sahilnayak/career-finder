#!/usr/bin/env node

/**
 * test-hiringcafe.mjs — offline guards for the discovery lanes (HiringCafe, LinkedIn job search,
 * Workable, YC, browser boards), the config-driven title/location filters, and the morning-run
 * plumbing that has failed silently before.
 *
 * WHAT THIS PROTECTS. Failure classes that are silent: a dead lane and a quiet market look
 * identical from the board.
 *   1. A lane that exists but is not WIRED into the morning run (scripts/morning.mjs; the
 *      scripts/pipeline-cron.sh shell entry point is a thin wrapper around it).
 *   2. A search that quietly narrows, or that searches a hard-coded role/geography instead of
 *      the one in config/profile.yml.
 *   3. Schema / ordering invariants other scripts depend on.
 *
 * Everything here is offline and deterministic. It runs against the FIXTURE profile
 * (scripts/fixtures/profile.test.yml), never the user's config, so it passes before onboarding.
 *
 *   node scripts/test-hiringcafe.mjs
 */

import './fixtures/use-test-profile.mjs'; // must stay first: pins targets.mjs to the fixture profile
import { readFileSync, existsSync } from 'fs';
import {
  SEARCH_KEYWORDS, titleDropped, titleMatches, isPrimaryRole, locationMatches, classifyLocation,
  REMOTE, loadNoise, loadNeverApply, loadTargets,
} from './role-filters.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  ✅ ${msg}`); pass++; } else { console.log(`  ❌ ${msg}`); fail++; } };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const T = loadTargets();
// The morning run lives in morning.mjs; pipeline-cron.sh is a wrapper that must exec it.
const wrapper = read('scripts/pipeline-cron.sh');
const cron = read('scripts/morning.mjs');
const lane = read('scripts/hiringcafe-scan.mjs');
const lij = read('scripts/linkedin-jobsearch.mjs');

console.log('\n1. The lanes are wired into the morning run');
ok(/scripts\/morning\.mjs/.test(wrapper), 'pipeline-cron.sh execs scripts/morning.mjs');
ok(/scripts\/hiringcafe-scan\.mjs/.test(cron), 'morning.mjs runs hiringcafe-scan.mjs');
ok(cron.indexOf('scripts/hiringcafe-scan.mjs') > -1 && cron.indexOf('scripts/hiringcafe-scan.mjs') < cron.indexOf("'web-roles:clean'"),
  'the lane runs BEFORE web-roles.mjs --clean, so its rows pass the guardrail');
ok(/scripts\/linkedin-jobsearch\.mjs/.test(cron), 'morning.mjs runs linkedin-jobsearch.mjs');
ok(/searchKeywords\(\)/.test(cron) && !/--keywords',\s*'[a-z]/i.test(cron),
  'morning.mjs derives LinkedIn keywords from config, never a literal list');

console.log('\n2. Searched titles come from config, not from the code');
ok(JSON.stringify([...SEARCH_KEYWORDS]) === JSON.stringify(T.targets.roles.map((r) => r.toLowerCase())),
  `SEARCH_KEYWORDS = targets.roles (${SEARCH_KEYWORDS.join(', ')})`);
ok(/SEARCH_KEYWORDS/.test(lane), 'hiringcafe-scan.mjs reads SEARCH_KEYWORDS rather than a hard-coded list');
ok(!/loadTargets\(\)\.targets\.title_keywords/.test(lane), 'hiringcafe-scan.mjs searches targets.roles only, never title_keywords');
ok(/MAX_QUERIES = 6/.test(lane) && /toLowerCase\(\)/.test(lane), 'queries are deduped case-insensitively and capped at 6');
ok(/Retry-After|retry-after/.test(lane) && /\[15, 30, 60\]/.test(lane), '429 honours Retry-After, else backs off 15/30/60s');
ok(/hiringcafe rate-limited \(HTTP 429\) — try again later/.test(lane), 'circuit breaker prints a clear rate-limit reason');
ok(/TG\.yoeTooHigh/.test(lane) && !/function yoeVerdict/.test(lane), 'tenure drop uses TG.yoeTooHigh, not a local copy');
for (const [f, src] of [['hiringcafe-scan.mjs', lane], ['linkedin-jobsearch.mjs', lij]]) {
  ok(!/(sales|solutions) engineer|forward deployed|deployment strategist/i.test(stripComments(src)),
    `${f} carries no hard-coded role title`);
}

console.log('\n3. Search geography comes from config/profile.yml location');
ok(/\.lat\b/.test(lane) && /\.lng\b/.test(lane) && /radius_mi/.test(lane),
  'HiringCafe centre/radius come from location.lat / lng / radius_mi');
ok(/linkedin_geo_id/.test(lij) || (/from '\.\/li-geo\.mjs'/.test(lij) && /linkedin_geo_id/.test(readFileSync(new URL('./li-geo.mjs', import.meta.url), 'utf8'))), 'LinkedIn geo facet comes from location.linkedin_geo_id (via li-geo.mjs)');
for (const [f, src] of [['hiringcafe-scan.mjs', lane], ['linkedin-jobsearch.mjs', lij]]) {
  ok(!/95070|Saratoga|Bay Area|San Francisco|90000084|102095887/i.test(stripComments(src)),
    `${f} carries no hard-coded metro / postal code / geoId`);
}

console.log('\n4. Aggregator dates are treated as claims, never as publish dates');
ok(/hiringcafe-claim:/.test(lane), 'rows are tagged hiringcafe-claim: so the scorer resolves the real ATS date');
ok(/_hiringcafe\.tsv[\s\S]{0,200}never as the verdict/.test(cron),
  'the scoring prompt treats HiringCafe fields as a starting point, never the verdict');
ok(/Age is NOT a scoring penalty/.test(cron) && /real ATS publish date/.test(cron),
  'the scoring prompt resolves the real ATS date and does not penalise age');
ok(!/estimated_publish_date[^\n]*posted\b(?![^\n]*claim)/.test(lane),
  'estimated_publish_date is never written as a bare posted date');

console.log('\n5. The hard filters the lane must not lose');
for (const needle of ['is_expired', 'position_employer_type', 'loadNoise', 'titleDropped',
                      'workplaceAllowed', 'number_of_workplace_countries', 'dealbreakerHit']) {
  ok(lane.includes(needle), `filter retained: ${needle}`);
}
ok(!/; Remote`/.test(lane), 'structured workplace_type is used, no "; Remote" spliced into the location');
ok(/role_type === 'People Manager' && !INCLUDE_MGMT/.test(lane), 'People Manager is dropped only when include_management is false');
ok(/STRETCH/.test(lane) && /max_yoe_over/.test(lane), 'tenure gate marks STRETCH and drops beyond max_yoe_over');
ok(/hiringcafe_days/.test(lane), 'default window comes from pipeline.hiringcafe_days');
ok(/collectWithRetry/.test(lane) && /process\.exit\(3\)/.test(lane), 'failed queries are retried, then reported with exit 3');
ok(/seenRoles/.test(lane), 'dedup by company + normalized title');
ok(!/nonBay/.test(lane), 'no Bay-specific counter names');
ok(/--help/.test(lane), '--help is supported');

console.log('\n6. Title semantics (fixture profile)');
ok(titleMatches('Senior Data Engineer'), 'a target role title matches');
ok(titleMatches('ETL Engineer II'), 'a title_keywords phrase matches');
ok(!titleMatches('Senior Software Engineer'), 'an unrelated title does not match');
ok(titleDropped('Director, Data Engineering'), 'a "!" hard negative drops even with a positive present');
ok(!titleDropped('Data Engineer, Sales Analytics'), 'a plain negative is neutralised by a positive');
ok(titleDropped('Sales Manager'), 'a plain negative drops a title with no positive');
ok(isPrimaryRole('Data Engineer II') && !isPrimaryRole('Analytics Engineer'), 'isPrimaryRole follows targets.primary_role');

console.log('\n7. Location semantics (fixture profile: Chicago, remote-country, US)');
ok(classifyLocation('Chicago, IL') === 'local', 'the configured city is local');
ok(classifyLocation('Evanston, Illinois, United States') === 'local', 'a configured nearby city is local');
ok(classifyLocation('Austin, Texas, United States') === 'elsewhere', 'another metro is elsewhere');
ok(locationMatches('Tokyo or Chicago or Dublin'), 'a multi-place string passes if any place passes');
ok(REMOTE.test('Remote - US'), 'REMOTE catches an explicit remote location');
ok(locationMatches('Remote - US'), 'remote-country accepts a US remote posting');
ok(!locationMatches('Remote - EMEA'), 'remote-country rejects a foreign remote region');
ok(!locationMatches('Hybrid'), 'an unknown location never passes');

console.log('\n8. LinkedIn search forms and budgets');
ok(/f_TPR=r86400/.test(lij), 'faceted form (geoId + f_TPR=r86400) retained');
ok(/SEMANTIC_SEARCH_LANDING_PAGE/.test(lij), 'semantic form retained');
ok(/spendSearchBudget/.test(lij), 'every query spends the shared LinkedIn search budget');
ok(/LINKEDIN_OFF/.test(lij), 'the LinkedIn kill-switch is honoured');
ok(/'budget', 'jobsearch'|(?:spend|claim)\('jobsearch'/.test(lij) && !/'budget', 'search'|(?:spend|claim)\('search'/.test(lij),
  'linkedin-jobsearch bills the job counter, not the people-search counter');

console.log('\n9. The lane never calls an LLM; a browser is a last-resort fallback only');
const code = stripComments(lane);
ok(!/claude\s+-p/.test(code), 'no LLM call inside the lane');
ok(/fetchViaPlainHttp/.test(code) && /fetchViaBrowser/.test(code), 'a plain HTTP GET is attempted before any browser fallback');
ok(/try\s*{\s*html = await fetchViaPlainHttp/.test(lane) && /catch\s*(\(\w+\)\s*)?{\s*try\s*{\s*html = await fetchViaBrowser/.test(lane),
  'the browser path only runs when the plain GET throws');
ok(!/chrome-devtools|playwright/i.test(code), 'no chrome-devtools MCP or Playwright in the lane');
ok(/cdp\.mjs/.test(lane), 'the CDP fallback uses the zero-dependency cdp.mjs client');

console.log('\n10. The ATS date is not a freshness gate on nomination lanes');
const crawl = read('scripts/linkedin-crawl.mjs');
const alerts = read('scripts/linkedin-email-alerts.mjs');
ok(!/if\s*\(ageH\s*<=\s*ATS_HOURS\)/.test(crawl), 'linkedin-crawl: verify block does not branch on ageH <= ATS_HOURS');
ok(!/if\s*\(!\(t4Age\s*<=\s*ATS_HOURS\)\)/.test(crawl), 'linkedin-crawl: no tier-4 careers-page age reject');
ok(!/if\s*\(!\(ageH\s*<=\s*ATS_HOURS\)\)/.test(crawl), 'linkedin-crawl: no tier-3 apply-href age reject');
ok(!/if\s*\(!\(ageH\s*<=\s*MAX_AGE_H\)\)/.test(alerts), 'linkedin-email-alerts: no age gate');
ok(/verified\.push\(t4Row\)/.test(crawl), 'linkedin-crawl: tier-4 rescues reach `verified`');

console.log('\n11. The never-apply list is enforced everywhere loadNoise() is');
const filters = read('scripts/role-filters.mjs');
const noise = loadNoise();
ok(/_never-apply\.txt/.test(filters), 'loadNoise() reads data/_never-apply.txt');
ok(loadNeverApply().every((n) => noise.includes(n)), 'every never-apply entry is present in loadNoise()');
ok(!noise.some((n) => 'stripe'.includes(n)), 'the noise list does not over-match a normal employer');
{
  const na = read('data/_never-apply.txt');
  const lines = na.split('\n').map((l) => l.trim()).filter(Boolean);
  ok(lines.length > 0 && lines.every((l) => l.startsWith('#') || !/\t/.test(l)),
    'data/_never-apply.txt is a plain list of names (optional # comment header)');
}

console.log('\n12. Outreach config is read from the profile, not hard-coded');
const gen = read('scripts/gen-outreach.mjs');
ok(/outreach/.test(gen) && /(loadTargets|default_bullets|DEFAULT_BULLETS)/.test(gen),
  'gen-outreach reads the outreach block (bridge / default_bullets) from config');
ok(!/Productboard|Versa|BuzzHero/.test(gen), 'gen-outreach carries no candidate-specific employer');
ok(Array.isArray(T.outreach.default_bullets), 'outreach.default_bullets resolves to a list');
ok(!T.outreach.default_bullets.some((b) => /—/.test(b)) && !/—/.test(T.outreach.bridge),
  'no em dash in the fixture bridge or bullets (house style: the generator flags them)');

console.log('\n13. scored-jobs.tsv schema: the col-10 collision guard');
// prune-board treats a NON-EMPTY col 10 as "already dismissed". Cols 10-11 belong to it.
const sjHeader = read('data/scored-jobs.tsv').split('\n')[0].split('\t');
const pruneSrc = read('scripts/prune-board.mjs');
ok(sjHeader[9] === 'dismissed_at', `scored-jobs col 10 is dismissed_at (got "${sjHeader[9]}")`);
ok(sjHeader[10] === 'aged', `scored-jobs col 11 is aged (got "${sjHeader[10]}")`);
ok(sjHeader[11] === 'source', `scored-jobs col 12 is source (got "${sjHeader[11]}")`);
ok(/f\[9\]\s*=\s*stamp/.test(pruneSrc) && /f\[10\]\s*=\s*'aged'/.test(pruneSrc), 'prune-board still owns cols 10-11');
ok(/foundAt, '', '', '', source/.test(read('scripts/record-scored.mjs')),
  'record-scored pads dismissed_at/aged empty and writes source last');

console.log('\n14. Workable cross-employer lane');
const wk = read('scripts/workable-search.mjs');
ok(/jobs\.workable\.com\/api\/v1\/jobs/.test(wk), 'workable lane targets the public jobs API');
ok(/workable-search\.mjs/.test(cron), 'the workable lane is wired into the morning run');
ok(/TITLE_KEEP\.test\(title\)|titleMatches\(title\)/.test(wk), 'workable lane applies the positive title gate');
ok(/NOISE\.some\(|loadNoise/.test(wk), 'workable lane filters the noise blocklist');
ok(/seenReqs/.test(wk), 'workable lane dedups the same req across cities');
ok(/robots/i.test(wk), 'workable lane records its robots.txt position');

console.log('\n15. YC discovery lane');
const dc = read('scripts/discover-companies.mjs');
ok(dc.includes('X-Algolia-API-Key'), 'YC lane sends the Algolia auth headers');
ok(dc.includes('window.AlgoliaOpts'), 'YC lane scrapes the public key at run time');
ok(dc.includes('isHiring:true'), 'YC lane filters to hiring companies only');
ok(dc.includes('ATS_LINK'), 'YC lane only emits companies whose real ATS board resolved');
ok(dc.includes('_yc-probed.txt'), 'YC lane keeps a cursor so each run advances');
ok(cron.includes('discover-companies.mjs'), 'the company-discovery lane is wired into the morning run');

console.log('\n16. Browser-rendered board lane');
const bb = read('scripts/browser-boards.mjs');
ok(bb.includes('cdp.mjs'), 'browser-boards drives the raw CDP client, not Playwright');
ok(!/linkedin\.com/i.test(bb), 'browser-boards contains no LinkedIn URL');
ok(!/linkedin|li-budget/i.test(bb.split('\n').filter((l) => /^\s*import\s/.test(l)).join('\n')),
  'browser-boards imports no LinkedIn budget or crawl module');
ok(bb.includes("querySelectorAll('button')") && !/load more\|show more\|next/.test(bb),
  'the load-more click is buttons-only and never matches "next"');
ok(bb.includes('retrying unfiltered'), 'an empty location-filtered board falls back to unfiltered');
ok(/TITLE_KEEP\.test\(title\)|titleMatches\(title\)/.test(bb), 'browser-boards applies the positive title gate');
ok(cron.indexOf('linkedin-jobsearch.mjs') > -1 && cron.indexOf('linkedin-jobsearch.mjs') < cron.indexOf('browser-boards.mjs'),
  'browser-boards runs after the LinkedIn lane, not concurrently (one shared Chrome)');

console.log('\n17. Nomination resolution and Workday pagination');
const sc = read('scripts/scan-core.mjs');
const rn = read('scripts/resolve-nominations.mjs');
const scCode = sc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok(!/const total = data\.total \?\?/.test(scCode), 'fetchWorkday does not trust a later-page total of 0');
ok(sc.includes('if (data.total) total = data.total;'), 'fetchWorkday keeps the first non-zero total');
ok(!rn.includes('for (const tok of line.split'), 'the resolver no longer scrapes every cell for an http prefix');
ok(rn.includes('hit.offices'), 'the location gate reads offices[] as well as location');
ok(/resolve-nominations\.mjs/.test(cron), 'the zero-LLM nomination resolver is wired into the morning run');

console.log('\n18. Pipeline digest');
const dig = read('scripts/pipeline-digest.mjs');
ok(!/claude -p/.test(dig), 'the digest spends no LLM tokens');
ok(dig.includes('const localDay'), 'the digest computes local dates');
ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(dig), 'no UTC date used as today');
ok(dig.includes('ranToday'), 'the digest checks for an actual start line per cron');
ok(cron.includes('pipeline-digest.mjs'), 'the digest is wired into the morning run');
const exitIdx = cron.lastIndexOf('process.exit(3)');
ok(exitIdx !== -1 && cron.lastIndexOf('pipeline-digest.mjs') < exitIdx,
  'the digest runs BEFORE the quota-deferred exit, so it reports on broken days too');

console.log('\n19. Pausing: master switch');
ok(/existsSync\('data\/PIPELINE_OFF'\)/.test(cron), 'morning.mjs hard-checks data/PIPELINE_OFF');
{
  const code = stripComments(cron);
  const lockAt = code.indexOf('mkdirSync(LOCK)');
  const offAt = code.indexOf("existsSync('data/PIPELINE_OFF')");
  ok(offAt > -1 && lockAt > -1 && offAt < lockAt, 'the master pause is checked BEFORE the lock is taken');
}
ok(/PIPELINE IS PAUSED/.test(dig) && /pausedDays/.test(dig), 'the digest banners an active pause with a day count');
{
  const swCode = stripComments(read('scripts/pipeline.mjs'));
  ok(/const localDay/.test(swCode) && !/toISOString/.test(swCode), 'the on/off switch stamps a LOCAL date');
}

{
  console.log('\n30. morning: a short quota is a QUOTA line, not a FAILED lane');
  const { splitFailures, quotaLine } = await import('./morning-summary.mjs');
  const res = [['scan-index', 'ok', ''], ['quota:report', 'exit 1', 'short'], ['linkedin:crawl:x', 'exit 2', 'logged out']];
  const sf = splitFailures(res);
  ok(sf.quotaShort && sf.failed.length === 1 && sf.failed[0][0] === 'linkedin:crawl:x', 'quota:report exit 1 -> quotaShort, not in FAILED LANES');
  ok(splitFailures([['quota:report', 'exit 2', 'crash']]).failed.length === 1, 'a quota script CRASH (exit 2) is still a failed lane');
  ok(/^QUOTA: quota short/.test(quotaLine({ met: false, total: 1, minCount: 3, primary: 0, primaryQuota: 1 }, true)), 'QUOTA line says "quota short"');
  const mj = readFileSync(new URL('./morning.mjs', import.meta.url), 'utf8');
  ok(/splitFailures\(results\)/.test(mj) && !/results\.filter\(\(\[, st\]\) => \/\^exit \//.test(mj), 'morning.mjs builds FAILED LANES via splitFailures');
  ok(/claude\('reports'[\s\S]{0,4000}batch\/tracker-additions\/[\s\S]{0,400}merge-tracker\.mjs/.test(mj) && mj.indexOf("node('merge-tracker'") > mj.indexOf("claude('reports'"), 'reports prompt writes one tracker TSV per report, and merge-tracker runs after');

  console.log('\n31. verify-pipeline: report filenames + tracker coverage');
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawnSync } = await import('child_process');
  const root = mkdtempSync(join(tmpdir(), 'cf-verify-'));
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'reports')); mkdirSync(join(root, 'templates'));
  cpSync(new URL('../templates/states.yml', import.meta.url), join(root, 'templates/states.yml'));
  writeFileSync(join(root, 'data/applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-10-04 | Acme | SE | 4.5/5 | Evaluated | ❌ | [001](reports/001-acme-2026-10-04.md) | x |\n');
  const rep = '# r\n**URL:** https://x\n**Legitimacy:** High\n';
  writeFileSync(join(root, 'reports/001-acme-2026-10-04.md'), rep);
  const vp = () => spawnSync('node', [new URL('./verify-pipeline.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, CAREER_FINDER_ROOT: root } });
  let r = vp();
  ok(r.status === 0, 'well-formed report name + tracker row: clean');
  writeFileSync(join(root, 'reports/acme-report.md'), rep);
  r = vp();
  ok(r.status === 1 && /filename does not match/.test(r.stdout), 'a report named outside NNN-slug-YYYY-MM-DD.md is an ERROR');
  const { rmSync } = await import('fs'); rmSync(join(root, 'reports/acme-report.md'));
  writeFileSync(join(root, 'reports/002-beta-se-2026-10-04.md'), rep);
  r = vp();
  ok(/002-beta-se-2026-10-04\.md has no tracker row/.test(r.stdout), 'a report with no tracker row or pending TSV is flagged');

  console.log('\n32. li-geo resolve writes location.linkedin_geo_id with a one-line edit');
  const { setProfileGeoId } = await import('./li-geo.mjs');
  const y = '# top comment\nlocation:\n  city: Chicago      # city\n  linkedin_geo_id: ""   # set by resolve\n  state: IL\npipeline:\n  daily_quota: 3\n';
  const w = setProfileGeoId(y, '103112676');
  ok(w.changed && w.text === y.replace('linkedin_geo_id: ""   # set by resolve', 'linkedin_geo_id: "103112676"   # set by resolve'), 'fills the empty line in place, keeps its comment and every other line');
  ok(!setProfileGeoId(w.text, '1').changed, 'never overwrites a set id');
  const ins = setProfileGeoId('location:\n  city: X   # c\nfoo: 1\n', '9');
  ok(ins.changed && ins.text.split('\n')[1].startsWith('  linkedin_geo_id: "9"') && ins.text.includes('city: X   # c'), 'inserts under location: when the key is absent');
  ok(/setProfileGeoId\(readFileSync\(PROFILE_PATH/.test(readFileSync(new URL('./li-geo.mjs', import.meta.url), 'utf8')), 'resolve CLI writes the profile');
}

console.log('\n' + '='.repeat(52));
console.log(`📊 ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('🔴 A discovery lane or pipeline invariant is broken — the morning run may silently search less than it claims.');
  process.exit(1);
}
console.log('🟢 Discovery lanes + config-driven filters verified (offline).');
