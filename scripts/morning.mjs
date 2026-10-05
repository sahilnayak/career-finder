#!/usr/bin/env node
/**
 * morning.mjs — the portable daily pipeline for career-finder.
 *
 *   scans (ATS index, HiringCafe, Workable, LinkedIn job lanes, Gmail job alerts, web search)
 *     -> resolve nominations to canonical ATS postings
 *     -> score the queue with `claude -p` (capped per run)
 *     -> JD snapshots, report stubs, full reports owed -> merge-tracker
 *     -> prune / reconcile / learn -> quota check (+ one primary-role keep-search round)
 *     -> outcome detection from Gmail (once a day) -> digest
 *
 * Every lane checks its own prerequisite and is SKIPPED WITH A LOGGED REASON when it is missing:
 *   claude CLI   -> LLM lanes (scoring, reports, web search, discovery, outcome detection)
 *   browser:9222 -> logged-in LinkedIn lanes and the browser-rendered boards
 *   Gmail creds  -> LinkedIn email-alert lane and outcome detection
 * A missing script is also a logged skip, never a crash.
 *
 * Usage:
 *   node scripts/morning.mjs                 # full daily run
 *   node scripts/morning.mjs --dry-run       # print the plan and each lane's skip/run decision
 *   node scripts/morning.mjs --mode speed    # hourly: 12h ATS sweep + LinkedIn guest + scoring
 *   node scripts/morning.mjs --mode hot      # 5-minute: hot-list sweep + scoring
 *   node scripts/morning.mjs --skip linkedin,websearch   # skip named lanes
 *   node scripts/morning.mjs --linkedin-login  # open linkedin.com/login in the debug Chrome, wait for login
 *   node scripts/morning.mjs --linkedin-test   # one faceted 24h search for the primary role, prints count + URL
 *
 * LinkedIn (daily mode): integrations.linkedin defaults ON (only an explicit `false` disables it).
 * The run starts the debug Chrome itself when :9222 is down, verifies the login by loading
 * linkedin.com/feed over raw CDP, and a missing login is a FAILED lane ("npm run linkedin:login"),
 * never a silent skip. Then, serially, for each of targets.roles[0..3]: linkedin-crawl (24h,
 * sortBy=DD, pipeline.linkedin_pages pages, default 2; tier-3 Apply-href resolution runs inside the
 * crawl), linkedin-jobsearch --form faceted, linkedin-jobsearch --form semantic. Guest API last.
 *
 * Env:
 *   MORNING_ONLY=lane,lane          run only these lanes (exact name, prefix like `linkedin` or
 *                                   `linkedin:crawl`); everything else is a logged skip. For tests.
 *   MORNING_LI_LOGIN_STATE=ok|logged-out|checkpoint|chrome-down   force the login-check result (offline tests)
 *   MORNING_NO_CHROME_START=1       never auto-start chrome-debug
 *   MORNING_LI_PACE_MS=min,max      jittered pause between LinkedIn lanes (default 20000,60000)
 *
 * Run from anywhere; it changes into the repo root. Kill switch: create data/PIPELINE_OFF.
 * Exit: 0 ok · 1 quota short · 2 setup problem · 3 scoring deferred by a usage-limit wall.
 *
 * Config (config/profile.yml -> pipeline):
 *   qualify_score, daily_quota, primary_quota, window_hours   (see targets.mjs)
 *   scoring_model (default "sonnet"), report_model (default "opus"), score_cap (default 25)
 *   claude_flags  (default ["--dangerously-skip-permissions"], required for unattended runs)
 */

import { splitFailures, quotaLine } from './morning-summary.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, statSync, appendFileSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const { requireTargets, searchKeywords, areaLabel } = await import('./targets.mjs');
const T = requireTargets();

// ── args ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry-run');
const MODE = opt('--mode', 'daily');
const SKIP = new Set(opt('--skip', '').split(',').map(s => s.trim()).filter(Boolean));
const ONLY = new Set((process.env.MORNING_ONLY || '').split(',').map(s => s.trim()).filter(Boolean));
/** A lane name matches a selector set by exact name or by any `:`-prefix (`linkedin`, `linkedin:crawl`). */
const selected = (set, name) => { const p = name.split(':'); for (let i = 1; i <= p.length; i++) if (set.has(p.slice(0, i).join(':'))) return true; return false; };
if (!['daily', 'speed', 'hot'].includes(MODE)) { console.error(`unknown --mode ${MODE} (daily|speed|hot)`); process.exit(2); }

const P = T.pipeline;
const Q = P.qualify_score, WIN = P.window_hours;
const SCORING_MODEL = P.scoring_model || 'sonnet';
const REPORT_MODEL = P.report_model || 'sonnet';
const SCORE_CAP = Number(P.score_cap) || (MODE === 'daily' ? 25 : 10);
const CLAUDE_FLAGS = Array.isArray(P.claude_flags) ? P.claude_flags : ['--dangerously-skip-permissions'];
const PRIMARY = T.targets.primary_role;
const ROLES = T.targets.roles;
const AREA = areaLabel();
const NAME = T.candidate?.full_name || 'the candidate';

// ── logging ─────────────────────────────────────────────────────────────────────────────────
mkdirSync('data', { recursive: true });
const PLOG = MODE === 'hot' ? 'data/_hot.log' : MODE === 'speed' ? 'data/_speed-cron.log' : 'data/_pipeline.log';
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(msg) {
  const line = `${stamp()} ${msg}`;
  console.log(line);
  if (!DRY) appendFileSync(PLOG, line + '\n');
}

// ── prerequisites ───────────────────────────────────────────────────────────────────────────
function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0;
}
async function browserUp() {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${Number(process.env.CAREER_FINDER_CDP_PORT) || 9222}/json/version`, { signal: ctl.signal });
    clearTimeout(t); return r.ok;
  } catch { return false; }
}
const GMAIL_DIR = `${homedir()}/.gmail-mcp`;
const PRE = {
  claude: which('claude'),
  browser: await browserUp(),
  gmail: existsSync(`${GMAIL_DIR}/credentials.json`) && existsSync(`${GMAIL_DIR}/gcp-oauth.keys.json`),
  go: which('go'),
  // Opt-in integrations: gated on config/profile.yml, never on host state alone.
  // LinkedIn defaults ON (onboarding enables it); only an explicit `false` turns it off.
  linkedin_on: T.integrations?.linkedin !== false,
  gmail_on: T.integrations?.gmail === true,
};
const WHY_MISSING = {
  claude: 'claude CLI not on PATH (install Claude Code)',
  browser: 'no debug browser on port 9222 (node scripts/chrome-debug.mjs start, then log into LinkedIn)',
  gmail: `no Gmail OAuth credentials in ${GMAIL_DIR}`,
  go: 'go toolchain not installed',
  linkedin_on: 'integrations.linkedin is false in config/profile.yml',
  gmail_on: 'integrations.gmail is not enabled in config/profile.yml',
};

// ── dry-run count parsers ───────────────────────────────────────────────────────────────────
function scanIndexCounts(out) {
  const g = re => (out.match(re) || [])[1] ?? '?';
  return `boards swept ${g(/Companies swept:\s*(\d+)/)}, postings found ${g(/Jobs found:\s*(\d+)/)}, matched ${g(/NEW candidates:\s*(\d+)/)}`;
}
function hiringcafeCounts(out) {
  const m = out.match(/raw (\d+) -> kept (\d+)/);
  return m ? `postings seen ${m[1]}, matched ${m[2]}` : '';
}
/** In-flight applications counted straight from data/applications.md (dry-run only). */
function appliedFromTracker() {
  if (!existsSync('data/applications.md')) return 0;
  return readFileSync('data/applications.md', 'utf8').split('\n')
    .filter(l => l.startsWith('|') && /\|\s*(Applied|Responded|Interview)\s*\|/i.test(l)).length;
}

// ── lane runner ─────────────────────────────────────────────────────────────────────────────
const results = [];
function lane(name, { needs = [], script = null, when = true, whyNot = '' } = {}) {
  if (ONLY.size && !selected(ONLY, name)) { results.push([name, 'skip', 'MORNING_ONLY']); log(`[skip] ${name}: not in MORNING_ONLY`); return false; }
  if (selected(SKIP, name)) { results.push([name, 'skip', '--skip']); log(`[skip] ${name}: --skip`); return false; }
  if (!when) { results.push([name, 'skip', whyNot]); log(`[skip] ${name}: ${whyNot}`); return false; }
  for (const n of needs) {
    if (!PRE[n]) { results.push([name, 'skip', WHY_MISSING[n]]); log(`[skip] ${name}: ${WHY_MISSING[n]}`); return false; }
  }
  if (script && !existsSync(script)) { results.push([name, 'skip', `${script} not present`]); log(`[skip] ${name}: ${script} not present`); return false; }
  return true;
}

/** Run a node script. Non-fatal by default; returns the exit status (0 in dry-run). */
function node(name, script, args = [], { needs = [], stdoutTo = null, when, whyNot, dryArgs = null, dryCount = null } = {}) {
  if (!lane(name, { needs, script, when, whyNot })) return null;
  if (DRY && dryArgs) {
    // Zero-cost read-only lane: actually run it in its no-write mode and report real counts.
    const r = spawnSync(process.execPath, [script, ...dryArgs], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15 * 60e3 });
    const counts = r.status === 0 && dryCount ? dryCount(r.stdout || '') : '';
    results.push([name, r.status === 0 ? 'dry ok' : `exit ${r.status}`, counts]);
    log(`[dry-run] ${name}: node ${script} ${dryArgs.join(' ')} -> ${r.status === 0 ? counts || 'ok' : `exit ${r.status}`}`);
    return r.status;
  }
  if (DRY) { results.push([name, 'would run', `node ${script} ${args.join(' ')}`]); log(`[dry] ${name}: node ${script} ${args.join(' ')}${stdoutTo ? ' > ' + stdoutTo : ''}`); return 0; }
  log(`[run] ${name}`);
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 45 * 60e3 });
  if (stdoutTo) writeFileSync(stdoutTo, r.stdout || '');
  else if (r.stdout) appendFileSync(PLOG, r.stdout);
  if (r.stderr) appendFileSync(PLOG, r.stderr);
  results.push([name, r.status === 0 ? 'ok' : `exit ${r.status}`, '']);
  if (r.status !== 0) log(`[warn] ${name}: exit ${r.status} (non-fatal)`);
  return r.status;
}

let quotaWall = false;
const LIMIT_RE = /hit your session limit|usage limit reached|rate limit.*resets|quota exceeded/i;
/** Run one headless `claude -p` call. */
function claude(name, prompt, { model = SCORING_MODEL, when, whyNot } = {}) {
  if (quotaWall) { results.push([name, 'skip', 'usage-limit wall earlier in this run']); log(`[skip] ${name}: usage-limit wall earlier in this run`); return null; }
  if (!lane(name, { needs: ['claude'], when, whyNot })) return null;
  if (DRY) { results.push([name, 'would run', `claude -p (${model}, ${prompt.length} chars)`]); log(`[dry] ${name}: claude -p --model ${model} (${prompt.length}-char prompt)`); return 0; }
  log(`[run] ${name} (claude ${model})`);
  const r = spawnSync('claude', ['-p', prompt, '--model', model, ...CLAUDE_FLAGS], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60 * 60e3 });
  const out = (r.stdout || '') + (r.stderr || '');
  appendFileSync(PLOG, out + '\n');
  if (LIMIT_RE.test(out.slice(-2000))) {
    quotaWall = true;
    log(`[warn] ${name}: claude hit a usage limit; remaining LLM lanes are skipped and the queue rolls to the next run`);
    results.push([name, 'deferred', 'usage limit']);
    return 3;
  }
  results.push([name, r.status === 0 ? 'ok' : `exit ${r.status}`, out.trim().split('\n').pop()?.slice(0, 120) || '']);
  return r.status;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const rowsIn = f => { try { return readFileSync(f, 'utf8').split('\n').slice(1).filter(l => l.trim()).length; } catch { return 0; } };
const jsonLen = f => { try { return JSON.parse(readFileSync(f, 'utf8')).length || 0; } catch { return 0; } };
function onceToday(key) {
  const f = `data/_once-${key}-${new Date().toISOString().slice(0, 10)}`;
  if (existsSync(f)) return false;
  if (!DRY) writeFileSync(f, '');
  try {
    for (const g of readdirSync('data')) if (g.startsWith(`_once-${key}-`) && g !== f.slice(5)
      && Date.now() - statSync(`data/${g}`).mtimeMs > 7 * 864e5) unlinkSync(`data/${g}`);
  } catch {}
  return true;
}
function appendRows(from, to) {
  if (DRY || !existsSync(from)) return 0;
  const rows = readFileSync(from, 'utf8').split('\n').slice(1).filter(l => l.trim());
  if (rows.length) appendFileSync(to, rows.join('\n') + '\n');
  return rows.length;
}

// ── shared prompt text (built from config, no candidate-specific content) ───────────────────
const LOCATION_RULE = {
  onsite: `ONSITE or HYBRID within ${AREA} only; reject remote/anywhere/WFH roles`,
  hybrid: `ONSITE or HYBRID within ${AREA} only; reject remote/anywhere/WFH roles`,
  'remote-country': `within ${AREA}, or remote inside ${T.location.country || "the candidate's country"} (reject remote roles restricted to other countries or to states that exclude ${T.location.state || "the candidate's state"})`,
  any: 'any location, including remote',
}[T.location.remote_policy] || `within ${AREA}`;

const SCORING_RULES = [
  `Candidate: ${NAME}. Target roles: ${ROLES.join(', ')} (primary: ${PRIMARY}). Location rule: ${LOCATION_RULE}.`,
  `Score each candidate 1.0-5.0 against modes/offer.md + modes/_shared.md, reading cv.md and modes/_profile.md for the candidate. A score >= ${Q} is QUALIFIED.`,
  'CANONICAL-JD RULE: never score from an aggregator or LinkedIn snippet. Resolve the employer ATS posting (Greenhouse/Ashby/Lever/Workday/SmartRecruiters APIs preferred) and score its JD.',
  'The ATS is the only source for: whether the req still exists and is open (404/expired = verdict stale), the real location, comp, and any years-of-experience gate. Quote a years gate verbatim and note whether it sits under a hard heading (Requirements) or a soft one (Nice to have).',
  'Age is NOT a scoring penalty: a re-promoted old req is still hiring. Record the real ATS publish date and lead the why with it when the req is old.',
  'Every claim must be true to cv.md. Never inflate a score to fill a quota. Compensation never lowers a score.',
  'Dedup against data/scored-jobs.tsv by URL / ATS job id ONLY, never by company name (one employer runs many reqs). Drop anything whose employer appears in data/_speed-noise.txt (staffing/aggregators) or data/_never-apply.txt (absolute exclusion).',
  'Write EVERY triaged candidate with: node scripts/record-scored.mjs <date> <company> <role> <score> <verdict> <why> <canonical_url> [found_at_iso]  (verdict QUALIFIED/near/pass/stale/SKIP; why <= 200 chars, no tabs).',
  `For a score >= ${Q} also append to data/qualifiers.tsv (tab-separated: date, company, role, score, why, url, source, posted_iso) if the url is not already there.`,
].join('\n');

// ── LinkedIn login helpers (raw CDP, never Playwright) ──────────────────────────────────────
const LI_FIX = 'log in once: npm run linkedin:login';
/** Start the debug Chrome when :9222 is down. Returns true when the port answers. */
async function ensureChrome() {
  if (await browserUp()) return true;
  if (process.env.MORNING_NO_CHROME_START === '1') return false;
  log('[run] chrome-debug start (port 9222 was down)');
  const r = spawnSync(process.execPath, ['scripts/chrome-debug.mjs', 'start'], { encoding: 'utf8', timeout: 60e3 });
  if (r.stdout) appendFileSync(PLOG, r.stdout); if (r.stderr) appendFileSync(PLOG, r.stderr);
  for (let i = 0; i < 10; i++) { if (await browserUp()) return true; await new Promise(res => setTimeout(res, 1000)); }
  return false;
}
/** Classify a loaded LinkedIn page. Pure, exported shape for tests: { url, hasNav, hasLoginForm, text }. */
function classifyLinkedIn({ url = '', hasNav = false, hasLoginForm = false, text = '' }) {
  if (/\/checkpoint\/|\/challenge/.test(url) || /unusual activity|security verification|are you a human|quick security check/i.test(text)) return 'checkpoint';
  if (/\/authwall|\/login|\/uas\/login|\/signup|\/signin/.test(url) || hasLoginForm) return 'logged-out';
  // LinkedIn ships hashed class names, so nav selectors are unreliable (a logged-in feed has none
  // of the old #global-nav ids). The durable signal is the redirect: a logged-out /feed/ request
  // lands on /login, /authwall or the guest homepage; a logged-in one stays on an app path.
  if (/linkedin\.com\/(feed|jobs|in\/|mynetwork|messaging|notifications)/.test(url)) return 'ok';
  return hasNav ? 'ok' : 'logged-out';
}
/** Load linkedin.com/feed in a background tab and report 'ok' | 'logged-out' | 'checkpoint' | 'chrome-down' | 'error'. */
async function linkedinLoginState() {
  const forced = process.env.MORNING_LI_LOGIN_STATE;
  if (forced) return { state: forced, url: '(forced by MORNING_LI_LOGIN_STATE)' };
  if (!(await ensureChrome())) return { state: 'chrome-down', url: '' };
  let page;
  try {
    const { newPage } = await import('./cdp.mjs');
    page = await newPage();
    await page.navigate('https://www.linkedin.com/feed/', { waitMs: 3500, loadTimeout: 45000 });
    const dom = await page.evaluate(() => ({
      url: location.href,
      hasNav: !!document.querySelector('#global-nav, .global-nav, header.global-nav, [data-test-global-nav]'),
      hasLoginForm: !!document.querySelector('#session_key, input[name=session_key], #username, form.login__form'),
      text: (document.body?.innerText || '').slice(0, 4000),
    }));
    return { state: classifyLinkedIn(dom), url: dom.url };
  } catch (e) {
    return { state: 'error', url: '', error: e.message };
  } finally { try { await page?.close(); } catch {} }
}
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function liPace() {
  const [lo, hi] = (process.env.MORNING_LI_PACE_MS || '20000,60000').split(',').map(Number);
  const ms = Math.max(0, (lo || 0) + Math.random() * Math.max(0, (hi || 0) - (lo || 0)));
  if (ms > 0) sleepMs(ms);
}

// ── one-shot LinkedIn commands (npm run linkedin:login / linkedin:test) ─────────────────────
if (flag('--linkedin-login')) {
  if (!(await ensureChrome())) { console.error('debug Chrome did not come up on :9222 (node scripts/chrome-debug.mjs start)'); process.exit(2); }
  const { newPage } = await import('./cdp.mjs');
  const page = await newPage({ background: false });
  await page.navigate('https://www.linkedin.com/login', { waitMs: 2000 });
  console.log('Log into LinkedIn in the Chrome window that just opened. Waiting up to 10 minutes...');
  const deadline = Date.now() + 10 * 60e3;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    let url = ''; try { url = await page.url(); } catch {}
    if (/linkedin\.com\/(feed|jobs|in\/|mynetwork|checkpoint)/.test(url) && !/\/login|\/authwall/.test(url)) break;
  }
  try { await page.close(); } catch {}
  const st = await linkedinLoginState();
  console.log(`linkedin login: ${st.state}${st.url ? '  (' + st.url + ')' : ''}`);
  process.exit(st.state === 'ok' ? 0 : 1);
}
if (flag('--linkedin-test')) {
  const st = await linkedinLoginState();
  if (st.state !== 'ok') { console.error(`linkedin login: ${st.state}. ${LI_FIX}`); process.exit(1); }
  const { liGeoParam } = await import('./li-geo.mjs');
  const geo = liGeoParam();
  const url = `https://www.linkedin.com/jobs/search-results/?keywords=${encodeURIComponent(PRIMARY)}${geo ? `&${geo}` : ''}&f_TPR=r86400`;
  console.log(`linkedin:test faceted 24h search for "${PRIMARY}"\nURL: ${url}`);
  const r = spawnSync(process.execPath, ['scripts/linkedin-jobsearch.mjs', '--queries', PRIMARY, '--form', 'faceted', '--dry-run'], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 10 * 60e3 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  const m = (r.stdout || '').match(/(\d+)\s+(?:unique\s+)?cards?/i) || (r.stdout || '').match(/nominated\s+(\d+)/i);
  console.log(`linkedin:test exit ${r.status} · cards: ${m ? m[1] : '? (see output above)'}`);
  process.exit(r.status ?? 1);
}

// ── lock + kill switch ──────────────────────────────────────────────────────────────────────
if (existsSync('data/PIPELINE_OFF')) { console.log('data/PIPELINE_OFF present; pipeline disabled.'); process.exit(0); }
const LOCK = resolve(process.env.TMPDIR || '/tmp', 'career-finder-pipeline.lock');
if (!DRY) {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 2 * 3600e3) rmdirSync(LOCK); } catch {}
  try { mkdirSync(LOCK); } catch { console.log('another pipeline run holds the lock; exiting'); process.exit(0); }
  const release = () => { try { rmdirSync(LOCK); } catch {} };
  process.on('exit', release);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(130); });
}

log(`=== career-finder ${MODE} run start${DRY ? ' (DRY RUN)' : ''} — ${ROLES.join(', ')} · ${AREA} · bar ${Q} · window ${WIN}h ===`);
log(`prereqs: claude=${PRE.claude} browser=${PRE.browser} gmail=${PRE.gmail} go=${PRE.go} · integrations: linkedin=${PRE.linkedin_on} gmail=${PRE.gmail_on}`);

// ════════════════════════════════════════════════════════════════════════════════════════════
// HOT mode: poll the hot list only, score anything new. Zero cost on a quiet cycle.
// ════════════════════════════════════════════════════════════════════════════════════════════
if (MODE === 'hot') {
  if (!existsSync('data/hot-companies.tsv') || rowsIn('data/hot-companies.tsv') === 0) {
    log('[skip] hot: data/hot-companies.tsv is empty (build it with: node scripts/hot-list.mjs --build)');
    process.exit(0);
  }
  node('hot:sweep', 'scripts/scan-index.mjs', ['--only', 'data/hot-companies.tsv', '--hours', '12', '--out', 'data/_hot-candidates.tsv']);
  const n = rowsIn('data/_hot-candidates.tsv');
  claude('hot:score', `HOT-TIER scoring (headless). Candidates: data/_hot-candidates.tsv (header row; they already passed the title, location, recency and dedup filters and carry the canonical ATS url and posted timestamp). Process at most ${SCORE_CAP}.\n${SCORING_RULES}\nEnd with one line: 'hot: scored N, qualified M'.`,
    { when: DRY || n > 0, whyNot: 'no new hot candidates' });
  node('reconcile', 'scripts/reconcile-qualifiers.mjs');
  node('rotate-logs', 'scripts/rotate-logs.mjs', ['--quiet']);
  log(`=== hot run done ===`);
  process.exit(quotaWall ? 3 : 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. SCANS (zero LLM unless noted)
// ════════════════════════════════════════════════════════════════════════════════════════════
const KW = searchKeywords().join(',');
const DAILY = MODE === 'daily';

// 1a. Grow the company index once a day (LLM, WebSearch).
if (DAILY && (DRY || onceToday('discover'))) {
  claude('discover', `Find NEW companies with a public ATS job board (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday) that hire ${ROLES.join(' / ')} roles ${T.location.remote_policy === 'any' ? 'anywhere' : `in or near ${AREA}`}. Use WebSearch + WebFetch only. Skip any company whose board URL already appears in column 3 of data/company-index.tsv or in data/_discovered-companies.tsv, and anything in data/_speed-noise.txt or data/_never-apply.txt. Verify each board URL loads real postings for THAT company (an ATS returns 200 for nonsense slugs, so confirm the company name on the page). Append up to 25 verified finds to data/_discovered-companies.tsv as two tab-separated columns: company name, board URL. End with one line: 'discover: +N'.`, { model: SCORING_MODEL });
}

// 1b. LinkedIn. Logged-in lanes: 3 searches per role (crawl, faceted, semantic), past 24h,
// max 4 roles, strictly serial with jittered pacing. A missing login is a FAILED lane.
const LI_ROLES = ROLES.slice(0, 4);
const LI_PAGES = String(Math.max(1, Number(P.linkedin_pages ?? T.integrations?.linkedin_pages) || 2));
const liWanted = PRE.linkedin_on && !selected(SKIP, 'linkedin') && (!ONLY.size || [...ONLY].some(o => o === 'linkedin' || o.startsWith('linkedin:')));
if (DAILY && liWanted && existsSync('data/LINKEDIN_OFF')) {
  results.push(['linkedin', 'skip', 'kill-switch data/LINKEDIN_OFF (npm run linkedin:on)']); log('[skip] linkedin: data/LINKEDIN_OFF');
} else if (DAILY && liWanted) {
  let liOk = DRY;
  if (DRY) {
    results.push(['linkedin:login', 'would run', `${PRE.browser ? '' : 'start chrome-debug, '}load linkedin.com/feed over CDP`]);
  } else {
    const st = await linkedinLoginState();
    PRE.browser = await browserUp();
    if (st.state === 'ok') { liOk = true; results.push(['linkedin:login', 'ok', st.url]); log(`[ok] linkedin login (${st.url})`); }
    else {
      const why = st.state === 'chrome-down' ? 'debug Chrome not reachable on :9222 (node scripts/chrome-debug.mjs start), then ' + LI_FIX
        : st.state === 'checkpoint' ? 'LinkedIn checkpoint/CAPTCHA, clear it by hand in the debug Chrome; ' + LI_FIX
        : st.state === 'error' ? `login check errored (${st.error || '?'}); ${LI_FIX}` : LI_FIX;
      results.push(['linkedin:login', `exit ${st.state}`, why]); log(`[FAIL] linkedin login: ${st.state} — ${why}`);
    }
  }
  if (liOk) {
    PRE.li_login = true;
    WHY_MISSING.li_login = 'LinkedIn login check failed';
    let aborted = false, first = true;
    for (const role of LI_ROLES) {
      const steps = [
        [`linkedin:crawl:${role}`, 'scripts/linkedin-crawl.mjs', ['--keywords', role, '--hours', '24', '--ats-hours', '48', '--pages', LI_PAGES, '--write']],
        [`linkedin:faceted:${role}`, 'scripts/linkedin-jobsearch.mjs', ['--queries', role, '--form', 'faceted']],
        [`linkedin:semantic:${role}`, 'scripts/linkedin-jobsearch.mjs', ['--queries', role, '--form', 'semantic']],
      ];
      for (const [name, script, args] of steps) {
        if (aborted) { results.push([name, 'skip', 'aborted: checkpoint/CAPTCHA earlier in this run']); continue; }
        if (!DRY && !first) liPace();
        const rc = node(name, script, args, { needs: ['linkedin_on', 'li_login'] });
        if (rc !== null) first = false;
        if (rc === 2 && /jobsearch/.test(script)) { aborted = true; log('[FAIL] linkedin: checkpoint/CAPTCHA, aborting remaining LinkedIn lanes'); }
      }
    }
  } else {
    results.push(['linkedin:lanes', 'skip', 'login check failed (see linkedin:login)']);
  }
}
// Guest API: no login, supplement only (all modes).
node('linkedin:guest', 'scripts/speed-linkedin.mjs', ['--hours', String(WIN), '--json'], { needs: ['linkedin_on'], stdoutTo: DRY ? null : 'data/_speed-li.json' });
if (DAILY) {
  // Gmail first: this lane reads job-alert EMAIL, so its skip reason should name Gmail.
  node('linkedin:email-alerts', 'scripts/linkedin-email-alerts.mjs', ['--days', '3', '--write'], { needs: ['gmail_on', 'gmail', 'linkedin_on'] });
}

// 1c. ATS index sweep.
if (DAILY) {
  node('ats:repair-index', 'scripts/repair-index.mjs', ['--apply'], { when: new Date().getDay() === 1, whyNot: 'runs on Mondays only' });
  // Same window as standalone scan-index (pipeline.scan_window_days), in dry-run AND normal mode.
  const INDEX_HOURS = String((Number(P.scan_window_days) || 7) * 24);
  if (DRY) node('ats:index', 'scripts/scan-index.mjs', [], { dryArgs: ['--hours', INDEX_HOURS, '--dry-run'], dryCount: scanIndexCounts });
  else node('ats:index', 'scripts/run-pipeline.mjs', ['--hours', INDEX_HOURS]);
} else {
  node('ats:index', 'scripts/scan-index.mjs', ['--hours', '12', '--out', 'data/_candidates.tsv']);
}

// 1d. Protected primary-role sweep over employers that have posted the primary role before.
if (DAILY) {
  const wl = rowsIn('data/primary-watchlist.tsv');
  if (node('ats:primary-watchlist', 'scripts/scan-index.mjs', ['--only', 'data/primary-watchlist.tsv', '--primary-only', '--hours', '72', '--out', 'data/_candidates-primary.tsv'],
    { when: wl > 0, whyNot: 'data/primary-watchlist.tsv is empty (it fills as the primary role gets scored)' }) === 0) {
    const n = appendRows('data/_candidates-primary.tsv', 'data/_candidates.tsv');
    if (n) log(`primary-watchlist: +${n} candidate(s) appended for scoring`);
  }
}

// 1e. Aggregator lanes that resolve to the employer's ATS.
if (DAILY) {
  node('hiringcafe', 'scripts/hiringcafe-scan.mjs', ['--quiet'],
    { dryArgs: ['--dry-run'], dryCount: hiringcafeCounts, when: T.location.remote_policy === 'any' || (T.location.lat != null && T.location.lng != null), whyNot: 'location.lat/lng not set in config/profile.yml' });
  node('workable', 'scripts/workable-search.mjs', ['--quiet']);
  node('browser-boards', 'scripts/browser-boards.mjs', ['--quiet'], { needs: ['browser'] });
}

// 1f. Open-web search agent (LLM).
if (DAILY) {
  claude('websearch', `Headless web search for NEW job postings (WebSearch + WebFetch only, no browser). If data/web-search-learnings.md exists, read it first and follow its playbook. GOAL: postings published in the last ${WIN} hours for these titles: ${ROLES.join(', ')}. Location rule: ${LOCATION_RULE}. For each find, resolve the employer's own ATS posting; drop anything without one, anything from a staffing agency or aggregator relist, and any employer in data/_speed-noise.txt or data/_never-apply.txt. Skip urls already in data/scored-jobs.tsv or data/_web-roles.tsv. Append each verified find to data/_web-roles.tsv as tab-separated columns: date, company, role, location, posted, url, source. Then run: node scripts/web-roles.mjs --clean. End with one line: 'web: +N'.`, { model: SCORING_MODEL });
}

// 1g. Fan-in: resolve boards for newly named employers, sweep them, clean queues.
if (DAILY) {
  node('probe-ats', 'scripts/probe-ats.mjs', ['--unresolved', '--append']);
  node('discover-companies', 'scripts/discover-companies.mjs', ['--from', 'data/_discovered-companies.tsv'],
    { when: (() => { try { return readFileSync('data/_discovered-companies.tsv', 'utf8').trim().length > 0; } catch { return false; } })(), whyNot: 'no discovered companies queued' });
  if (rowsIn('data/_new-boards.tsv') > 0) {
    if (node('ats:new-boards', 'scripts/scan-index.mjs', ['--only', 'data/_new-boards.tsv', '--hours', String(WIN * 2), '--out', 'data/_candidates-new.tsv']) === 0) {
      const n = appendRows('data/_candidates-new.tsv', 'data/_candidates.tsv');
      if (n) log(`new-boards: +${n} candidate(s)`);
    }
  }
}
node('web-roles:clean', 'scripts/web-roles.mjs', ['--clean']);
if (DAILY) node('web-roles:archive', 'scripts/web-roles.mjs', ['--archive']);
node('resolve-nominations', 'scripts/resolve-nominations.mjs');

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. SCORE (LLM, capped)
// ════════════════════════════════════════════════════════════════════════════════════════════
const ATS_N = rowsIn('data/_candidates.tsv'), LI_N = jsonLen('data/_speed-li.json'), WEB_N = rowsIn('data/_web-roles.tsv');
log(`signals: ats=${ATS_N} linkedin=${LI_N} web=${WEB_N}`);
const scoreStatus = claude('score', `Pipeline scoring (headless). HARD CAP: process AT MOST ${SCORE_CAP} candidates this run; the rest roll to the next run. Fill up to ${Math.ceil(SCORE_CAP * 0.6)} slots with ${PRIMARY} candidates first, then the other target roles, most recent first; spill unused slots either way.
Candidates: data/_candidates.tsv (ATS, header row), data/_speed-li.json (LinkedIn cards), data/_web-roles.tsv (header: date/company/role/location/posted/url/source).
For any candidate whose url is on linkedin.com, look it up in data/_resolved-noms.tsv by company+role and score its canonical_url instead; skip rows marked AMBIGUOUS. Score candidates that already have a real ATS url before linkedin.com ones.
For rows whose source is hiringcafe, data/_hiringcafe.tsv (keyed by url) carries min_yoe, seniority, workplace_type and comp: use it as a starting point, never as the verdict.
${SCORING_RULES}
Log the cycle: node scripts/speed-metrics.mjs <ats> <browser> <scored> <qualified> 'morning-${MODE}'.
End with one line: 'scored N, qualified M'.`,
  { when: DRY || ATS_N + LI_N + WEB_N > 0, whyNot: 'no new signals' });
if (scoreStatus === null && !quotaWall) node('speed-metrics', 'scripts/speed-metrics.mjs', [String(ATS_N), String(LI_N + WEB_N), '0', '0', `morning-${MODE}: no new signals`]);

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. ARTIFACTS: JD snapshots, report stubs, full reports owed, tracker merge
// ════════════════════════════════════════════════════════════════════════════════════════════
node('snapshot-jd', 'scripts/snapshot-jd.mjs');
if (DAILY) {
  node('jd-pdfs', 'scripts/gen-jd-pdfs.mjs');
  node('backfill-reports', 'scripts/backfill-reports.mjs', ['--min', String(Q)]);
  claude('reports', `Write the FULL A-G evaluation reports owed. STEP 1: run 'node scripts/pipeline-owed.mjs --json' and take every job whose missing list includes 'report' or 'full-report' (a stub exists but a real evaluation is owed). If none, end with 'reports: 0 owed'. STEP 2: for each, read modes/offer.md, modes/_shared.md, modes/_profile.md and cv.md, and the canonical JD (use data/jds/ when a snapshot exists). STEP 3: write reports/{NNN}-{company-slug}-{role-slug}-{YYYY-MM-DD}.md where NNN comes from 'node scripts/next-report-num.mjs', incrementing per report. Blocks A-G; header carries Date, Posted (real ATS age), Archetype, Score, URL, JD, PDF and Legitimacy. RULES: every claim true to cv.md; quote any years gate verbatim and say whether it clears; name the exact requisition and never merge two reqs at one employer; flag location contradictions between ATS fields and the JD body; never inflate a score to match the ledger. STEP 4: for each report write batch/tracker-additions/{NNN}-{company-slug}.tsv (9 tab-separated columns: num, date, company, role, status, score, pdf, report-link, notes) then run 'node scripts/merge-tracker.mjs'. End with one line: 'reports: wrote N, owed now M'.`, { model: REPORT_MODEL });
}
node('merge-tracker', 'scripts/merge-tracker.mjs');

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. HOUSEKEEPING + LEARNING
// ════════════════════════════════════════════════════════════════════════════════════════════
node('prune-qualifiers', 'scripts/prune-qualifiers.mjs');
if (DAILY) node('prune-board', 'scripts/prune-board.mjs');
node('reconcile', 'scripts/reconcile-qualifiers.mjs');
if (DAILY) {
  node('feedback-outcomes', 'scripts/feedback-outcomes.mjs', ['--learn']);
  node('web-roles-learn', 'scripts/web-roles-learn.mjs');
  node('pipeline-owed', 'scripts/pipeline-owed.mjs');
  // Outreach bullets only: contact discovery and drafting stay interactive and draft-only.
  node('outreach-bullets', 'scripts/drain-outreach.mjs', ['--bullets-only', '--quiet'], { needs: ['claude'] });
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. QUOTA (+ one keep-search round on the primary role when short)
// ════════════════════════════════════════════════════════════════════════════════════════════
function quota() {
  if (DRY) { node('quota', 'scripts/daily-quota.mjs', ['--json']); return null; }
  const r = spawnSync(process.execPath, ['scripts/daily-quota.mjs', '--json'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
let q = quota();
if (DAILY && q && !q.met) {
  log(`quota SHORT: ${q.total}/${q.minCount} qualifiers, ${q.primary}/${q.primaryQuota} ${PRIMARY}; running one primary-role keep-search round`);
  if (node('keep-search:primary', 'scripts/scan-index.mjs', ['--primary-only', '--hours', '72', '--out', 'data/_candidates-primary-backstop.tsv']) === 0
      && rowsIn('data/_candidates-primary-backstop.tsv') > 0) {
    claude('keep-search:score', `Score ONLY the candidate rows in data/_candidates-primary-backstop.tsv (header row present). These are ${PRIMARY} candidates from a full-index sweep. Process at most ${SCORE_CAP}.\n${SCORING_RULES}\nEnd with one line: 'backstop: scored N, qualified M'.`);
    node('reconcile', 'scripts/reconcile-qualifiers.mjs');
    q = quota();
  }
}
if (DRY && DAILY) log('[dry] keep-search:primary + keep-search:score run only when the quota is short');
if (!DRY) node('quota:report', 'scripts/daily-quota.mjs');

// ════════════════════════════════════════════════════════════════════════════════════════════
// 6. OUTCOMES (once a day, Gmail read-only) + digest
// ════════════════════════════════════════════════════════════════════════════════════════════
if (DAILY && (DRY || onceToday('outcomes'))) {
  const applied = DRY ? appliedFromTracker() : (() => {
    const r = spawnSync(process.execPath, ['scripts/applied-watchlist.mjs'], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout).length; } catch { return 0; }
  })();
  claude('outcomes', `Application outcome detection, READ-ONLY Gmail. STEP 1: run 'node scripts/applied-watchlist.mjs' for the JSON list of in-flight applied jobs. STEP 2: for each, search Gmail (gmail MCP search_emails, read_email) for messages since the applied date from that company. NEVER send, reply, draft, delete, archive, label or modify anything. STEP 3: classify the latest signal: rejected / interview (incl. scheduling links) / offer / responded (a real human reply, not an auto-acknowledgement) / NONE. Be conservative. STEP 4: for each decided signal run 'node scripts/record-outcome.mjs "<company>" <responded|interview|offer|rejected>' (it refuses ambiguous keys; narrow the key with the url if so), never regress a status, and update that row's Status in data/applications.md with a dated '(auto-detected from Gmail)' note; never add rows. STEP 5: run 'node scripts/feedback-outcomes.mjs --learn'. End with one line: 'outcomes: rejected R, interview I, offer O, responded P'.`,
    { needs: ['gmail_on', 'gmail'], when: applied > 0, whyNot: 'no in-flight applied jobs' });
}
node('rotate-logs', 'scripts/rotate-logs.mjs', ['--quiet']);
if (DAILY) node('digest', 'scripts/pipeline-digest.mjs', ['--quiet']);

// Rebuild the Go dashboard binary when Go is available (optional).
if (DAILY && lane('dashboard:build', { needs: ['go'], when: existsSync('dashboard/go.mod'), whyNot: 'no dashboard/go.mod' })) {
  if (DRY) log('[dry] dashboard:build: go build -o career-dashboard .');
  else {
    const r = spawnSync('go', ['build', '-o', 'career-dashboard', '.'], { cwd: 'dashboard', encoding: 'utf8' });
    log(r.status === 0 ? '[ok] dashboard built' : `[warn] dashboard build failed: ${(r.stderr || '').slice(0, 200)}`);
  }
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────
const width = Math.max(...results.map(r => r[0].length), 10);
console.log(`\n${DRY ? 'PLAN' : 'SUMMARY'} (${MODE}):`);
for (const [n, s, why] of results) console.log(`  ${n.padEnd(width)}  ${s}${why ? '  — ' + why : ''}`);
log(`=== career-finder ${MODE} run done ===`);

// Any lane that exited non-zero is named here, so a dead lane cannot hide in the table.
// A short quota (daily-quota.mjs exit 1) is an outcome, not a dead lane: its own QUOTA line.
const { failed, quotaShort } = splitFailures(results);
const qLine = DRY ? '' : quotaLine(q, quotaShort, PRIMARY);
if (qLine) console.log(`\n${qLine}`);
if (failed.length) {
  console.log(`\nFAILED LANES (${failed.length}):`);
  for (const [n, st, why] of failed) console.log(`  ${n}  ${st}${n.startsWith('linkedin') && why ? '  — ' + why : ''}  (see ${PLOG})`);
}

if (DRY) process.exit(0);
if (quotaWall) process.exit(3);
if (failed.length) process.exit(1);
process.exit((DAILY && q && !q.met) || quotaShort ? 1 : 0);
