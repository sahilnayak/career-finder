#!/usr/bin/env node
/**
 * hunt.mjs — the zero-LLM backbone of the `worth-my-hour` agent (.claude/agents/worth-my-hour.md).
 *
 * THE BUDGET. The agent has 10 minutes end to end: find -> score -> draft. Every token it spends
 * should go to JUDGMENT (scoring 8 roles, writing 2 outreach specs), never to SEARCH. So every
 * mechanical step lives here, and each subcommand prints a <=15-line summary plus one JSON file.
 * The agent reads the JSON, never the raw TSVs.
 *
 *   find          sweep every ATS board in data/company-index.tsv (pure HTTP, ~90s for ~1,700
 *                 boards), retry the boards that timed out, widen honestly if the day is thin,
 *                 pre-rank primary-role-first (targets.primary_role), fetch the canonical JD for the top N, snapshot it to data/jds/,
 *                 and write a compact digest + hard-gate flags per role -> {run}/shortlist.json
 *   contacts      free contact plan for one role (ATS org data, cached roster, email domain);
 *                 NO LinkedIn, NO paid lookups -> {run}/contacts-{slug}.json
 *   record        append the agent's scores to data/scored-jobs.tsv (record-scored.mjs, source
 *                 `hunt`) and re-sync qualifiers.tsv (reconcile-qualifiers.mjs)
 *   log-outreach  append drafted outreach to data/outreach-log.tsv (same 10 columns
 *                 drain-outreach.mjs writes, so outreach-owed stops counting the job)
 *
 * WHY A SECOND SWEEP INSTEAD OF SPAWNING scan-index.mjs. Measured 2026-09-29: scan-index swept
 * 1,687 boards in ~90s and 120-150 of them FAILED every run, including OpenAI, Figma, Ramp and
 * Plaid — "This operation was aborted", i.e. the 10s FETCH_TIMEOUT_MS in scan-core fired on the
 * heaviest Greenhouse ?content=true payloads. scan-index names only the first 15 and moves on, so
 * a run that could not see OpenAI reads the same as a quiet day (the dead-lane-vs-quiet-market
 * failure family). This sweep reuses scan-core's detection, parsers and filters unchanged, then
 * RETRIES every timeout once at low concurrency with a 30s budget, and reports what stayed blind.
 * It also never writes company-index.tsv: last_scanned bookkeeping stays with the crons.
 *
 * ROOT. Dependencies load from CAREER_OPS_ROOT (default: this file's repo) and the process chdirs
 * there, because every career-finder script resolves data/ relative to cwd. Target roles, the
 * primary role, location policy and the qualifying score all come from config/profile.yml
 * (scripts/targets.mjs); nothing about a specific career is hard-coded here.
 *
 * --demo on any subcommand reads frozen fixtures from
 * output/hunt/demo-fixture/ (local only, gitignored) and writes NOTHING to data/.
 *
 * Usage:
 *   node scripts/hunt.mjs find [--role "Data Engineer,Analytics Engineer"] [--hours 24] [--min 8] [--top 8] [--demo]
 *   node scripts/hunt.mjs contacts --company X --role Y --url U [--run DIR] [--demo]
 *   node scripts/hunt.mjs record <scores.json> [--demo]
 *   node scripts/hunt.mjs log-outreach <drafts.json> --company X --role Y --url U [--demo]
 *   node scripts/hunt.mjs clock [stage]      # stamp a lap, print elapsed (the clock starts at find)
 */

import { loadTargets } from './targets.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { tracked as trackedFetch } from './request-ledger.mjs'; // every outbound request is counted

const ROOT = (process.env.CAREER_OPS_ROOT
  ? path.resolve(process.env.CAREER_OPS_ROOT)
  : path.resolve(new URL('..', import.meta.url).pathname)) + '/';
process.chdir(ROOT);

const argv = process.argv.slice(2);
const CMD = argv[0];
const flag = (f) => argv.includes(f);
const val = (f, d = '') => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const DEMO = flag('--demo');
// Local-only on purpose: output/ is gitignored, and the Greptile fixture names real people.
const DEMO_DIR = 'output/hunt/demo-fixture';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${localDate(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const T0 = Date.now();
const secs = () => +((Date.now() - T0) / 1000).toFixed(1);

// Classifier driven by config/profile.yml: 'primary' = targets.primary_role, 'target' = any other
// targets.roles / title_keywords match, else 'other'. RF is role-filters.mjs, loaded from ROOT.
let RF = null;
function archetype(role) {
  if (!RF) return 'other';
  if (RF.isPrimaryRole(role)) return 'primary';
  if (RF.titleMatches(role)) return 'target';
  return 'other';
}
// The primary role ranks first, then the other configured target titles.
const ARCH_RANK = { primary: 3, target: 2, other: 1 };

// ── --role: search for any role the user names, beyond the configured targets ──────────────
// Without --role the sweep uses the configured title filter (targets.roles + title_keywords)
// and the primary-first rank above. With it,
// titles are matched to the requested role(s) instead. Returns 0 (no match), 1 (every word of
// the role appears), or 2 (the whole phrase or a known abbreviation appears), so exact matches rank first.
// GENERIC abbreviation table (cross-industry examples, not targets): lets `--role sdr` or
// `--role de` match the spelled-out title. Extend freely; it only widens --role matching.
// Small cross-industry shorthand table; the user's own roles + title_keywords from
// config/profile.yml are layered on top by profileAliases() so a hunt for any profile title also
// matches its posted synonyms.
const ROLE_ALIASES = {
  sdr: ['sales development representative', 'sales development rep', 'sdr'],
  bdr: ['business development representative', 'business development rep', 'bdr'],
  ae: ['account executive'],
  am: ['account manager'],
  se: ['sales engineer', 'solutions engineer'],
  sa: ['solutions architect'],
  fde: ['forward deployed engineer', 'forward deployed', 'fde'],
  csm: ['customer success manager', 'csm'],
  cse: ['customer success engineer'],
  tam: ['technical account manager', 'tam'],
  pm: ['product manager'],
  pmm: ['product marketing manager', 'pmm'],
  swe: ['software engineer'],
  de: ['data engineer'],
  ds: ['data scientist'],
  mle: ['machine learning engineer', 'ml engineer'],
  sre: ['site reliability engineer', 'sre'],
  rn: ['registered nurse'],
  np: ['nurse practitioner'],
  lpn: ['licensed practical nurse'],
  pa: ['physician assistant'],
  tpm: ['technical program manager'],
  ux: ['ux designer', 'product designer', 'ux researcher'],
  ea: ['executive assistant'],
  hrbp: ['hr business partner', 'human resources business partner'],
  cpa: ['certified public accountant', 'staff accountant'],
};
function profileAliases() {
  try {
    const t = loadTargets().targets;
    const syn = [...t.roles, ...t.title_keywords].map(x => x.toLowerCase().trim()).filter(Boolean);
    return syn.length ? [syn] : [];
  } catch { return []; } // not set up (or --demo): the static table alone
}
const STOP = new Set(['of', 'the', 'and', '&', '-', 'a', 'an', 'for', 'in']);
const SENIOR = /\b(director|vice president|vp|head of|chief|principal|intern|internship)\b/i;
export function buildRoleMatcher(roles) {
  const profile = profileAliases();
  const specs = roles.map(r => {
    const low = r.toLowerCase().trim();
    const phrases = [low, ...(ROLE_ALIASES[low] || [])];
    for (const [k, v] of Object.entries(ROLE_ALIASES)) if (v.includes(low)) phrases.push(k, ...v);
    for (const group of profile) if (group.some(g => g === low || (ROLE_ALIASES[low] || []).includes(g))) phrases.push(...group);
    const words = low.split(/[\s,/]+/).filter(w => w && !STOP.has(w));
    return { low, phrases: [...new Set(phrases)], words, allowSenior: SENIOR.test(low) };
  });
  const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return (title) => {
    const t = String(title || '');
    let best = 0;
    for (const s of specs) {
      if (!s.allowSenior && SENIOR.test(t)) continue;
      // A leading "Manager," is a people-leadership req unless the role itself is a manager role.
      if (!/manager/.test(s.low) && /^\s*manager\b/i.test(t)) continue;
      if (s.phrases.some(p => (p.length <= 4 ? new RegExp(`\\b${p}\\b`, 'i') : wordRe(p)).test(t))) best = Math.max(best, 2);
      // Partial = every word of the role, IN ORDER, other words allowed between ("Product
      // Marketing Manager" for "Product Manager"). Order matters: "Manager, Product Operations"
      // is a different job.
      else if (s.words.length && new RegExp(s.words.map(w => `\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('[\\s\\S]*'), 'i').test(t)) best = Math.max(best, 1);
    }
    return best;
  };
}

function runDir() {
  const d = `output/hunt/${stamp()}${DEMO ? '-demo' : ''}`;
  mkdirSync(d, { recursive: true });
  writeFileSync('output/hunt/LATEST', d + '\n');
  return d;
}
function latestRun() {
  const explicit = val('--run');
  if (explicit) return explicit;
  if (existsSync('output/hunt/LATEST')) return readFileSync('output/hunt/LATEST', 'utf-8').trim();
  return runDir();
}

// ── JD digest + hard-gate flags ──────────────────────────────────────────────────────────
// The agent scores from these, so they must carry the lines a gate lives on. Section headers
// vary wildly; take the first requirements-shaped block, plus the opening summary.
// Strongest requirement headers first; "experience" alone is a last resort (it also heads prose).
const REQ_HDRS = [
  /^(minimum|basic|required) qualifications\b/i,
  /^(requirements|qualifications|must.?haves?)\b/i,
  /^(you (might|may|could) be a (good |great |strong )?fit|you('re| are) a (good |great )?fit|strong candidates|ideal candidate)/i,
  /^(what you('| wi)ll bring|what you bring|what we('re| are) looking for|who you are|about you|you have|you bring|your background|what you need)/i,
  /^(skills (and|&) experience|experience)\b/i,
];
const LANGS = 'spanish|portuguese|french|german|japanese|mandarin|chinese|korean|italian|dutch|hebrew|arabic|hindi|cantonese|vietnamese|russian|polish|turkish';
// Greenhouse content is double-encoded, so entities survive one toText pass.
const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;|&ndash;/g, '-').replace(/&[a-z]+;/g, ' ');

export function digestOf(body, { title = '', loc = '' } = {}) {
  const text = decode(body).replace(/\r/g, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const clean = (l) => l.replace(/[:*#]/g, '').replace(/^-\s*/, '').trim();
  let hi = -1;
  for (const re of REQ_HDRS) { hi = lines.findIndex(l => l.length < 90 && re.test(clean(l))); if (hi !== -1) break; }
  const summary = lines.slice(0, hi > 0 ? Math.min(hi, 4) : 4).join(' ').slice(0, 280);
  const reqs = hi >= 0 ? lines.slice(hi, hi + 22).join('\n') : lines.slice(4, 26).join('\n');
  const comp = (text.match(/\$\s?\d{2,3}(,\d{3}|k|K)[^\n]{0,60}/) || [''])[0].trim();
  let digest = `${title} | ${loc}\n${summary}\n--- requirements ---\n${reqs}`;
  if (comp) digest += `\n--- comp ---\n${comp}`;
  return digest.slice(0, 1200);
}

export function gateFlags(body, { loc = '', isRemote } = {}) {
  const t = decode(body);
  const years = [...t.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2}\s*)?\+?\s*(?:years|yrs)/gi)]
    .map(m => parseInt(m[1], 10)).filter(n => n > 0 && n < 25);
  const lang = t.match(new RegExp(`(fluen\\w*|native|proficien\\w*|business.level)[^.\\n]{0,40}\\b(${LANGS})\\b|\\b(${LANGS})\\b[^.\\n]{0,30}(fluen\\w*|required|proficien\\w*)`, 'i'));
  const clearance = t.match(/(security clearance|ts\/sci|secret clearance|clearance required|must be a u\.?s\.? citizen|u\.?s\.? citizenship (is )?required)/i);
  const sponsorship = t.match(/((unable|not able) to sponsor|will not sponsor|cannot sponsor|no (visa )?sponsorship|sponsorship is not available)/i);
  // Staffing relists name an anonymous client (memory: MethodHub, Ahura, Emergere). A real
  // employer says "our clients" about its customers all the time, so bare "our client" is NOT a
  // signal; the header forms and the on-behalf-of phrasings are.
  const staffing = t.match(/((^|\n)\s*(duration|client|contract length)\s*:|on behalf of (our|a|one of our) client|our client,? (is )?(a|an) |for (a|our) (leading |fast.growing )?client\b|our customer is (a|an) |\b(c2c|corp.to.corp|w2 only)\b)/i);
  const remoteText = /\b(remote)\b/i.test(`${loc} ${t.slice(0, 1500)}`);
  return {
    years_gate: years.length ? Math.max(...years) : null,
    language: lang ? lang[0].slice(0, 80) : null,
    clearance: clearance ? clearance[0] : null,
    sponsorship: sponsorship ? sponsorship[0] : null,
    staffing_signal: staffing ? staffing[0].trim().slice(0, 60) : null,
    remote_scope: isRemote === true ? 'ATS isRemote=true (verify)' : (remoteText ? 'mentions remote (verify scope)' : 'onsite/hybrid per posting'),
  };
}

// ── find ──────────────────────────────────────────────────────────────────────────────────
async function cmdFind() {
  const HOURS = parseFloat(val('--hours', '24'));
  const MIN = parseInt(val('--min', '8'), 10);
  const TOP = parseInt(val('--top', '8'), 10);
  const dir = runDir();
  clockStamp(dir, '');   // the 10-minute clock starts at find

  if (DEMO) {
    const src = `${DEMO_DIR}/shortlist.json`;
    if (!existsSync(src)) { console.error(`demo fixture missing: ${src}`); process.exit(2); }
    const s = JSON.parse(readFileSync(src, 'utf-8'));
    s.run = dir; s.demo = true;
    writeFileSync(`${dir}/shortlist.json`, JSON.stringify(s, null, 2));
    writeFileSync(`${dir}/timing.json`, JSON.stringify({ find_s: secs(), demo: true }, null, 2));
    console.log(`DEMO shortlist: ${s.roles.length} roles (frozen fixture) -> ${dir}/shortlist.json`);
    return;
  }

  const sc = await import(ROOT + 'scripts/scan-core.mjs');
  const rf = await import(ROOT + 'scripts/role-filters.mjs');
  rf.requireTargets();
  RF = rf;
  const sj = await import(ROOT + 'scripts/snapshot-jd.mjs');

  const ROLES = val('--role') ? val('--role').split(',').map(s => s.trim()).filter(Boolean) : [];
  const roleMatch = ROLES.length ? buildRoleMatcher(ROLES) : null;
  const titleOk = roleMatch
    ? (t => roleMatch(t) > 0)
    : (t => rf.titleMatches(t));
  const locOk = sc.buildLocationFilter();
  const noise = rf.loadNoise();
  const never = typeof rf.loadNeverApply === 'function' ? rf.loadNeverApply() : [];
  const blocked = (co) => { const c = String(co || '').toLowerCase(); return noise.some(n => c.includes(n)) || never.some(n => c.includes(n)); };
  const seenUrls = sc.loadSeenUrls();
  const seenRoles = sc.loadSeenCompanyRoles();

  const idx = readFileSync('data/company-index.tsv', 'utf-8').split('\n');
  const hdr = idx[0].split('\t');
  const boards = idx.slice(1).filter(Boolean).map(l => { const c = l.split('\t'); return Object.fromEntries(hdr.map((h, i) => [h, c[i] ?? ''])); })
    .filter(r => r.ats_api_url);

  // Everything that passes every filter EXCEPT recency, so widening never refetches.
  const pool = [];
  const failed = [];
  const accept = (r, api, json) => {
    const jobs = sc.PARSERS[api.type](json, r.company, api);
    for (const job of jobs) {
      if (blocked(r.company || job.company)) continue;
      if (!titleOk(job.title)) continue;
      if (/\b(remote|work from home|wfh|distributed|anywhere)\b/i.test(job.title) && !/hybrid/i.test(job.title)
          && !rf.remoteOkFor(job.title, `${job.title} ${job.location || ''}`)) continue;
      if (!locOk(job.location, job.title, job.offices)) continue;
      if (seenUrls.has(sc.dedupUrlKey(job.url))) continue;
      const key = `${String(job.company).toLowerCase()}::${String(job.title).toLowerCase()}`;
      if (seenRoles.has(key)) continue;
      seenUrls.add(sc.dedupUrlKey(job.url)); seenRoles.add(key);
      pool.push({ ...job, ats: api.type });
    }
  };

  const tasks = boards.map(r => {
    const t = async () => {
      const api = sc.detectApi({ api: r.ats_api_url, careers_url: r.careers_url });
      if (!api || !sc.PARSERS[api.type]) return;
      try { accept(r, api, await sc.fetchProvider(api)); }
      catch (e) { failed.push({ r, api, err: String(e.message || e) }); }
    };
    t.host = typeof sc.taskHost === 'function' ? sc.taskHost(r.ats_api_url) : (() => { try { return new URL(r.ats_api_url).host; } catch { return ''; } })();
    return t;
  });
  // perHost 5 (scan-index uses 8): Ashby answers 8-wide with ~45 HTTP 429s per sweep, measured 2026-09-29.
  await sc.parallelFetch(tasks, 24, { perHost: 5 });
  const sweepS = secs();

  // Retry transient failures once: slow, patient, low concurrency. A 404 is a migrated board
  // (repair-index's job), not a transient, so it is not retried.
  // Workable's widget API answers 429 even to a lone curl (verified 2026-09-29 on Moveworks,
  // Pony.ai, LGND AI) and the index already records those rows as "error: HTTP 429". Waiting
  // does not fix it, so they are named as a CHRONIC blind spot instead of burning a minute.
  const chronic = failed.filter(f => /apply\.workable\.com/.test(f.r.ats_api_url) && /429/.test(f.err));
  const migrated = failed.filter(f => /HTTP 404|HTTP 410/.test(f.err));
  const transient = failed.filter(f => !chronic.includes(f) && (!/HTTP 4\d\d/.test(f.err) || /HTTP 429/.test(f.err)));
  const slowFetch = async (api) => {
    if (api.type === 'workday') return sc.fetchWorkday(api.url);
    const url = api.type === 'greenhouse' ? sc.withGreenhouseContent(api.url) : api.url;
    const res = await trackedFetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Mozilla/5.0 career-finder-hunt' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return sc.XML_PROVIDERS?.has(api.type) ? res.text() : res.json();
  };
  // Most "transient" failures are Ashby 429s caused by the 24-wide sweep itself (measured
  // 2026-09-29: 44 of 48), so back off, go one-at-a-time per host, and give 429s up to three
  // rounds. Bounded at ~60s so the 10-minute budget holds even on a bad day.
  let recovered = 0;
  let pending = transient;
  const RETRY_WAIT = [8_000, 15_000, 20_000];
  for (let round = 0; round < RETRY_WAIT.length && pending.length && secs() - sweepS < 60; round++) {
    await new Promise(r => setTimeout(r, RETRY_WAIT[round]));
    const next = [];
    const retryTasks = pending.map(f => {
      const t = async () => {
        try { accept(f.r, f.api, await slowFetch(f.api)); recovered++; }
        catch (e) { next.push({ ...f, err: String(e.message || e) }); }
      };
      t.host = (() => { try { return new URL(f.r.ats_api_url).host; } catch { return ''; } })();
      return t;
    });
    await sc.parallelFetch(retryTasks, 4, { perHost: 1 });
    pending = next;
  }
  const stillBlind = pending.map(f => `${f.r.company} (${f.err.slice(0, 40)})`);
  const retryS = +(secs() - sweepS).toFixed(1);

  // Windows: fresh first, widen to 72h only if thin. Never relabel a 72h find as fresh.
  const now = Date.now();
  const ageH = (j) => (j.postedAt ? (now - j.postedAt.getTime()) / 3600e3 : Infinity);
  const fresh = pool.filter(j => ageH(j) <= HOURS).map(j => ({ ...j, lane: `fresh-${HOURS}h` }));
  let picked = fresh;
  // Default mode widens to 72h once (the configured targets have scored inventory to fall back
  // on). A named --role has no scored history, so it keeps widening (7d, 14d, 30d) until it has
  // --min roles: a role can have many open reqs in the index and none inside 72h.
  // Every step keeps its true age label; a 30-day req is never reported as fresh.
  const ladder = roleMatch ? [72, 168, 336, 720] : [72];
  let lo = HOURS;
  for (const hi of ladder) {
    if (picked.length >= MIN || hi <= lo) continue;
    picked = picked.concat(pool.filter(j => ageH(j) > lo && ageH(j) <= hi).map(j => ({ ...j, lane: `widened-${hi}h` })));
    lo = hi;
  }

  const rank = (j) => (roleMatch ? roleMatch(j.title) : (ARCH_RANK[archetype(j.title)] || 1)) * 1e6 - Math.min(ageH(j), 999_999);
  picked.sort((a, b) => rank(b) - rank(a));

  // Aged inventory: already scored >= pipeline.qualify_score, still open, never applied. Fills a thin day with real,
  // actionable roles WITHOUT spending scoring tokens (they carry their prior score).
  let aged = [];
  if (picked.length < MIN) {
    // Default mode fills from the primary-role lane; a named role fills from any aged qualifier matching it.
    const u = spawnSync('node', ['scripts/unclaimed-inventory.mjs', ...(roleMatch ? [] : ['--primary-only']), '--json'], { encoding: 'utf-8', timeout: 150_000, maxBuffer: 32 << 20 });
    try {
      const live = (JSON.parse(u.stdout).live || []).filter(r => r.status === 'untracked' || r.status === 'evaluated')
        .filter(r => !roleMatch || roleMatch(r.role) > 0);
      const seen = new Set();
      aged = live.filter(r => { const k = norm(r.company) + norm(r.role); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, MIN - picked.length);
    } catch { /* inventory unavailable is not fatal; reported below */ }
  }

  // Fetch the canonical JD for the top TOP fresh/widened roles; a closed req pulls the next one.
  const have = existsSync('data/jds') ? readdirSync('data/jds') : [];
  if (!existsSync('data/jds')) mkdirSync('data/jds', { recursive: true });
  const roles = [];
  const queue = picked.slice();
  let closed = 0;
  while (roles.length < TOP && queue.length) {
    const batch = queue.splice(0, Math.min(6, TOP - roles.length));
    const got = await Promise.all(batch.map(async (j) => {
      let p = null;
      try { p = await sj.fetchPosting(j.url, j.title); } catch (e) { p = { error: String(e.message || e) }; }
      return { j, p };
    }));
    for (const { j, p } of got) {
      if (p?.closed) { closed++; continue; }
      const ok = p && p.body;
      let snapshot = null;
      if (ok) {
        const name = `${slug(j.company)}-${slug(p.title || j.title)}-${p.a?.jobId || 'na'}.md`;
        snapshot = `data/jds/${name}`;
        if (!have.includes(name)) {
          const md = `# ${j.company} — ${p.title || j.title}\n\n`
            + `**Req ID:** ${p.a?.jobId || 'n/a'}  \n**URL:** ${p.url || j.url}  \n`
            + `**Location:** ${p.loc || j.location || 'n/a'}${p.remote === true ? '  ⚠ ATS isRemote=true' : ''}  \n`
            + `**Published:** ${p.pub || (j.postedAt ? j.postedAt.toISOString() : 'n/a')}  \n${p.upd ? `**Updated:** ${p.upd}  \n` : ''}`
            + `**Score at snapshot:** pending (hunt)  \n**Snapshot taken:** ${new Date().toISOString()}  \n`
            + `**Source:** ${p.a?.atsType || j.ats}${p.via ? ` via ${p.via}` : ' posting API'}\n\n---\n\n${p.body}\n`;
          writeFileSync(snapshot, md);
        }
      }
      roles.push({
        id: `R${roles.length + 1}`,
        company: j.company, role: j.title, location: j.location, url: p?.url || j.url, ats: j.ats,
        posted: j.postedAt ? j.postedAt.toISOString() : null,
        age_hours: Number.isFinite(ageH(j)) ? Math.round(ageH(j)) : null,
        lane: j.lane, archetype: roleMatch ? (roleMatch(j.title) === 2 ? 'target' : 'target-partial') : archetype(j.title),
        jd_status: ok ? 'ok' : 'unavailable',
        jd_note: ok ? undefined : (p?.unsupported ? `${p.unsupported} board not queryable` : (p?.error || 'no JD recoverable')),
        snapshot,
        digest: ok ? digestOf(p.body, { title: p.title || j.title, loc: p.loc || j.location }) : null,
        flags: ok ? gateFlags(p.body, { loc: p.loc || j.location, isRemote: p.remote }) : null,
      });
    }
  }
  for (const r of aged) {
    roles.push({
      id: `A${roles.length + 1}`, company: r.company, role: r.role, url: r.url, lane: 'aged-inventory',
      archetype: r.archetype || archetype(r.role), age_days: r.ageDays,
      prior: { score: r.score, why: r.why, tracker_status: r.status },
      jd_status: 'already-scored',
    });
  }

  const out = {
    run: dir, generated_at: new Date().toISOString(), window_hours: HOURS,
    target_roles: ROLES.length ? ROLES : 'default (targets.roles from config/profile.yml, primary role first)',
    counts: { boards: boards.length, pool_all_ages: pool.length, fresh: fresh.length, widened: picked.length - fresh.length, widened_to_hours: lo, closed_skipped: closed, aged_filled: aged.length, returned: roles.length },
    blind: { failed: failed.length, migrated_404: migrated.length, chronic_workable_429: chronic.length, retried: transient.length, recovered, still_blind: stillBlind.length, still_blind_boards: stillBlind.slice(0, 25) },
    roles,
  };
  writeFileSync(`${dir}/shortlist.json`, JSON.stringify(out, null, 2));
  writeFileSync(`${dir}/timing.json`, JSON.stringify({ sweep_s: sweepS, retry_s: retryS, find_total_s: secs() }, null, 2));

  console.log(`hunt find: ${boards.length} boards in ${sweepS}s; ${failed.length} failed = ${migrated.length} migrated (404) + ${chronic.length} chronic Workable 429 + ${transient.length} transient (${recovered} recovered in ${retryS}s, ${stillBlind.length} STILL BLIND)`);
  console.log(`target: ${ROLES.length ? ROLES.join(' | ') : 'default configured targets'}`);
  console.log(`pool: ${fresh.length} fresh (<=${HOURS}h), ${picked.length - fresh.length} widened (to ${lo}h), ${aged.length} aged-inventory fill, ${closed} closed skipped`);
  for (const r of roles.slice(0, 10)) {
    const f = r.flags || {};
    const gates = [f.years_gate ? `${f.years_gate}y` : '', f.language ? 'LANG' : '', f.clearance ? 'CLEAR' : '', f.staffing_signal ? 'STAFFING' : ''].filter(Boolean).join(',');
    console.log(`  ${r.id} [${r.archetype}/${r.lane}] ${r.company} | ${r.role}${r.prior ? ` | prior ${r.prior.score}` : ''}${gates ? ` | gates:${gates}` : ''}${r.jd_status === 'unavailable' ? ' | JD UNAVAILABLE' : ''}`);
  }
  console.log(`-> ${dir}/shortlist.json  (${secs()}s total)`);
}

// ── contacts ──────────────────────────────────────────────────────────────────────────────
// Roster rows carry a cardTag (recruiter / hm / leader ...), drafts carry a persona name.
function personaOf(tag, title = '') {
  const s = `${tag} ${title}`.toLowerCase();
  if (/peer/.test(tag.toLowerCase())) return null;
  if (/recruit|talent|sourc/.test(s)) return 'Recruiter';
  if (/leader|\bvp\b|vice president|chief|cro|ceo|cto|founder|head of/.test(s)) return 'Leader';
  if (/\bhm\b|hiring manager|manager|director|lead/.test(s)) return 'Hiring Manager';
  return null;
}

function cmdContacts() {
  const company = val('--company'), role = val('--role'), url = val('--url');
  if (!company) { console.error('usage: hunt.mjs contacts --company X --role Y --url U [--run DIR] [--demo]'); process.exit(2); }
  const dir = latestRun();
  const outPath = `${dir}/contacts-${slug(company)}.json`;

  if (DEMO) {
    const src = `${DEMO_DIR}/contacts-${slug(company)}.json`;
    const c = existsSync(src) ? JSON.parse(readFileSync(src, 'utf-8')) : { company, role, named: [], note: 'no demo fixture for this company' };
    writeFileSync(outPath, JSON.stringify(c, null, 2));
    console.log(`DEMO contacts: ${company}: ${(c.named || []).length} named, target title "${c.hm_title_hint || 'n/a'}" -> ${outPath}`);
    return;
  }

  const cp = spawnSync('node', ['scripts/contact-plan.mjs', '--company', company, '--role', role, '--jd-url', url, '--json'], { encoding: 'utf-8', timeout: 60_000 });
  let plan = null;
  try { plan = JSON.parse(cp.stdout); } catch { /* reported below */ }

  const teamEv = (plan?.evidence || []).find(e => /ATS org:/.test(e)) || '';
  const team = ((teamEv.match(/team="([^"]+)"/) || teamEv.match(/department="([^"]+)"/) || [])[1] || "").replace(/^\d+\s+/, "") || null;
  const rung1 = (plan?.plan || []).find(p => p.rung === 1)?.detail || '';
  const hmHint = ((rung1.match(/Address the hiring manager as:\s*([^.]+)/) || [])[1] || (team ? `Head of ${team}` : 'Hiring Manager'))
    .replace(/\b\d{3,}\s+/g, '');
  const liFollowup = (plan?.plan || []).filter(p => /search|pageview|profile/i.test(p.cost || '')).map(p => `${p.action}: ${p.detail}`).slice(0, 2);

  // li-slugs.tsv: company \t linkedin slug \t email domain
  let liSlug = null, domain = null;
  if (existsSync('data/li-slugs.tsv')) {
    for (const line of readFileSync('data/li-slugs.tsv', 'utf-8').split('\n')) {
      const [co, sl, dom] = line.split('\t');
      if (co && norm(co) === norm(company)) { liSlug = (sl || '').trim() || null; domain = (dom || '').trim() || null; break; }
    }
  }
  // A cached roster is the only free source of NAMED people. Same usability + 30-day freshness
  // rule drain-outreach.mjs applies (partial or selection-less rosters are not usable).
  let roster = null;
  for (const sl of [liSlug, slug(company)].filter(Boolean)) {
    const p = `data/rosters/${sl}.json`;
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      const ageDays = (Date.now() - statSync(p).mtimeMs) / 86400e3;
      const usable = d.partial !== true && Array.isArray(d.selection) && d.selection.length > 0;
      roster = { slug: sl, path: p, fresh: ageDays <= 30, usable,
        selection: usable ? d.selection.slice(0, 6).map(s => ({ persona: s.persona, name: s.name, title: String(s.title || s.headline || '').slice(0, 100) })) : [] };
      break;
    } catch { /* unreadable roster: treat as absent */ }
  }
  const named = [];
  const seenNames = new Set();
  const add = (p) => { const k = norm(p.name); if (!k || seenNames.has(k)) return; seenNames.add(k); named.push(p); };
  if (roster?.usable && roster.fresh) for (const s of roster.selection) {
    const persona = personaOf(s.persona || s.cardTag || '', s.title);
    if (persona) add({ persona, name: s.name, title: s.title, source: `roster ${roster.path}` });
  }

  // Prior drafts: 129+ output/outreach/*.drafts.json files already name real people (with the
  // email and its confidence) at companies worked before. Free, and usually better than a guess.
  // Peers are dropped (no Peer persona in outreach, set 2026-08-25).
  const prefix = `${slug(company)}-`;
  const prior = existsSync('output/outreach')
    ? readdirSync('output/outreach').filter(f => f.startsWith(prefix) && f.endsWith('.drafts.json'))
      .map(f => ({ f, t: statSync(`output/outreach/${f}`).mtimeMs })).sort((a, b) => b.t - a.t)
    : [];
  for (const { f } of prior.slice(0, 3)) {
    try {
      const d = JSON.parse(readFileSync(`output/outreach/${f}`, 'utf-8'));
      for (const p of d.personas || []) {
        if (!/hiring manager|recruiter|leader/i.test(p.persona || '')) continue;
        const t = p.target || {};
        add({ persona: p.persona, name: t.name, title: t.headline || '', email: t.email || '', email_confidence: t.email_confidence || '', source: `prior draft output/outreach/${f}` });
      }
    } catch { /* unreadable draft: skip */ }
  }

  // Already-contacted check: never cold-open the same person twice for a different req.
  const contacted = existsSync('data/outreach-log.tsv')
    ? readFileSync('data/outreach-log.tsv', 'utf-8').split('\n').filter(l => norm(l.split('\t')[1]) === norm(company))
      .map(l => { const c = l.split('\t'); return `${c[0]} ${c[2]} -> ${c[5]} [${c[4]}] status=${c[8] || ''}`; }).slice(-6)
    : [];

  // Where the user already stands with this employer (applications.md: | # | date | company | role |
  // score | status | ...). An Applied/Interview row means the relationship is live: no cold outreach.
  const tracker = existsSync('data/applications.md')
    ? readFileSync('data/applications.md', 'utf-8').split('\n').filter(l => l.startsWith('|'))
      .map(l => l.split('|').map(c => c.trim())).filter(c => norm(c[3]) === norm(company))
      .map(c => ({ num: c[1], date: c[2], role: c[4], status: c[6] }))
    : [];
  const inProcess = tracker.filter(t => /^(Applied|Responded|Interview|Offer)$/i.test(t.status));
  // Same req already drafted (the drafts filename is {company}-{role}-{date}); a redraft is only
  // useful if the old one was never sent, so say it instead of silently doubling the drafts.
  const roleSlug = slug(role);
  const sameReqDrafts = prior.map(p => p.f).filter(f => f.startsWith(`${prefix}${roleSlug}-`));

  const out = {
    company, role, url, team, hm_title_hint: hmHint.trim(), domain, linkedin_slug: liSlug,
    roster: roster ? { path: roster.path, fresh: roster.fresh, usable: roster.usable } : null,
    named: named.slice(0, 4),
    tracker,
    in_process: inProcess.length > 0,
    same_req_already_drafted: sameReqDrafts,
    previously_contacted: contacted,
    reachable: named.length > 0,
    linkedin_followup_main_session: liFollowup,
    note: named.length ? 'named contacts from a fresh cached roster; gen-outreach can use_roster'
      : 'no named contact from free sources; draft to the title with a placeholder name, LinkedIn discovery is a main-session follow-up',
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`contacts: ${company}: team=${team || 'n/a'}; ${out.named.length} named (${roster ? 'roster' : 'no roster'}, ${prior.length} prior draft file(s)); ${contacted.length} prior outreach line(s); target title "${out.hm_title_hint}"`);
  for (const p of out.named) console.log(`  ${p.persona}: ${p.name} | ${String(p.title).slice(0, 60)}${p.email ? ` | ${p.email}` : ''}`);
  if (inProcess.length) console.log(`  IN PROCESS: ${inProcess.map(t => `${t.role} = ${t.status}`).join('; ')} -> do not cold-outreach`);
  if (sameReqDrafts.length) console.log(`  ALREADY DRAFTED for this req: ${sameReqDrafts.join(', ')}`);
  console.log(`-> ${outPath}`);
}

// ── record ────────────────────────────────────────────────────────────────────────────────
// Agent verdicts -> the scored-jobs.tsv verdict vocabulary the dashboard + quota read.
// QUALIFY = pipeline.qualify_score; "near" is the half-point band below it.
function ledgerVerdict(s, QUALIFY = 4.3) {
  const v = String(s.verdict || '').toUpperCase();
  if (/CAN'?T TELL/.test(v)) return s.closed ? 'stale' : 'pass';
  if (/SKIP/.test(v)) return 'SKIP';
  const n = parseFloat(s.score);
  if (n >= QUALIFY) return 'QUALIFIED';
  if (n >= QUALIFY - 0.5) return 'near';
  return 'pass';
}
async function cmdRecord() {
  const tg = await import(ROOT + 'scripts/targets.mjs');
  tg.requireTargets();
  const QUALIFY = tg.loadTargets().pipeline.qualify_score;
  const file = argv[1];
  if (!file) { console.error('usage: hunt.mjs record <scores.json> [--demo]'); process.exit(2); }
  if (!existsSync(file)) { console.error(`record: scores file not found: ${file} (write it first; paths are relative to ${ROOT})`); process.exit(2); }
  const scores = JSON.parse(readFileSync(file, 'utf-8'));
  const rows = (Array.isArray(scores) ? scores : scores.roles || []).filter(s => s.lane !== 'aged-inventory');
  const today = localDate();
  let n = 0;
  for (const s of rows) {
    const lv = ledgerVerdict(s, QUALIFY);
    const why = `[${s.verdict}] ${String(s.why || '').replace(/[\t\n]+/g, ' ')}`.slice(0, 400);
    if (DEMO) { console.log(`DEMO (not written): ${s.company} | ${s.role} | ${s.score} | ${lv}`); continue; }
    const r = spawnSync('node', ['scripts/record-scored.mjs', today, s.company, s.role, String(s.score), lv, why, s.url, '', 'hunt'], { encoding: 'utf-8' });
    process.stdout.write(r.stdout.split('\n').filter(Boolean).slice(-1).join('') + '\n');
    n++;
  }
  if (!DEMO && n) {
    spawnSync('node', ['scripts/reconcile-qualifiers.mjs'], { encoding: 'utf-8', timeout: 60_000 });
    console.log(`recorded ${n} row(s) with source=hunt; qualifiers.tsv reconciled`);
  }
}

// ── log-outreach ──────────────────────────────────────────────────────────────────────────
// Mirrors drain-outreach.mjs step 5 (10 columns). Kept identical so outreach-owed.mjs treats a
// hunt-drafted job exactly like a drain-drafted one.
function cmdLogOutreach() {
  const file = argv[1];
  const company = val('--company'), role = val('--role'), url = val('--url');
  if (!file || !existsSync(file) || !company) { console.error('usage: hunt.mjs log-outreach <drafts.json> --company X --role Y --url U [--demo]'); process.exit(2); }
  const dj = JSON.parse(readFileSync(file, 'utf-8'));
  const html = file.replace(/\.drafts\.json$/, '.html');
  const today = localDate();
  const lines = [];
  for (const p of dj.personas || []) for (const ch of p.channels || []) {
    lines.push([today, company, role, p.persona, ch.channel, `${p.target?.name || '(unnamed)'} (${p.persona}): hunt draft, gold/silver/bronze`, url || '', html, 'pending', 'pending'].join('\t'));
  }
  if (DEMO) { console.log(`DEMO (not written): ${lines.length} outreach-log line(s) for ${company}`); return; }
  if (lines.length) {
    const prev = existsSync('data/outreach-log.tsv') ? readFileSync('data/outreach-log.tsv', 'utf-8') : '';
    writeFileSync('data/outreach-log.tsv', prev + (prev && !prev.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
  }
  console.log(`logged ${lines.length} outreach line(s) for ${company} | ${role}`);
}

// ── clock ─────────────────────────────────────────────────────────────────────────────────
// Shell state does not persist between the agent's tool calls, so the 10-minute clock lives in
// {run}/clock.json. `find` starts it; `clock <stage>` stamps a lap and prints elapsed mm:ss.
const mmss = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
function clockStamp(dir, stage) {
  const p = `${dir}/clock.json`;
  const c = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : { start: Date.now(), laps: [] };
  const el = (Date.now() - c.start) / 1000;
  if (stage) c.laps.push({ stage, at_s: +el.toFixed(1) });
  writeFileSync(p, JSON.stringify(c, null, 2));
  return { el, c };
}
function cmdClock() {
  const stage = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
  const { el, c } = clockStamp(latestRun(), stage);
  // `clock <stage>` is called as a stage BEGINS, so segment i (lap i-1 -> lap i) belongs to the
  // stage named at lap i-1; the first segment (start -> lap 0) is `find`.
  const laps = c.laps.map((l, i) => `${i ? c.laps[i - 1].stage : 'find'} ${mmss(l.at_s - (i ? c.laps[i - 1].at_s : 0))}`).join(' | ');
  console.log(`clock: ${mmss(el)} elapsed${el > 420 ? ' (past 7:00: draft ONE role)' : ''}${el > 570 ? ' (PAST 9:30: STOP and report)' : ''}`);
  if (laps) console.log(`laps: ${laps}`);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('hunt.mjs');
if (isMain) {
  if (CMD === 'find') await cmdFind();
  else if (CMD === 'contacts') cmdContacts();
  else if (CMD === 'record') await cmdRecord();
  else if (CMD === 'log-outreach') cmdLogOutreach();
  else if (CMD === 'clock') cmdClock();
  else {
    console.error('usage: node scripts/hunt.mjs <find|contacts|record|log-outreach> [...]  (see header)');
    process.exit(2);
  }
}
