#!/usr/bin/env node

/**
 * probe-ats.mjs — find the ATS boards the company index is blind to.
 *
 * WHY THIS EXISTS (finding 2026-07-29): `scan-core.mjs` has parsed nine ATS
 * families for months — greenhouse, ashby, lever, workday, bamboohr, teamtailor,
 * smartrecruiters, workable, recruitee — but `data/company-index.tsv` contains
 * ONLY ashby (775), greenhouse (449) and lever (105). Zero rows on the other six.
 *
 * The cause was never the parsers. It was the discovery agent's prompt, which
 * asked exclusively for `job-boards.greenhouse.io/{slug}`, `jobs.ashbyhq.com/{slug}`
 * and `jobs.lever.co/{slug}`. So every employer on Workday or SmartRecruiters was
 * structurally invisible to the sweep — which is most large employers, and is
 * exactly why Rippling and Intuit roles only ever showed up via LinkedIn.
 *
 * This probes candidate company names against the URL patterns of the families the
 * index is missing, confirms a real board by fetching it and counting postings, and
 * emits `company<TAB>careers_url` rows for `discover-companies.mjs` to merge (it
 * already runs detectApi() generically, so it accepts any supported family).
 *
 * Zero LLM cost — plain HTTP against public endpoints.
 *
 * Usage:
 *   node scripts/probe-ats.mjs --names "Intuit,Rippling,NetApp"
 *   node scripts/probe-ats.mjs --file data/_probe-names.txt
 *   node scripts/probe-ats.mjs --from-ledger        # unindexed employers we've scored
 *   node scripts/probe-ats.mjs --from-ledger --append   # write to _discovered-companies.tsv
 *   node scripts/probe-ats.mjs --unresolved --append    # employers LinkedIn queued with no careers_url
 *
 * `--unresolved` closes the loop this script was written for. linkedin-crawl.mjs queues every
 * employer it cannot resolve into data/_discovered-companies.tsv as a BARE NAME, but
 * discover-companies.mjs only accepts `company<TAB>careers_url` rows (parseTsvPairs drops
 * anything without a /^https?:\/\// URL). Between 2026-07-31 and 2026-08-06 that silently
 * discarded 55 of 55 employers LinkedIn had discovered — the largest single source of loss in
 * the whole lane. This mode reads those bare names, probes the six ATS families the crawl
 * itself never tries, and rewrites each resolved row in place with its careers_url.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { loadNoise } from './role-filters.mjs';
import { detectApi, fetchProvider, PARSERS } from './scan-core.mjs';
import { slugs, FAMILIES, WD_SHARDS, wdSites, workdayProbes, tryUrl, probeCompany, probeCareersUrl } from './probe-ats-core.mjs';
// slugs/FAMILIES/workday matrix/tryUrl/probeCompany live in probe-ats-core.mjs (extracted 2026-09-03)
// so other scripts can reuse them in-process; behaviour here is unchanged.

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };
const APPEND = argv.includes('--append');
const UNRESOLVED = argv.includes('--unresolved');
const CONCURRENCY = Number(val('--concurrency') || 8);
const OUT = 'data/_discovered-companies.tsv';
// Re-probe a name that came back empty only every N days. Without this, every bare name that
// genuinely has no public board (Salesforce, Celonis, Google) is re-probed on every single run
// forever — hundreds of wasted HTTP requests a day against endpoints we want to stay welcome at.
const REPROBE_DAYS = 30;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

/** Rows in _discovered-companies.tsv that carry a bare name and no resolved careers_url. */
function unresolvedFromQueue() {
  if (!existsSync(OUT)) return [];
  const out = [];
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [company, url, meta] = t.split('\t').map((s) => (s || '').trim());
    if (!company) continue;
    if (/^https?:\/\//.test(url)) continue;                       // already resolved
    const m = /probed=(\d{4}-\d{2}-\d{2})/.exec(meta || '');
    if (m && (Date.now() - Date.parse(m[1])) / 864e5 < REPROBE_DAYS) continue;   // probed recently, found nothing
    out.push(company);
  }
  return [...new Map(out.map((n) => [n.toLowerCase(), n])).values()];
}

/**
 * Rewrite the queue in place: resolved names get their careers_url, names that probed empty get
 * stamped `probed=<date>` so they are skipped until REPROBE_DAYS have passed. Rows that already
 * carry a URL are copied through untouched.
 */
function rewriteQueue(resolved, probedNames) {
  if (!existsSync(OUT)) return { updated: 0, stamped: 0 };
  const byName = new Map(resolved.map((h) => [h.name.toLowerCase(), h]));
  const probed = new Set(probedNames.map((n) => n.toLowerCase()));
  let updated = 0, stamped = 0;
  const lines = readFileSync(OUT, 'utf8').split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const [company, url, meta] = t.split('\t').map((s) => (s || '').trim());
    if (!company || /^https?:\/\//.test(url)) return line;
    const hit = byName.get(company.toLowerCase());
    if (hit) { updated++; return `${company}\t${hit.careers}`; }
    if (probed.has(company.toLowerCase())) { stamped++; return `${company}\t\tprobed=${TODAY_ISO}`; }
    return line;
  });
  writeFileSync(OUT, lines.join('\n'));
  return { updated, stamped };
}

// ── candidate names ─────────────────────────────────────────────────────────

// ── name sources ────────────────────────────────────────────────────────────
function indexedCompanies() {
  if (!existsSync('data/company-index.tsv')) return new Set();
  return new Set(readFileSync('data/company-index.tsv', 'utf8').split('\n').slice(1)
    .map((l) => (l.split('\t')[0] || '').toLowerCase().trim()).filter(Boolean));
}

function ledgerCompanies() {
  if (!existsSync('data/scored-jobs.tsv')) return [];
  const seen = new Map();
  for (const line of readFileSync('data/scored-jobs.tsv', 'utf8').split('\n').slice(1)) {
    const f = line.split('\t');
    const co = (f[1] || '').trim();
    if (co) seen.set(co.toLowerCase(), co);
  }
  return [...seen.values()];
}

const STANDALONE = Boolean(val('--names') || val('--file'));

/**
 * --urls a,b / --url-file f: resolve careers URLs (vanity pages included) to family + board id.
 * Prints one line per URL and a by-family summary that counts detect-only (unsupported) families
 * separately. --json prints the raw objects. With --append, supported hits are appended to
 * data/_discovered-companies.tsv as `company<TAB>careers_url` (company = --company or host).
 */
async function verifyBoard(r) {
  try {
    const api = detectApi({ api: r.api_url, careers_url: r.careers_url });
    if (!api || !PARSERS[api.type]) return 0;
    return PARSERS[api.type](await fetchProvider(api), 'probe', api).length;
  } catch { return 0; }
}

async function resolveUrls(urls) {
  const out = [];
  for (const u of urls) {
    const r = await probeCareersUrl(u).catch((e) => ({ error: e.message }));
    // A URL that merely MATCHES a family pattern is not a board. Fetch and parse it, and only call
    // it resolved when it yields >= 1 posting (nonexistent tenants, 302s to the vendor homepage and
    // 404s were all being marked resolved and appended). --no-verify skips this for offline use.
    if (r && r.supported && !argv.includes('--no-verify')) {
      const jobs = await verifyBoard(r);
      r.postings = jobs;
      if (!jobs) { r.supported = false; r.via = `${r.via}; unverified (0 postings or fetch failed)`; }
    }
    out.push({ input: u, ...(r || { family: null }) });
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); }
  else for (const r of out) {
    const tag = !r.family ? 'no ATS detected' : r.supported ? `${r.family} board=${r.board} (${r.via})` : /unverified/.test(r.via || '') ? `${r.family} board=${r.board} [${r.via}]` : `${r.family} [unsupported family: detect only]`;
    console.log(`  ${r.family && r.supported ? '✓' : '·'} ${r.input} → ${tag}`);
  }
  const sup = {}, uns = {};
  for (const r of out) if (r.family) (r.supported ? sup : uns)[r.family] = ((r.supported ? sup : uns)[r.family] || 0) + 1;
  console.log(`\nresolved ${out.filter((r) => r.supported).length}/${urls.length} | supported: ${JSON.stringify(sup)} | unsupported (detected, not scanned): ${JSON.stringify(uns)}`);
  if (APPEND) {
    const rows = out.filter((r) => r.supported).map((r) => `${val('--company') || new URL(r.input).host}\t${r.careers_url}`);
    if (rows.length) appendFileSync(OUT, rows.join('\n') + '\n');
    console.log(`appended ${rows.length} row(s) → ${OUT}`);
  }
}

async function main() {
  if (val('--urls') || val('--url-file')) {
    const urls = val('--urls') ? val('--urls').split(',').map((s) => s.trim()).filter(Boolean)
      : readFileSync(val('--url-file'), 'utf8').split('\n').map((s) => s.split('\t').pop().trim()).filter((s) => /^https?:/.test(s));
    return resolveUrls(urls);
  }
  let names = [];
  if (val('--names')) names = val('--names').split(',').map((s) => s.trim()).filter(Boolean);
  else if (val('--file')) names = readFileSync(val('--file'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  else if (argv.includes('--from-ledger')) {
    const indexed = indexedCompanies();
    names = ledgerCompanies().filter((n) => !indexed.has(n.toLowerCase()));
    console.log(`from-ledger: ${names.length} employers we have scored but never indexed`);
  } else if (UNRESOLVED) {
    const indexed = indexedCompanies();
    names = unresolvedFromQueue().filter((n) => !indexed.has(n.toLowerCase()));
    console.log(`unresolved: ${names.length} employer(s) queued by LinkedIn with no careers_url yet`);
    if (!names.length) { console.log('  (nothing to probe — the queue is fully resolved or recently probed)'); return; }
  } else {
    console.error('need --names, --file, --from-ledger, --unresolved, --urls or --url-file');
    process.exit(1);
  }

  const hits = [];
  let done = 0;
  const queue = [...names];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const name = queue.shift();
      // --names/--file are standalone callers with no upstream greenhouse/ashby/lever guess
      // (that only exists on the LinkedIn crawl path), so they must probe the core families too.
      const hit = await probeCompany(name, { includeCore: STANDALONE });
      done++;
      if (hit) {
        hits.push(hit);
        const tag = hit.verified === false ? `  [unverified: ${hit.reason}]` : hit.unsupported ? '  [unsupported family: detect only]' : '';
        console.log(`  ✓ ${hit.name} → ${hit.family} (${hit.postings} postings)  ${hit.careers}${tag}`);
      }
      if (done % 25 === 0) console.log(`  …${done}/${names.length} probed, ${hits.length} found`);
    }
  });
  await Promise.all(workers);

  console.log(`\nprobed ${names.length} companies → ${hits.length} boards found`);
  const byFamily = hits.reduce((a, h) => ({ ...a, [h.family]: (a[h.family] || 0) + 1 }), {});
  console.log(`by family: ${JSON.stringify(byFamily)}`);

  // Not every live board belongs in the index. The first --from-ledger run turned up
  // a board literally named "Confidential", plus staffing shells (Mastech Digital,
  // Skyrocket Ventures, Maven Companies) and one-posting placeholders. Indexing those
  // costs a sweep slot forever and reintroduces exactly the anonymized-employer rows
  // the scan filters exist to drop, so they are refused at the door.
  const JUNK = /^(confidential|undisclosed|various|n\/?a|unknown|private)\b/i;
  // AGENCY / NON-EMPLOYER filter. Two layers, because one private regex was never going to hold.
  //
  // Audited 2026-08-24: the old local-only regex let **15 of 15** sampled non-employers through,
  // including Robert Half — a name already sitting in data/_speed-noise.txt. Two concrete leaks:
  // `talent\s` demanded trailing whitespace so "TalentAlly" and "Protech Talent" missed, and
  // VC/PE vocabulary ("Ventures", "Capital", "Partners", "Fund") was absent entirely, so investors
  // were being probed as if they were employers. These names then occupy the 30-day reprobe
  // cooldown forever, spending HTTP budget for guaranteed zero yield.
  //
  // Layer 1 is the SHARED blocklist every other lane uses (data/_speed-noise.txt) — the same
  // divergent-copies mistake as SEARCH_KEYWORDS and the crawl's prefilter. Layer 2 is a pattern
  // for shapes a name-list cannot enumerate.
  const NOISE_LIST = loadNoise();
  const inBlocklist = (n) => { const l = String(n || '').toLowerCase(); return NOISE_LIST.some(x => l.includes(x)); };
  const AGENCY = new RegExp([
    'staffing', 'recruit(ing|ment|er|s)?\\b', '\\btalent\\b', 'search group', 'placement',
    'resourcing', 'consultants?\\b', 'consulting\\b', 'technologies llc$',
    // investors are not employers
    '\\bventures?\\b', '\\bcapital\\b', '\\bpartners\\b', '\\bequity\\b', '\\bfund\\b',
    // job boards / talent marketplaces / membership orgs
    '\\bjobs?\\b', 'careers?$', 'hire\\b', 'hiring\\b', '\\bcruit\\b',
  ].join('|'), 'i');
  const kept = [], refused = [];
  for (const h of hits) {
    if (JUNK.test(h.name)) refused.push([h.name, 'anonymized employer']);
    else if (inBlocklist(h.name)) refused.push([h.name, 'blocklisted employer (_speed-noise.txt)']);
    else if (AGENCY.test(h.name)) refused.push([h.name, 'staffing agency / investor / job board']);
    else if (h.verified === false) refused.push([h.name, `unverified (${h.reason})`]);
    else if (h.postings < 3) refused.push([h.name, `only ${h.postings} posting(s)`]);
    else kept.push(h);
  }
  if (refused.length) {
    console.log(`\nrefused ${refused.length}:`);
    for (const [n, why] of refused) console.log(`  ✗ ${n} — ${why}`);
  }

  if (UNRESOLVED) {
    // Update the queue IN PLACE rather than appending: the bare-name rows are already there, and
    // appending would leave every one of them behind to be re-probed on every future run.
    if (!APPEND) {
      console.log(`\n(dry run — pass --append to rewrite ${OUT} with the ${kept.length} resolved careers_url(s))`);
    } else {
      const { updated, stamped } = rewriteQueue(kept, names);
      console.log(`\n${OUT}: ${updated} row(s) resolved to a careers_url, ${stamped} stamped probed=${TODAY_ISO} (skipped for ${REPROBE_DAYS}d)`);
      console.log('next: node scripts/discover-companies.mjs --from data/_discovered-companies.tsv');
    }
  } else if (APPEND && kept.length) {
    appendFileSync(OUT, kept.map((h) => `${h.name}\t${h.careers}`).join('\n') + '\n');
    console.log(`\nappended ${kept.length} rows → ${OUT}`);
    console.log('next: node scripts/discover-companies.mjs --from data/_discovered-companies.tsv');
  } else if (kept.length) {
    console.log('\n(dry run — pass --append to write them to data/_discovered-companies.tsv)');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
