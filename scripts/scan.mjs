#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { requireTargets } from './targets.mjs';
import {
  TZ,
  scanWindowDays,
  dealbreakerHit,
  coverageWarning,
  printDroppedTitleSample,
  toDate,
  localDateStr,
  localTimeStr,
  dateOnly,
  detectApi,
  PARSERS,
  XML_PROVIDERS,
  POST_PROVIDERS,
  fetchJson,
  fetchWorkday,
  buildTitleFilter,
  buildLocationFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  dedupUrlKey,
  parallelFetch, taskHost,
  SCAN_HISTORY_PATH,
  PIPELINE_PATH,
  APPLICATIONS_PATH,
} from './scan-core.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

// Total workers; parallelFetch caps any single host at 8 (see scan-core.mjs — most of the
// index rides on three shared ATS API hosts, and Ashby has rate-limited over-eager sweeps).
const CONCURRENCY = 24;

// Filter posts to the user's local calendar date (profile location.timezone).
const TODAY_LOCAL = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// Recency window in days (1 = today only). Default pipeline.scan_window_days; CLI override via --days N.
function parseDaysArg(argv) {
  const idx = argv.indexOf('--days');
  if (idx === -1) return scanWindowDays();
  const n = parseInt(argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : scanWindowDays();
}
const RECENCY_DAYS = parseDaysArg(process.argv.slice(2));
const RECENCY_CUTOFF = (() => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (RECENCY_DAYS - 1));
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
})();

function isPostedToday(d) {
  if (RECENCY_DAYS === 1) return localDateStr(d) === TODAY_LOCAL;
  if (!d) return false;
  return d >= RECENCY_CUTOFF;
}

// (detectApi, parsers, fetch/filter/dedup helpers imported from scan-core.mjs)

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Prefer English "## Pending"; tolerate legacy "## Pendientes" / "## Procesadas".
  const findMarker = (...candidates) => {
    for (const m of candidates) {
      const i = text.indexOf(m);
      if (i !== -1) return { marker: m, idx: i };
    }
    return null;
  };

  const pending = findMarker('## Pending', '## Pendientes');
  if (!pending) {
    const processed = findMarker('## Processed', '## Procesadas');
    const insertAt = processed ? processed.idx : text.length;
    const block = `\n## Pending\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = pending.idx + pending.marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

const SCAN_HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tposted_at\tupdated_at\n';

function migrateScanHistoryHeader() {
  if (!existsSync(SCAN_HISTORY_PATH)) return;
  const content = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  const firstLine = content.split('\n', 1)[0];
  const cols = firstLine.split('\t').length;
  if (cols >= 8) return;
  // Old 6-column file. Pad every row with 2 empty columns and rewrite the header.
  const padded = content
    .split('\n')
    .map((line, i) => {
      if (i === 0) return SCAN_HISTORY_HEADER.trim();
      if (!line) return line;
      return line + '\t\t';
    })
    .join('\n');
  writeFileSync(SCAN_HISTORY_PATH, padded, 'utf-8');
}

function appendToScanHistory(offers, date) {
  migrateScanHistoryHeader();
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, SCAN_HISTORY_HEADER, 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${dateOnly(o.postedAt)}\t${dateOnly(o.updatedAt)}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  requireTargets();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  const aggregators = (config.aggregator_apis || []).filter(a => a.enabled !== false);
  const locFilter = buildLocationFilter();

  const coverageMsg = filterCompany ? '' : coverageWarning(targets.length);
  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (aggregators.length > 0) console.log(`Scanning ${aggregators.length} aggregator feeds`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLocation = 0;
  let totalDealbreaker = 0;
  let totalDupes = 0;
  let totalNotToday = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => {
    const task = async () => {
    const { type, url } = company._api;
    try {
      let json;
      if (POST_PROVIDERS.has(type)) {
        json = await fetchWorkday(url);
      } else if (XML_PROVIDERS.has(type)) {
        json = await fetchJson(url, { expect: 'text' });
      } else {
        json = await fetchJson(url);
      }
      const jobs = PARSERS[type](json, company.name, company._api);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (dealbreakerHit(job.company, job.title)) {
          totalDealbreaker++;
          continue;
        }
        if (!locFilter(job.location, job.title, job.offices)) {
          totalLocation++;
          continue;
        }
        if (!isPostedToday(job.postedAt)) {
          totalNotToday++;
          continue;
        }
        if (seenUrls.has(dedupUrlKey(job.url))) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(dedupUrlKey(job.url));
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
    };
    task.host = taskHost(company._api.url);
    return task;
  });

  // Aggregator tasks — one per feed, merged with company tasks
  const aggTasks = aggregators.map(agg => {
    const task = async () => {
    try {
      const json = XML_PROVIDERS.has(agg.type)
        ? await fetchJson(agg.url, { expect: 'text' })
        : await fetchJson(agg.url);
      const parser = PARSERS[agg.type];
      if (!parser) {
        errors.push({ company: agg.name, error: `unknown aggregator type: ${agg.type}` });
        return;
      }
      const jobs = parser(json, agg.name, { type: agg.type });
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!job.url) { totalFiltered++; continue; }
        if (!titleFilter(job.title)) { totalFiltered++; continue; }
        if (dealbreakerHit(job.company, job.title)) { totalDealbreaker++; continue; }
        if (!locFilter(job.location, job.title, job.offices)) { totalLocation++; continue; }
        if (!isPostedToday(job.postedAt)) { totalNotToday++; continue; }
        if (seenUrls.has(dedupUrlKey(job.url))) { totalDupes++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
        seenUrls.add(dedupUrlKey(job.url));
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${agg.type}-api` });
      }
    } catch (err) {
      errors.push({ company: agg.name, error: err.message });
    }
    };
    task.host = taskHost(agg.url);
    return task;
  });

  await parallelFetch([...tasks, ...aggTasks], CONCURRENCY);

  // Sort by posted time, newest first — fewer applicants on fresh posts.
  newOffers.sort((a, b) => (b.postedAt?.getTime() || 0) - (a.postedAt?.getTime() || 0));

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  const windowLabel = RECENCY_DAYS === 1
    ? `today = ${TODAY_LOCAL} ${TZ}`
    : `last ${RECENCY_DAYS} days ending ${TODAY_LOCAL} ${TZ}`;
  console.log(`Portal Scan — ${date} (${windowLabel})`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Aggregators scanned:   ${aggregators.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalLocation} removed`);
  console.log(`Dealbreakers:          ${totalDealbreaker} removed`);
  console.log(`${(RECENCY_DAYS === 1 ? 'Not posted today:' : `Older than ${RECENCY_DAYS}d:`).padEnd(22)} ${totalNotToday} skipped`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (coverageMsg) console.log(coverageMsg);
  printDroppedTitleSample(); // --explain: 10 titles the filter dropped

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers (newest first):');
    for (const o of newOffers) {
      console.log(`  ${localTimeStr(o.postedAt)}  ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-finder pipeline to evaluate new offers.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
