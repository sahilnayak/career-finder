#!/usr/bin/env node

/**
 * browser-boards.mjs — drive the stealth Chrome against job boards that render CLIENT-SIDE and
 * therefore return nothing to a plain fetch. Zero LLM. Serial-ish, small concurrency, no LinkedIn.
 *
 * WHY A BROWSER, AND WHY ONLY HERE. Most sources do NOT need one and must not get one: the ATS
 * sweep, HiringCafe and Workable all serve real data over plain HTTP, and a browser would just be
 * a slower way to get the same bytes. This lane exists for boards where plain HTTP provably gets
 * an empty shell. Measured 2026-09-10:
 *
 *     sequoia    plain  20,230b / 0 ATS links  ->  browser 157,468b / 27 ATS links
 *     bessemer   plain  21,729b / 0 ATS links  ->  browser 250,594b / 33 ATS links
 *
 * THE TEST IS NOT "CAN A BROWSER LOAD IT". It is "does the source expose the EMPLOYER'S CANONICAL
 * ATS URL". A browser also defeats Indeed and Glassdoor, and they are still worthless, because
 * they trap the apply on their own domain and never reveal the canonical posting, which this
 * pipeline hard-SKIPs. Those stay blocklisted. VC portfolio boards pass the real test: their
 * listings link straight out to greenhouse/ashby/lever/workday.
 *
 * NEVER ADD LINKEDIN TO THIS FILE. LinkedIn job work is serial, main-agent-only, and spends the
 * shared li-budget counters (linkedin-crawl.mjs / linkedin-jobsearch.mjs own it). A second lane
 * touching LinkedIn would overspend that budget invisibly and is what gets an account flagged.
 *
 * CONCURRENCY is small and deliberate. These are separate CDP targets in ONE browser, not
 * parallel agents; the cap keeps us from hammering a single host and from opening more tabs than
 * the debug Chrome handles cleanly.
 *
 * Usage:
 *   node scripts/browser-boards.mjs                 # append survivors to data/_web-roles.tsv
 *   node scripts/browser-boards.mjs --dry-run
 *   node scripts/browser-boards.mjs --only sequoia
 *   node scripts/browser-boards.mjs --concurrency 2 --quiet
 */

import { appendFileSync, readFileSync, existsSync } from 'fs';
import { cdpAlive, newPage } from './cdp.mjs';
import { REMOTE, LOCAL, loadNoise, titleDropped, TITLE_KEEP, remoteOkFor, requireTargets, areaLabel } from './role-filters.mjs';

const PROFILE = requireTargets();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = has('--dry-run');
const QUIET = has('--quiet') || (process.env.CAREER_FINDER_QUIET || process.env.CAREER_OPS_QUIET) === '1';
const ONLY = val('--only', '');
const CONCURRENCY = Math.max(1, Math.min(4, Number(val('--concurrency', '3'))));
const log = (...a) => { if (!QUIET) console.log(...a); };

// Consider.com-powered VC portfolio boards: confirmed client-side rendered, identical ~20KB shell
// to plain curl regardless of path or query. First Round is deliberately ABSENT: it sits behind
// "Create an account or Sign in" and yields nothing to a logged-out browser either, so including
// it would just burn a tab every run. The generic login-wall detector below catches any that
// change behaviour later.
// These boards accept a URL-addressable LOCATION filter but ignore every text-search param we
// probed (searchTerm/query/q/keywords all returned the identical default page). Filtering by
// location at the URL raises Sequoia from 60 to 90 links before scrolling; title filtering has
// to happen on our side afterwards.
// Location label comes from the profile: discovery.vc_board_location, else location.metro.
const LOC_LABEL = PROFILE.discovery?.vc_board_location || PROFILE.location.metro || '';
const LOC_PARAM = LOC_LABEL ? `?locations=${encodeURIComponent(LOC_LABEL)}` : '';

// Default: Consider.com VC portfolio boards (startup/tech-heavy). Override with
// discovery.vc_boards: [[name, url], ...] in config/profile.yml, or [] to disable the lane.
const DEFAULT_BOARDS = [
  ['sequoia',     'https://jobs.sequoiacap.com/jobs'],
  ['bessemer',    'https://jobs.bvp.com/jobs'],
  ['lightspeed',  'https://jobs.lsvp.com/jobs'],
  ['kleiner',     'https://jobs.kleinerperkins.com/jobs'],
  ['initialized', 'https://jobs.initialized.com/jobs'],
  ['battery',     'https://jobs.battery.com/jobs'],
  ['felicis',     'https://jobs.felicis.com/jobs'],
  ['amplify',     'https://talent.amplifypartners.com/jobs'],
];
const BOARDS = Array.isArray(PROFILE.discovery?.vc_boards) ? PROFILE.discovery.vc_boards : DEFAULT_BOARDS;

const ATS_RE = /^https?:\/\/(?:job-boards\.|boards\.)?(?:greenhouse\.io|jobs\.ashbyhq\.com|jobs\.lever\.co|ashbyhq\.com|lever\.co|[a-z0-9-]+\.myworkdayjobs\.com|careers\.smartrecruiters\.com|apply\.workable\.com)\//i;
const LOGIN_WALL = /(create an account|sign in to|log in to continue|please sign in)/i;

const NOISE = loadNoise();
const seen = new Set();
for (const f of ['data/_web-roles.tsv', 'data/scored-jobs.tsv', 'data/_web-roles-history.tsv']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf-8').split('\n'))
    for (const cell of line.split('\t')) if (cell.startsWith('http')) seen.add(cell.trim());
}

// Pull every listing as {href, title, ctx} so a title and a location can be recovered from the card,
// not just a bare href. Capped so a huge board cannot blow up the CDP response.
const EXTRACT = `(() => {
  window.scrollTo(0, document.body.scrollHeight);
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!/greenhouse|ashbyhq|lever\\.co|myworkdayjobs|smartrecruiters|workable/i.test(href)) continue;
    let card = a, hops = 0;
    while (card.parentElement && hops < 4 && card.innerText && card.innerText.length < 30) { card = card.parentElement; hops++; }
    out.push({ href, title: (a.innerText || '').trim().slice(0, 120), ctx: (card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260) });
    if (out.length >= 900) break;
  }
  return JSON.stringify({ bodyText: (document.body ? document.body.innerText : '').slice(0, 600), items: out });
})()`;

const stats = { boards: 0, dead: 0, wall: 0, raw: 0, dupe: 0, remote: 0, nonLocal: 0, off: 0, noise: 0 };
const rows = [];

async function scrape([name, url]) {
  let page;
  try {
    page = await newPage();
    await page.navigate(url + LOC_PARAM, { waitMs: 12000 });

    // NOT every board honours the location param, and the ones that do not can render an EMPTY
    // result for it rather than ignoring it: lightspeed and battery both served real links
    // unfiltered and zero once LOC_PARAM was added. Falling back keeps a filter optimisation from
    // silently deleting a whole board, which is this repo's classic failure shape.
    const quickCount = `(() => [...document.querySelectorAll('a[href]')].map(a => a.href)
      .filter(h => /greenhouse|ashbyhq|lever\\.co|myworkdayjobs|smartrecruiters|workable/i.test(h)).length)()`;
    const filtered = Number(JSON.parse(JSON.stringify(await page.evaluate(quickCount)))) || 0;
    if (filtered === 0) {
      log(`  ${name}: location filter returned nothing, retrying unfiltered`);
      await page.navigate(url, { waitMs: 12000 });
    }

    // These boards lazy-load: Sequoia serves 90 links on first paint and 222 after one
    // scroll-and-load-more, then plateaus. Extracting without this throws away most of the board.
    // Loop until the count stops growing rather than guessing a fixed number of passes.
    const COUNT = `(() => [...document.querySelectorAll('a[href]')].map(a => a.href)
      .filter(h => /greenhouse|ashbyhq|lever\\.co|myworkdayjobs|smartrecruiters|workable/i.test(h)).length)()`;
    // Do NOT break out on two consecutive zeros. Lightspeed and Battery are slower Getro-style
    // boards that can still be painting when the first counts run; an early break made them look
    // permanently dead when they actually serve 24 and 58 links. Zero is "keep waiting", not
    // "plateaued" - only a repeated NON-ZERO count means the board is fully loaded.
    let prev = -1, zeroPasses = 0;
    for (let pass = 0; pass < 8; pass++) {
      const n = Number(JSON.parse(JSON.stringify(await page.evaluate(COUNT)))) || 0;
      if (n === 0 && zeroPasses++ < 3) { /* still rendering */ }
      else if (n === prev) break;
      prev = n;
      await page.evaluate(`(() => {
        window.scrollTo(0, document.body.scrollHeight);
        // BUTTONS ONLY, and never match on "next". An <a> reading "Next" is pagination that
        // NAVIGATES AWAY, which wiped the rendered results on the Getro-style boards and made
        // Lightspeed and Battery report zero links despite serving 24 and 58.
        const b = [...document.querySelectorAll('button')].find((x) => /load more|show more/i.test(x.innerText || ''));
        if (b) b.click();
        return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 3000));
    }

    const res = await page.evaluate(EXTRACT);
    const d = JSON.parse(typeof res === 'string' ? res : JSON.stringify(res));
    const items = d.items || [];
    if (LOGIN_WALL.test(d.bodyText || '') && !items.length) { stats.wall++; log(`  ${name}: login wall, skipped`); return; }
    if (!items.length) { stats.dead++; log(`  ${name}: rendered but 0 ATS links (board may have changed)`); return; }
    stats.boards++;
    stats.raw += items.length;

    let kept = 0;
    for (const it of items) {
      const href = (it.href || '').split('#')[0];
      if (!ATS_RE.test(href)) continue;
      if (seen.has(href)) { stats.dupe++; continue; }
      // The anchor text is the title on these boards; fall back to the card text.
      const title = (it.title || it.ctx || '').split('\n')[0].trim();
      if (!title) continue;
      const ctx = it.ctx || '';
      // Remote is kept only when location.remote_policy allows it; otherwise it must be local.
      const isRemote = REMOTE.test(title) || REMOTE.test(ctx);
      if (isRemote && !remoteOkFor(title, ctx || '')) { stats.remote++; continue; }
      if (!isRemote && !LOCAL.test(ctx)) { stats.nonLocal++; continue; }
      // Fuzzy source => the POSITIVE archetype gate is required, not just the negative drop list.
      if (!TITLE_KEEP.test(title) || titleDropped(title)) { stats.off++; continue; }
      // Employer is whatever owns the ATS board, e.g. .../acme/jobs/123 -> acme.
      const m = href.match(/(?:greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|smartrecruiters\.com)\/([a-z0-9-]+)/i);
      const company = m ? m[1] : name;
      const cl = company.toLowerCase();
      if (NOISE.some((n) => cl.includes(n))) { stats.noise++; continue; }
      const locM = ctx.match(LOCAL);
      seen.add(href);
      kept++;
      rows.push([new Date().toISOString().slice(0, 10), company, title,
                 locM ? locM[0] : (isRemote ? 'Remote' : areaLabel()), '', href, `vc-${name}`].join('\t'));
    }
    log(`  ${name}: ${items.length} ATS link(s) rendered, ${kept} kept`);
  } catch (e) {
    stats.dead++;
    log(`  ${name}: ERR ${String(e.message || e).slice(0, 60)}`);
  } finally { try { await page?.close(); } catch { /* tab already gone */ } }
}

if (!(await cdpAlive())) {
  console.error('browser-boards: debug Chrome is not running on the CDP port.');
  console.error('  start it with: node scripts/chrome-debug.mjs start');
  process.exit(3);
}

const targets = ONLY ? BOARDS.filter(([n]) => n === ONLY) : BOARDS;
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  await Promise.all(targets.slice(i, i + CONCURRENCY).map(scrape));
}

if (!DRY && rows.length) appendFileSync('data/_web-roles.tsv', rows.join('\n') + '\n');
log(`  dropped: dupe ${stats.dupe}, remote ${stats.remote}, non-local ${stats.nonLocal}, off-archetype ${stats.off}, noise ${stats.noise}`);
console.log(`browser-boards: ${stats.boards} board(s) rendered (${stats.wall} login-walled, ${stats.dead} dead), ${stats.raw} links seen, wrote ${DRY ? 0 : rows.length}`);
for (const r of rows) log(`  + ${r.split('\t')[1]} | ${r.split('\t')[2]}`);
