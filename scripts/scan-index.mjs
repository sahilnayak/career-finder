#!/usr/bin/env node

/**
 * scan-index.mjs — Zero-token sweep of data/company-index.tsv.
 *
 * For every indexed company with an ATS API, fetch in parallel, parse, and keep
 * roles that pass: title filter (portals.yml, seniority-negatives dropped; profile hard negatives always apply),
 * location (config/profile.yml location block + remote_policy), recency (--days N, default pipeline.scan_window_days), and dedup vs
 * scan-history / pipeline / applications. Updates last_scanned per company.
 *
 * Usage:  node scripts/scan-index.mjs [--days N | --hours H] [--primary-only] [--only file] [--out file (default data/_candidates-new.tsv)] [--dry-run]
 *
 * The index starts empty. Seed it for any role + metro with
 *   node scripts/discover-companies.mjs   (then build-company-index.mjs)
 */

import { remoteOkFor, loadNoise, loadNeverApply, requireTargets, isPrimaryRole, titleMatches, areaLabel } from './role-filters.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { hardNegativeRegex } from './targets.mjs';
import yaml from 'js-yaml';
import {
  detectApi, fetchProvider, PARSERS, buildTitleFilter, buildLocationVerdict,
  loadSeenUrls, loadSeenCompanyRoles, dedupUrlKey, makeRecencyPredicate, makeHoursPredicate, firstSeen, firstSeenKnown, parallelFetch, taskHost,
  localTimeStr, dateOnly, scanWindowDays, dealbreakerHit, coverageWarning, parseOnlyList,
  localDateStr, ledgerGet, ledgerPut, ledgerFlush, windowStartFor, workdayAgeDays, scanStats, ATS_MAX_JOBS,
} from './scan-core.mjs';
import { deadLaneFatal, isTimeoutError } from './lib/health.mjs';
import { labelFreshness, newTally, tally, formatTally, DAY_LEVEL_FAMILIES } from './lib/freshness.mjs';
import { summary as requestSummary, fmtStatuses } from './request-ledger.mjs';
import { detectFamily } from './probe-ats-core.mjs';
import { ROOT, ensureSeedIndex, loadRegistries, registryScanRows } from './lib/index-tsv.mjs';

const INDEX_PATH = 'data/company-index.tsv';
const PORTALS_PATH = 'portals.yml';
const TODAY = new Date().toISOString().slice(0, 10);

const DEFAULT_OUT = 'data/_candidates-new.tsv';
// A board whose job count lands exactly on one of these is probably a truncated list (a page size or a
// hard cap somewhere), not a coincidence. Warned per board; never fatal (a real board can hold 20 jobs).
export const ROUND_CAPS = [20, 40, 200, ATS_MAX_JOBS];
const USAGE = `Usage: node scripts/scan-index.mjs [options]
  --days N            recency window in days (default pipeline.scan_window_days)
  --hours H           rolling window in hours (overrides --days)
  --primary-only      only the primary target role
  --only FILE         restrict to companies named in FILE's first column
  --browser-queue F   write non-ATS companies to F
  --out FILE          candidates TSV (default ${DEFAULT_OUT})
  --dry-run           do not update last_scanned in the index
  -h, --help          show this help`;

function parseDays(argv) { const i = argv.indexOf('--days'); if (i === -1) return scanWindowDays(); const n = parseInt(argv[i + 1], 10); return Number.isFinite(n) && n > 0 ? n : scanWindowDays(); }

function loadIndex() {
  const text = readFileSync(INDEX_PATH, 'utf-8').split('\n');
  const header = text[0].split('\t');
  const rows = text.slice(1).filter(Boolean).map(line => {
    const c = line.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, c[i] ?? '']));
  });
  return { header, rows };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return; }
  requireTargets();
  const dryRun = argv.includes('--dry-run');
  const days = parseDays(argv);
  const hoursIdx = argv.indexOf('--hours');
  const hours = hoursIdx !== -1 ? parseFloat(argv[hoursIdx + 1]) : null;

  // Fresh install: restore the bundled starter index (offline) before declaring the index missing.
  const seeded = ensureSeedIndex({ root: process.cwd(), index: INDEX_PATH, seedRoot: ROOT });
  if (seeded.restored) console.log(`Company index was missing/empty: restored the bundled starter (${seeded.rows} boards).`);
  if (!existsSync(INDEX_PATH)) { console.error('No company-index.tsv. Seed it with discover-companies.mjs / build-company-index.mjs first.'); process.exit(1); }
  const portals = existsSync(PORTALS_PATH) ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}) : {};
  // --primary-only: restrict the sweep to the PRIMARY target role (targets.primary_role in
  // config/profile.yml) so a wider --days window can be used without drowning in adjacent
  // titles. The qualify bar (pipeline.qualify_score) is unchanged — this widens the SEARCH only.
  const PRIMARY_ONLY = argv.includes('--primary-only');
  // Leading 'Manager,'/'Director,' = a people-leadership req unless the target itself says so.
  const PRIMARY_DROP = /\b(intern|internship)\b/i;
  const baseTitleFilter = buildTitleFilter(portals.title_filter, { dropSeniorityNegatives: true });
  // dropSeniorityNegatives relaxes portals.yml negatives only; the profile's hard ("!") negatives always apply.
  const hardNeg = hardNegativeRegex();
  const titleFilter = PRIMARY_ONLY
    ? (t => isPrimaryRole(String(t || '')) && titleMatches(String(t || '')) && !PRIMARY_DROP.test(String(t || '')))
    : (t => baseTitleFilter(t) && !hardNeg.test(String(t || '')));
  const locVerdict = buildLocationVerdict();
  // Every lane that names an employer must filter through the shared blocklists
  // (feedback_lanes_must_share_noise_blocklist). scan-index never did, so a staffing
  // marketplace already blocked everywhere else — Clera — kept surfacing from the index.
  const noise = loadNoise();
  const neverApply = (typeof loadNeverApply === 'function' ? loadNeverApply() : []);
  const blocked = (co) => {
    const c = String(co || '').toLowerCase();
    return noise.some(n => c.includes(n)) || neverApply.some(n => c.includes(n));
  };
  const isRecent = hours ? makeHoursPredicate(hours) : makeRecencyPredicate(days);
  const windowLabel = (hours ? `last ${hours}h` : `last ${days}d`) + (PRIMARY_ONLY ? ', primary role ONLY' : '');
  const seenUrls = loadSeenUrls();
  const seenRoles = loadSeenCompanyRoles();

  const { rows } = loadIndex();
  let scannable = rows.filter(r => r.ats_api_url);
  const indexBoards = scannable.length;
  // Sector registries (data/registries/*.tsv): hand-verified boards swept in addition to the index.
  // Only status=verified rows; a registry board already in the index is skipped (index wins).
  const registryRows = registryScanRows(loadRegistries(), rows);
  scannable = scannable.concat(registryRows);
  const registryUrls = new Set(registryRows.map(r => r.careers_url));
  // An empty or header-only index (and no registry boards) used to sweep 0 companies, print a clean
  // summary and exit 0: a cron saw "success" while discovering nothing. Fail loudly instead.
  if (!scannable.length) {
    console.error('FATAL: the company index has no scannable boards '
      + `(${rows.length} index row(s), ${indexBoards} with an ATS API, ${registryRows.length} verified registry board(s)). `
      + 'Nothing was swept. Restore the bundled starter (templates/company-index.starter.tsv) by deleting the empty index file, or run '
      + '`node scripts/discover-companies.mjs` then `node scripts/build-company-index.mjs`.');
    process.exit(1);
  }
  if (registryRows.length) console.log(`Registries: +${registryRows.length} verified boards (${[...new Set(registryRows.map(r => r.source.replace('registry:', '')))].join(', ')})`);

  // --only <file>: restrict the sweep to the companies named in a TSV's first column
  // (see hot-list.mjs). This is what makes a 5-minute tier viable — polling 1,339
  // boards that often would be both slow and rude, while ~74 evidence-selected boards
  // finish in seconds. Names are matched case-insensitively against column 1.
  const onlyIdx = argv.indexOf('--only');
  if (onlyIdx !== -1 && argv[onlyIdx + 1]) {
    // Header or not, detected by a `company` token in line 1 (see parseOnlyList).
    const want = parseOnlyList(readFileSync(argv[onlyIdx + 1], 'utf-8'));
    const before = scannable.length;
    scannable = scannable.filter(r => want.has((r.company || '').toLowerCase().trim()));
    console.log(`--only ${argv[onlyIdx + 1]}: ${scannable.length} of ${before} boards selected`);
  }

  // Optional: emit non-ATS (browser-only) companies for the main-session browser tier.
  const bqIdx = argv.indexOf('--browser-queue');
  if (bqIdx !== -1 && argv[bqIdx + 1]) {
    const browserOnly = rows.filter(r => !r.ats_api_url);
    const out = 'company\tcareers_url\n' + browserOnly.map(r => `${r.company}\t${r.careers_url}`).join('\n') + (browserOnly.length ? '\n' : '');
    writeFileSync(argv[bqIdx + 1], out, 'utf-8');
    console.log(`Browser queue: ${browserOnly.length} non-ATS companies → ${argv[bqIdx + 1]}`);
  }

  const coverageMsg = onlyIdx !== -1 ? '' : coverageWarning(scannable.length);
  console.log(`Sweeping ${scannable.length} indexed companies (${windowLabel}, ${areaLabel()})…\n`);

  let totalFound = 0, totalTitle = 0, totalLoc = 0, totalOld = 0, totalDup = 0;
  const winDays = hours ? Math.max(1, Math.ceil(hours / 24)) : days;
  const win = { start: windowStartFor({ hours, days }), isRecent, localDateStr };
  const labels = newTally();
  const famStats = {};            // family -> { boards, ok, jobs }
  // Baseline for the dead-lane check: families that returned jobs on a previous run (index last_status
  // "N jobs / ...", N>0). A family with no such history is a quiet or tiny lane, not a broken parser.
  const famHadJobs = new Set();
  for (const r of scannable) {
    const n = parseInt(String(r.last_status || '').match(/^(\d+) jobs/)?.[1] || '0', 10);
    if (n > 0) { const a = detectApi({ api: r.ats_api_url, careers_url: r.careers_url }); if (a) famHadJobs.add(a.type); }
  }
  const roundCapped = [];
  const candidates = [];
  const errors = [], timeouts = [];
  const zeroBoards = [], partialBoards = [];
  const statusByUrl = new Map();

  const tasks = scannable.map(r => {
    const t = async () => {
    const api = detectApi({ api: r.ats_api_url, careers_url: r.careers_url });
    if (!api || !PARSERS[api.type]) { errors.push(`${r.company}: no parser`); return; }
    try {
      // Workday: stop paging at the window edge and run location-detail requests only for rows that already
      // pass the date + title gate (fetchWorkday); Oracle HCM stops by PostedDate.
      const wdCut = Math.max(1, winDays);
      const prefilter = (j) => { const a = workdayAgeDays(j.postedOn); return (a == null || a <= wdCut) && titleFilter(j.title) && !blocked(r.company); };
      const json = await fetchProvider(api, { windowDays: winDays, windowStart: win.start, prefilter, label: r.company });
      const jobs = PARSERS[api.type](json, r.company, api);
      totalFound += jobs.length;
      const fs = famStats[api.type] ||= { boards: 0, ok: 0, jobs: 0 };
      fs.boards++; fs.ok++; fs.jobs += jobs.length;
      if (ROUND_CAPS.includes(jobs.length) && !json?.earlyStopped && !json?.pageCapHit) roundCapped.push(`${r.company} (${api.type}: exactly ${jobs.length} jobs)`);
      if (!jobs.length) zeroBoards.push(`${r.company} (${api.type})`);
      if (json && json.partial) partialBoards.push(`${r.company} (${api.type}: some pages failed or page cap hit, expected ${json.expected})`);
      // Undated families (Rippling, BambooHR, Taleo, date-less iCIMS tenants such as Acadia) used to
      // fail every recency check (postedAt=null) and so could never yield a candidate. They now
      // gate on FIRST-SEEN: the first sweep of a board seeds the registry silently (otherwise its
      // whole backlog would look "new"), and every later sweep surfaces only reqs not seen before.
      // Labelled date-basis first-seen so nobody mistakes it for an ATS publish date.
      const boardSeeded = jobs.some(j => !j.postedAt && j.dateSource !== 'updated_at' && firstSeenKnown(j.url));
      // Register EVERY undated req up front (not just filter survivors), so the board counts as
      // seeded next sweep even if nothing on it matched the title/location filters this time.
      const newUndated = new Set();
      for (const j of jobs) if (!j.postedAt && j.dateSource !== 'updated_at' && j.url) {
        if (!firstSeenKnown(j.url)) newUndated.add(j.url);
        firstSeen(j.url, { record: !dryRun });
      }
      let kept = 0;
      for (const job of jobs) {
        if (blocked(r.company || job.company)) { totalTitle++; continue; }
        if (!titleFilter(job.title)) { totalTitle++; continue; }
        if (dealbreakerHit(r.company || job.company, job.title)) { totalTitle++; continue; }
        // The remote policy also applies to the TITLE: some posts hardcode a local
        // location field but flag remote in the title ("... (US – Remote)").
        // Unless it says hybrid, the title must pass location.remote_policy too.
        if (/\b(remote|work from home|wfh|distributed|anywhere)\b/i.test(job.title) && !/hybrid/i.test(job.title)
            && !remoteOkFor(job.title, `${job.title} ${job.location || ''}`)) { totalLoc++; continue; }
        const lv = locVerdict(job.location, job.title, job.offices);
        if (!lv.ok) { totalLoc++; continue; }
        job.loc_flag = lv.flag;
        let dateBasis = 'ats';
        if (!job.postedAt && job.dateSource !== 'updated_at') {
          if (!newUndated.has(job.url) || !boardSeeded) { totalOld++; continue; }
          job.postedAt = new Date(firstSeen(job.url, { record: !dryRun })); dateBasis = 'first-seen';
          if (!isRecent(job.postedAt)) { totalOld++; continue; }
        } else {
          // Dated families: label the evidence (see lib/freshness.mjs). Day-level families (Workday,
          // Oracle, iCIMS, Taleo) are fresh only when the id was first seen inside this window.
          const res = labelFreshness(job, api.type, ledgerGet(job.url), win);
          tally(labels, res, job);
          if (res.record && !dryRun) ledgerPut(job.url, { source: 'scan-index', lastDate: res.lastDate });
          if (!res.fresh) { totalOld++; continue; }
          job.dateLabel = res.label;
          job.dateFlags = [...(job.repostFlags || []), ...(res.edge ? ['edge'] : [])];
          if (DAY_LEVEL_FAMILIES.has(api.type)) dateBasis = 'first-seen+ats-day';
        }
        if (seenUrls.has(dedupUrlKey(job.url))) { totalDup++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenRoles.has(key)) { totalDup++; continue; }
        seenUrls.add(dedupUrlKey(job.url)); seenRoles.add(key);
        candidates.push({ ...job, ats: api.type, dateBasis });
        kept++;
      }
      statusByUrl.set(r.careers_url, `${jobs.length} jobs / ${kept} kept`);
    } catch (err) {
      (famStats[api.type] ||= { boards: 0, ok: 0, jobs: 0 }).boards++;
      // A timeout says the HOST was slow, not that the board is dead: keep it out of the repair list.
      if (isTimeoutError(err)) { timeouts.push(r.company); statusByUrl.set(r.careers_url, 'timeout'); }
      else { errors.push(`${r.company}: ${err.message}`); statusByUrl.set(r.careers_url, `error: ${err.message}`); }
    }
    };
    t.host = taskHost(r.ats_api_url);   // per-host cap: 792 boards share api.ashbyhq.com
    return t;
  });

  await parallelFetch(tasks, 24);
  candidates.sort((a, b) => (b.postedAt?.getTime() || 0) - (a.postedAt?.getTime() || 0));

  console.log('━'.repeat(50));
  console.log(`Companies swept:   ${scannable.length}  (${errors.length} errors)`);
  // Index rows on an ATS we can recognise but not parse (SuccessFactors, Jobvite, Paycor, Taleo
  // Business, Oracle with no siteNumber). Logged so they are not mistaken for an empty market.
  const unsupported = {};
  for (const r of rows) {
    if (r.ats_api_url) continue;
    const fam = detectFamily(r.careers_url) || (r.ats_type && !PARSERS[r.ats_type] ? r.ats_type : null);
    if (fam) unsupported[fam] = (unsupported[fam] || 0) + 1;
  }
  const byFam = {};
  for (const r of scannable) { const t = detectApi({ api: r.ats_api_url, careers_url: r.careers_url })?.type || 'unknown'; byFam[t] = (byFam[t] || 0) + 1; }
  console.log(`Boards by family:  ${JSON.stringify(byFam)}`);
  if (Object.keys(unsupported).length) console.log(`Unsupported ATS (detected, not scanned): ${JSON.stringify(unsupported)}`);
  console.log(`Jobs found:        ${totalFound}`);
  console.log(`Filtered title:    ${totalTitle}`);
  console.log(`Filtered location: ${totalLoc}`);
  console.log(`Outside ${windowLabel} window: ${totalOld}`);
  console.log(`Duplicates:        ${totalDup}`);
  console.log(`NEW candidates:    ${candidates.length}`);
  console.log(`Freshness labels:  ${formatTally(labels)}   (dated families; fresh/new count as candidates)`);
  if (scanStats.workdayTenants) {
    console.log(`Workday:           ${scanStats.workdayTenants} tenants, ${scanStats.workdayEarlyStop} stopped early at the window edge, `
      + `${scanStats.workdayPageCap.length} hit the page cap, ${scanStats.workdayDetailFetched} detail requests, `
      + `${scanStats.workdayReposts} likely reposts flagged, ${scanStats.backoff429} backoff retries (${scanStats.backoffGaveUp} gave up)`);
    if (scanStats.workdayPageCap.length) console.log(`  page cap hit (fresh rows may remain past it; rerun with --full): ${scanStats.workdayPageCap.slice(0, 10).join(', ')}`);
    if (scanStats.workdayDetailCapped.length) console.log(`  WORKDAY_DETAIL_CAP bit (multi-site rows left unresolved): ${scanStats.workdayDetailCapped.slice(0, 10).join(', ')}`);
  }
  const http = requestSummary();
  if (http.length) {
    console.log('HTTP by family (requests, status:count):');
    for (const h of http) console.log(`  ${h.family.padEnd(18)} ${String(h.requests).padStart(6)}  ${fmtStatuses(h.statuses)}`);
  }
  if (coverageMsg) console.log(coverageMsg);
  console.log('━'.repeat(50));
  for (const c of candidates) {
    console.log(`${c.company} | ${c.title} | ${c.location} | ${localTimeStr(c.postedAt)} | ${c.url}${c.loc_flag ? ` | loc_flag: ${c.loc_flag}` : ''}${c.dateLabel ? ` | date: ${c.dateLabel}${c.dateFlags?.length ? ` [${c.dateFlags.join(',')}]` : ''}` : ''}`);
  }

  // Name the boards that failed. These used to be counted and discarded, so a row could
  // 404 on every sweep for weeks with nothing but a number to show for it (measured
  // 2026-08-04: 53 of 1348 dead, including Rippling, Retool, DoorDash, Sourcegraph and
  // Fireworks AI — all real employers whose board slug had moved). A 404 almost always
  // means the company migrated ATS; repair-index re-detects and rewrites those rows.
  if (zeroBoards.length) {
    console.log(`\n${zeroBoards.length} board(s) parsed 0 jobs (empty board OR a broken parser; check these):`);
    for (const z of zeroBoards.slice(0, 15)) console.log(`  ${z}`);
  }
  if (roundCapped.length) {
    console.log(`\n${roundCapped.length} board(s) returned exactly a round cap (${ROUND_CAPS.join('/')}): possibly truncated:`);
    for (const z of roundCapped.slice(0, 15)) console.log(`  ${z}`);
  }
  if (partialBoards.length) {
    console.log(`\n${partialBoards.length} board(s) returned a PARTIAL list:`);
    for (const z of partialBoards.slice(0, 15)) console.log(`  ${z}`);
  }
  if (timeouts.length) console.log(`\n${timeouts.length} board(s) timed out (slow host or network, not counted as dead; re-run later, repair-index will not touch them)`);
  if (errors.length) {
    const shown = errors.slice(0, 15);
    console.log(`\n${errors.length} board(s) failed:`);
    for (const e of shown) console.log(`  ${e}`);
    if (errors.length > shown.length) console.log(`  … and ${errors.length - shown.length} more`);
    console.log('  -> repair with: node scripts/repair-index.mjs --apply');
  }

  // Write candidates for the scoring pass (default data/_candidates-new.tsv; skipped on --dry-run unless --out given).
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : (dryRun ? null : DEFAULT_OUT);
  if (outPath) {
    const lines = candidates.map(c => [TODAY, c.company, c.title, c.location, (c.postedAt ? c.postedAt.toISOString() : ''), c.url, c.ats, c.loc_flag || '', c.dateLabel || '', (c.dateFlags || []).join(',')].join('\t'));
    writeFileSync(outPath, 'date\tcompany\trole\tlocation\tposted\turl\tats\tloc_flag\tdate_label\tdate_flags\n' + (lines.length ? lines.join('\n') + '\n' : ''), 'utf-8');
    console.log(`\nWrote ${candidates.length} candidates → ${outPath}`);
  }

  if (!dryRun) { const n = ledgerFlush(); if (n) console.log(`First-seen ledger: +${n} row(s) -> data/_first-seen.tsv`); }

  // A lane that fetched boards successfully yet parsed ZERO rows is a broken parser or a changed API,
  // not a quiet market. >=5 such boards in a family that had jobs before = failure (non-zero exit, loud); else a warning.
  // >=5 empty-200 boards AND the family returned jobs on a previous run = failure; otherwise a warning.
  const deadLanes = Object.entries(famStats).filter(([, f]) => f.ok >= 1 && f.jobs === 0);
  for (const [fam, f] of deadLanes) {
    const fatal = deadLaneFatal(f, famHadJobs.has(fam));
    console[fatal ? 'error' : 'log'](`${fatal ? 'FAIL' : 'WARN'}: ${fam} lane parsed 0 jobs from ${f.ok} board(s) that returned HTTP 200 (${f.boards} attempted). ${fatal ? 'Parser or API shape has likely changed.' : 'Probably empty boards; watch it.'}`);
    if (fatal) process.exitCode = 1;
  }

  // Persist last_scanned (keeps the index live).
  if (!dryRun) {
    const text = readFileSync(INDEX_PATH, 'utf-8').split('\n');
    const header = text[0].split('\t');
    const ci = { cu: header.indexOf('careers_url'), ls: header.indexOf('last_scanned'), st: header.indexOf('last_status') };
    const updated = text.map((line, i) => {
      if (i === 0 || !line) return line;
      const c = line.split('\t');
      if (!registryUrls.has(c[ci.cu]) && statusByUrl.has(c[ci.cu])) { c[ci.ls] = TODAY; c[ci.st] = statusByUrl.get(c[ci.cu]); }
      return c.join('\t');
    });
    writeFileSync(INDEX_PATH, updated.join('\n'), 'utf-8');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
