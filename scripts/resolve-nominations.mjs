#!/usr/bin/env node

/**
 * resolve-nominations.mjs — turn LinkedIn nominations into canonical ATS requisitions.
 * Zero LLM cost, zero browser.
 *
 * THE GAP THIS FILLS. `linkedin-jobsearch.mjs` and `linkedin-crawl.mjs` write rows to
 * data/_web-roles.tsv whose `url` column is a LinkedIn SEARCH url built from the title —
 * deliberately, because the results list exposes no per-card job id, so the lane can only
 * NOMINATE a company+title pair. Before this script, the only thing that could turn that pair
 * into a real requisition was the scoring agent, one WebFetch at a time. On a 73-row queue that
 * is the entire cost of the scoring pass, spent on lookups a script can do for free.
 *
 * WHAT IT DOES. For every nomination whose url is not already canonical, it looks the employer up
 * in data/company-index.tsv, hits that board's API through the SAME parsers scan-index uses, and
 * matches the nominated title against the real postings. What comes back is the primary source:
 * canonical url, the employer's own location string, the real publish date, and the job id.
 *
 * TITLE MATCHING IS DELIBERATELY CONSERVATIVE. A company routinely runs several same-shaped reqs
 * at once ("Data Engineer", "Data Engineer, Platform", "Senior Data Engineer")
 * with different gates and very different ages. Matching the wrong sibling produces a row that
 * looks verified and is about a different job — the same employer-vs-requisition confusion that
 * has bitten this pipeline repeatedly. So:
 *   - exact normalized title wins outright
 *   - otherwise a containment match is accepted ONLY when exactly one candidate matches
 *   - two or more plausible siblings => AMBIGUOUS, emitted for review, never silently picked
 *
 * THE DATE IS RECORDED, NOT JUDGED. An old ATS publish date does not
 * disqualify a nomination — a re-promoted req means they are still hiring. This script therefore
 * never drops a row for age. It reports the age so the scorer and the report can name it.
 *
 * Usage:
 *   node scripts/resolve-nominations.mjs                # resolve, write data/_resolved-noms.tsv
 *   node scripts/resolve-nominations.mjs --dry-run
 *   node scripts/resolve-nominations.mjs --limit 20
 *
 * NOMINATION LOOP (--nominate, build plan step 5). The other direction: not "which req is this
 * nomination" but "which BOARD is this employer". Every employer HiringCafe, the LinkedIn guest
 * lane or the Gmail alerts surfaced goes through apply-url / slug probe / Workday tenant lookup,
 * must pass a nonsense-slug control, and is appended to data/company-index.tsv. The new boards are
 * written to data/_new-boards.tsv, which morning.mjs sweeps right away with
 * `scan-index.mjs --only data/_new-boards.tsv` (lane ats:new-boards). Logic: scripts/lib/nominate.mjs.
 *   node scripts/resolve-nominations.mjs --nominate [--dry-run] [--limit N] [--scan]
 * --scan runs that scan-index sweep itself (for standalone use; morning.mjs does not pass it).
 * Kill switch: data/NOMINATE_OFF or NOMINATE_OFF=1 (data/PIPELINE_OFF also stops it).
 * LinkedIn: logged out only (<= 3 guest requests/day, >= 10s apart). The logged-in Apply-href tier
 * runs only with integrations.linkedin_apply_href_tier: true (default false).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { detectApi, fetchProvider, PARSERS } from './scan-core.mjs';
import { REMOTE, LOCAL, loadNoise, titleDropped, remoteOkFor, requireTargets, TITLE_KEEP, loadTargets } from './role-filters.mjs';

requireTargets();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const LIMIT = Number(val('--limit', '0')) || Infinity;
const OUT = 'data/_resolved-noms.tsv';

// ── nomination loop (employer -> board) ─────────────────────────────────────────────────────
if (has('--nominate')) {
  const N = await import('./lib/nominate.mjs');
  const off = N.nominateOff();
  if (off) { console.log(`nominate: SKIPPED, ${off}`); process.exit(0); }
  const integ = (() => { try { return loadTargets().integrations || {}; } catch { return {}; } })();
  const res = await N.runNominationLoop({
    deps: await N.defaultDeps(), noise: loadNoise(), tierOn: N.applyHrefTierOn(integ),
    limit: Number(val('--limit', '0')) || Infinity, dryRun: DRY,
    nonsense: `zz-cf-control-${Math.random().toString(36).slice(2, 8)}`,
  });
  for (const r of res.results.filter((x) => !['noise', 'already-indexed', 'skipped-recent-fail'].includes(x.status))) {
    console.log(`  ${r.status === N.RESOLVED ? '+' : '-'} ${r.company} [${r.lane}] ${r.status}${r.board ? ` ${r.board}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
  }
  console.log(res.summary);
  if (res.rate.rate != null && res.rate.rate < N.TARGET_RESOLVE_RATE) {
    console.log(`WARNING: nomination resolve rate ${Math.round(res.rate.rate * 100)}% is below the ${N.TARGET_RESOLVE_RATE * 100}% target`);
  }
  if (has('--scan') && !DRY && res.added.length) {
    const { spawnSync } = await import('child_process');
    const r = spawnSync(process.execPath, ['scripts/scan-index.mjs', '--only', 'data/_new-boards.tsv', '--hours', '48', '--out', 'data/_candidates-new.tsv'], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }
  process.exit(0);
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// ── inputs ──────────────────────────────────────────────────────────────────
const noms = (existsSync('data/_web-roles.tsv') ? readFileSync('data/_web-roles.tsv', 'utf-8') : '').split('\n').slice(1)
  .filter(Boolean).map((l) => l.split('\t'));

const index = new Map();
for (const line of (existsSync('data/company-index.tsv') ? readFileSync('data/company-index.tsv', 'utf-8') : '').split('\n').slice(1)) {
  const c = line.split('\t');
  if (!c[0]) continue;
  index.set(norm(c[0]), { company: c[0].trim(), careers_url: (c[2] || '').trim(), api: (c[4] || '').trim() });
}

const NOISE = loadNoise();
// DEDUP MUST READ THE SCORE COLUMN, NOT SCRAPE EVERY CELL FOR AN http PREFIX.
// The old version treated ANY row mentioning a url as "already scored". 929 of the 1922
// url-bearing rows in scored-jobs.tsv carry a NON-NUMERIC score (verdict `stale`, score "-"),
// most written under the pre-2026-08-24 "stale = reject" doctrine that CLAUDE.md has since
// REVERSED ("an old ATS date is not a freshness gate; stale now means the posting is GONE").
// Those placeholder rows were permanently blocking re-resolution of requisitions that are
// still open and were never actually evaluated. A row only counts as scored if it has a number.
const seenScored = new Set();
const addUrl = (u) => { const t = (u || '').trim().toLowerCase(); if (t.startsWith('http')) seenScored.add(t.replace(/[?#].*$/, '')); };
for (const line of readFileSync('data/scored-jobs.tsv', 'utf-8').split('\n').slice(1)) {
  const c = line.split('\t');
  if (!c[0]) continue;
  if (!/^\d/.test((c[3] || '').trim())) continue;   // "-" / stale placeholder is NOT a score
  addUrl(c[6]);
}
// _candidates.tsv has no score column: every row is a live pending item, so all of it dedups.
if (existsSync('data/_candidates.tsv')) {
  for (const line of readFileSync('data/_candidates.tsv', 'utf-8').split('\n').slice(1)) addUrl(line.split('\t')[5]);
}

// One board fetch per employer, however many titles that employer was nominated for.
const boardCache = new Map();
async function board(entry) {
  const key = entry.api || entry.careers_url;
  if (boardCache.has(key)) return boardCache.get(key);
  let jobs = [];
  try {
    const api = detectApi({ api: entry.api, careers_url: entry.careers_url });
    if (api && PARSERS[api.type]) {
      const raw = await fetchProvider(api);
      jobs = PARSERS[api.type](raw, entry.company, api) || [];
    }
  } catch { jobs = []; }
  boardCache.set(key, jobs);
  return jobs;
}

// ── resolve ─────────────────────────────────────────────────────────────────
const stats = { rows: 0, alreadyCanonical: 0, noIndexEntry: 0, boardEmpty: 0,
                noTitleMatch: 0, ambiguous: 0, noise: 0, remote: 0, nonLocal: 0,
                offArchetype: 0, dup: 0, resolved: 0 };
const out = [];
const ambiguousRows = [];
const unindexed = new Map();

for (const r of noms) {
  if (stats.rows >= LIMIT) break;
  stats.rows++;
  const [date, company, role, loc, posted, url, source] = r;

  if (NOISE.some((n) => (company || '').toLowerCase().includes(n))) { stats.noise++; continue; }

  // Already a real posting url — nothing to resolve, pass it through unchanged.
  if (url && !/linkedin\.com\/jobs\/search-results/.test(url)) {
    stats.alreadyCanonical++;
    out.push([date, company, role, loc, posted, url, source, '', 'already-canonical'].join('\t'));
    continue;
  }

  const entry = index.get(norm(company));
  if (!entry || !entry.api) {
    stats.noIndexEntry++;
    // An employer we cannot resolve is not a dead end, it is a gap in the index. Queue it so
    // probe-ats.mjs can find its board; the NEXT run resolves this nomination for free. This is
    // the same reason the LinkedIn crawl feeds the index even when zero rows verify.
    if (!titleDropped(role)) unindexed.set(norm(company), company);
    continue;
  }

  const jobs = await board(entry);
  if (!jobs.length) { stats.boardEmpty++; continue; }

  const want = norm(role);
  const exact = jobs.filter((j) => norm(j.title) === want);
  let hit = null;
  if (exact.length === 1) hit = exact[0];
  else if (exact.length > 1) {
    // Same title posted more than once (different offices). Prefer a local one, then the newest.
    const local = exact.filter((j) => LOCAL.test(j.location || ''));
    const pool = local.length ? local : exact;
    hit = pool.sort((a, b) => (b.postedAt?.getTime() || 0) - (a.postedAt?.getTime() || 0))[0];
  } else {
    const contains = jobs.filter((j) => {
      const t = norm(j.title);
      return t.includes(want) || want.includes(t);
    });
    if (contains.length === 1) hit = contains[0];
    else if (contains.length > 1) {
      stats.ambiguous++;
      ambiguousRows.push(`${company} | nominated "${role}" | ${contains.length} plausible reqs: ` +
        contains.slice(0, 4).map((j) => `"${j.title}"`).join(', '));
      continue;
    }
  }
  if (!hit) {
    stats.noTitleMatch++;
    if (process.env.RN_DEBUG) {
      const near = jobs.filter((j) => TITLE_KEEP.test(j.title));
      console.log(`  MISS ${company} | wanted "${role}" | board has ${jobs.length} jobs; on-archetype: ` +
        (near.slice(0, 5).map((j) => `"${j.title}" @ ${j.location}`).join(' ; ') || 'none'));
    }
    continue;
  }

  // Greenhouse boards routinely set location.name to a WORKPLACE TYPE ("Hybrid", "Remote") and
  // put the real city in offices[]. scan-core.mjs already extracts offices, so a genuine
  // local req labelled "Hybrid" is not lost. Checking both also correctly REJECTS the foreign
  // reqs that carry the same "Hybrid" label, so this widens accuracy, not the location gate.
  const hLoc = hit.location || '';
  const hOff = (hit.offices || []).join(', ');
  const hWhere = [hLoc, hOff].filter(Boolean).join(', ');
  // Remote follows location.remote_policy; anything else must be local.
  const isRemote = REMOTE.test(hit.title) || (hWhere && REMOTE.test(hWhere));
  if (isRemote && !remoteOkFor(hit.title, hWhere || '')) { stats.remote++; continue; }
  if (!isRemote && (!hWhere || !LOCAL.test(hWhere))) { stats.nonLocal++; continue; }
  if (titleDropped(hit.title)) { stats.offArchetype++; continue; }

  const key = (hit.url || '').toLowerCase().replace(/[?#].*$/, '');
  if (!key) { stats.noTitleMatch++; continue; }
  if (seenScored.has(key)) { stats.dup++; continue; }
  seenScored.add(key);

  const pubIso = hit.postedAt ? hit.postedAt.toISOString() : '';
  const ageD = hit.postedAt ? Math.round((Date.now() - hit.postedAt.getTime()) / 864e5) : '';
  out.push([date, entry.company, hit.title, hLoc, pubIso, hit.url, `${source}+ats`, ageD,
    norm(hit.title) === want ? 'exact-title' : 'contained-title'].join('\t'));
  stats.resolved++;
}

// ── report ──────────────────────────────────────────────────────────────────
const header = ['date', 'company', 'role', 'location', 'ats_posted', 'canonical_url',
                'source', 'age_days', 'match'].join('\t');
if (!DRY) writeFileSync(OUT, header + '\n' + (out.length ? out.join('\n') + '\n' : ''));

console.log(`resolve-nominations: ${stats.rows} nomination(s) -> ${out.length} row(s) with a canonical URL`);
console.log(`  resolved from the index : ${stats.resolved}`);
console.log(`  already canonical       : ${stats.alreadyCanonical}`);
console.log(`  employer not in index   : ${stats.noIndexEntry}   <-- these still need a web lookup`);
console.log(`  board returned nothing  : ${stats.boardEmpty}`);
console.log(`  no matching title       : ${stats.noTitleMatch}`);
console.log(`  AMBIGUOUS (>1 sibling)  : ${stats.ambiguous}   <-- never guessed; listed below`);
console.log(`  dropped: noise ${stats.noise}, remote ${stats.remote}, non-local ${stats.nonLocal}, ` +
            `off-archetype ${stats.offArchetype}, already scored ${stats.dup}`);
if (ambiguousRows.length) {
  console.log('\nAMBIGUOUS — the nominated title matches more than one live requisition. Picking one');
  console.log('would produce a row that looks verified and is about a different job:');
  for (const a of ambiguousRows) console.log(`  ? ${a}`);
}
if (unindexed.size) {
  console.log(`\n${unindexed.size} employer(s) nominated but NOT in the index — queued for probe-ats:`);
  console.log('  ' + [...unindexed.values()].join(', '));
  if (!DRY) {
    appendFileSync('data/_discovered-companies.tsv',
      [...unindexed.values()].map((c) => `${c}\t`).join('\n') + '\n');
    console.log('  -> appended to data/_discovered-companies.tsv');
    console.log('  next: node scripts/probe-ats.mjs --unresolved --append && node scripts/resolve-nominations.mjs');
  }
}
if (!DRY) console.log(`\nwrote ${OUT}`);
