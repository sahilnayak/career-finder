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
 *   node scripts/morning.mjs --mode speed    # opt-in (schedule --with-speed, 2-4/day): 12h ATS sweep + LinkedIn guest + scoring
 *   node scripts/morning.mjs --mode hot      # opt-in (schedule --with-hot, every 30-60 min): hot-list sweep + scoring
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
 * Run from anywhere; it changes into the repo root.
 * Exit: 0 ok · 1 quota short · 2 setup problem · 3 LLM lanes deferred (usage-limit wall or daily_claude_cap)
 *
 * Kill switches (all checked BEFORE the lock, each logs a SKIPPED line to the mode's log):
 *   data/PIPELINE_OFF               every mode (npm run pipeline:off / pipeline:on / pipeline:status)
 *   data/_pipeline-skip-dates.txt   one YYYY-MM-DD per line (local date); every mode skips that day
 *   data/HOT_OFF                    hot mode only
 *   data/_hot-quota-backoff         written on a usage wall in speed/hot; those modes skip for 30 min
 * Locks: daily + hot share the pipeline lock, speed has its own. The lock mtime is refreshed on
 * every lane, so a live run is never stolen; a lock older than 2h is stale. A held lock logs
 * "skipped: locked".
 *
 * Cost bounds: every `claude -p` call passes --model (Sonnet by default), --max-turns and a
 * per-call timeout, and is appended to data/_claude-calls.log (local date, mode, lane, model,
 * seconds, status). When today's count reaches pipeline.daily_claude_cap (default 40, across all
 * modes) the remaining LLM lanes are skipped and the run exits 3.
 * Usage wall: exit-3 path writes the quota-guard marker; the next daily run replays the deferred
 * backlog under SCORE_CAP before its own scans, then clears the marker.
 *
 * Config (config/profile.yml -> pipeline):
 *   qualify_score, daily_quota, primary_quota, window_hours   (see targets.mjs)
 *   scoring_model (default "sonnet"), report_model (default "sonnet"), score_cap (default 25 daily, 10 otherwise)
 *   report_cap (default 5), daily_claude_cap (default 40), claude_max_turns (default 60),
 *   claude_timeout_min (default 30)
 *   claude_flags  (default ["--dangerously-skip-permissions"], required for unattended runs)
 * Hard gates (config/profile.yml -> hard_gates): any gate set there caps a failing job's score
 * below qualify_score. None are hard-coded.
 */

import { splitFailures, quotaLine } from './morning-summary.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync, statSync, appendFileSync, readFileSync, writeFileSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
// Headless guard for interactive-only scripts (drain-outreach full drain, find-people, ...).
process.env.UNATTENDED = '1';

// Onboarding gate: without these the run has nothing to score against. Exit before spending anything.
// CAREER_FINDER_PROFILE (tests, fixtures) stands in for config/profile.yml; a --dry-run against it
// may proceed without cv.md/portals.yml because nothing is scored or written.
const SETUP_FILES = ['cv.md', process.env.CAREER_FINDER_PROFILE || 'config/profile.yml', 'portals.yml'];
const missingSetup = SETUP_FILES.filter(f => !existsSync(f));
const fixtureDry = !!process.env.CAREER_FINDER_PROFILE && process.argv.includes('--dry-run') && existsSync(process.env.CAREER_FINDER_PROFILE);
if (missingSetup.length && fixtureDry) {
  console.error(`(dry-run against ${process.env.CAREER_FINDER_PROFILE}; setup files missing: ${missingSetup.join(', ')} — continuing)`);
} else if (missingSetup.length) {
  console.error(`career-finder is not set up: missing ${missingSetup.join(', ')}. Run setup first (open Claude Code here and say "set me up", or /career-finder setup).`);
  process.exit(2);
}

const { requireTargets, searchKeywords, areaLabel } = await import('./targets.mjs');
const T = requireTargets();

// ── args ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry-run');
const MODE = opt('--mode', 'daily');
const SKIP = new Set(opt('--skip', '').split(',').map(s => s.trim()).filter(Boolean));
// One run id for this morning run and every lane it spawns (children inherit the env), so the
// request ledger can total the whole run. See scripts/request-ledger.mjs.
if (!process.env.CAREER_FINDER_RUN_ID) process.env.CAREER_FINDER_RUN_ID = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${MODE}-${process.pid}`;
const ONLY = new Set((process.env.MORNING_ONLY || '').split(',').map(s => s.trim()).filter(Boolean));
/** A lane name matches a selector set by exact name or by any `:`-prefix (`linkedin`, `linkedin:crawl`). */
const selected = (set, name) => { const p = name.split(':'); for (let i = 1; i <= p.length; i++) if (set.has(p.slice(0, i).join(':'))) return true; return false; };
if (!['daily', 'speed', 'hot'].includes(MODE)) { console.error(`unknown --mode ${MODE} (daily|speed|hot)`); process.exit(2); }

const P = T.pipeline;
const Q = P.qualify_score, WIN = P.window_hours;
const SCORING_MODEL = P.scoring_model || 'sonnet';
const REPORT_MODEL = P.report_model || 'sonnet';
const SCORE_CAP = Number(P.score_cap) || (MODE === 'daily' ? 25 : 10);
const REPORT_CAP = Number(P.report_cap) || 5;
const DAILY_CLAUDE_CAP = Number(P.daily_claude_cap) || 40;
const MAX_TURNS = String(Number(P.claude_max_turns) || 60);
const CLAUDE_TIMEOUT_MS = (Number(P.claude_timeout_min) || 30) * 60e3;
const CLAUDE_FLAGS = Array.isArray(P.claude_flags) ? P.claude_flags : ['--dangerously-skip-permissions'];
const PRIMARY = T.targets.primary_role;
const ROLES = T.targets.roles;
const AREA = areaLabel();
const NAME = T.candidate?.full_name || 'the candidate';

// ── logging ─────────────────────────────────────────────────────────────────────────────────
mkdirSync('data', { recursive: true });
const PLOG = MODE === 'hot' ? 'data/_hot.log' : MODE === 'speed' ? 'data/_speed-cron.log' : 'data/_pipeline.log';
// Local time (matches localDate() and the digest's local date; UTC made a just-finished run look missing).
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
/** 'exit N', or 'killed SIGxxx' when a signal ended the child (status null). */
const exitStr = r => r.status === null && r.signal ? `killed ${r.signal}` : `exit ${r.status}`;
/** LOCAL calendar date (YYYY-MM-DD). Never toISOString(): UTC rolls to tomorrow in the evening. */
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');
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
  // Chrome/Chromium binary (env CAREER_FINDER_CHROME -> macOS bundle -> PATH). No Chrome = no logged-in LinkedIn.
  chrome: await (async () => { try { return !!(await import('./chrome-debug.mjs')).resolveChromeBin(); } catch { return false; } })(),
  // Opt-in integrations: gated on config/profile.yml, never on host state alone.
  // LinkedIn defaults ON (onboarding enables it); only an explicit `false` turns it off.
  linkedin_on: T.integrations?.linkedin !== false,
  gmail_on: T.integrations?.gmail === true,
};
// Gmail MCP precheck (#16): OAuth files alone do not prove the MCP server is registered with claude.
PRE.gmail_mcp = (() => {
  if (MODE !== 'daily' || !PRE.gmail_on || !PRE.claude) return false;
  const r = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 20e3 });
  return r.status === 0 && /gmail/i.test((r.stdout || '') + (r.stderr || ''));
})();
const WHY_MISSING = {
  claude: 'claude CLI not on PATH (install Claude Code)',
  browser: 'no debug browser on port 9222 (node scripts/chrome-debug.mjs start, then log into LinkedIn)',
  gmail: `no Gmail OAuth credentials in ${GMAIL_DIR}`,
  go: 'go toolchain not installed',
  linkedin_on: 'integrations.linkedin is false in config/profile.yml',
  gmail_on: 'integrations.gmail is not enabled in config/profile.yml',
  gmail_mcp: 'no gmail MCP server in `claude mcp list` (or it timed out); outcomes NOT checked, this is not a "0 outcomes" result',
  chrome: 'linkedin: SKIPPED (no Chrome); set CAREER_FINDER_CHROME or install Chrome/Chromium',
};

// Lane -> skill/mode it executes (#: every lane prints its skill in the run summary). Longest prefix wins.
const LANE_SKILL = {
  'quota-replay': 'offer', discover: 'discover (Headless)', 'discover-companies': 'discover', 'probe-ats': 'discover',
  linkedin: 'scan-web (LinkedIn lanes)', 'linkedin:guest': 'speed', 'linkedin:email-alerts': 'scan-web',
  ats: 'scan-index', 'ats:repair-index': 'scan-index', 'portals-scan': 'scan', hiringcafe: 'scan-web', workable: 'scan-web',
  'browser-boards': 'scan-web', websearch: 'scan-web (Headless)', 'web-roles': 'scan-web', 'resolve-nominations': 'pipeline',
  'hot-list': 'speed', hot: 'speed', 'speed:primary-gap': 'speed', score: 'offer + pipeline', 'speed-metrics': 'speed',
  'snapshot-jd': 'pipeline', 'jd-pdfs': 'pipeline', 'backfill-reports': 'offer', reports: 'offer (A-G)', 'merge-tracker': 'tracker',
  'prune-qualifiers': 'qualifiers', 'prune-board': 'dashboard', reconcile: 'qualifiers', 'feedback-outcomes': 'feedback',
  'web-roles-learn': 'scan-web', 'pipeline-owed': 'pipeline', 'outreach-bullets': 'outreach', 'verify-outreach': 'outreach (verify)',
  quota: 'speed', 'near-miss': 'offer', 'keep-search': 'scan-index + offer', 'keep-search:web': 'scan-web (Headless)',
  outcomes: 'feedback (Outcomes)', 'rotate-logs': '-', digest: 'dashboard', 'dashboard:build': 'dashboard',
};
const skillOf = name => { const p = name.split(':'); for (let i = p.length; i > 0; i--) { const k = p.slice(0, i).join(':'); if (LANE_SKILL[k]) return LANE_SKILL[k]; } return '-'; };

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

let LOCK = null;
/** Keep the lock fresh while the run is alive, so the 2h stale window only reclaims dead runs. */
function touchLock() { if (LOCK) { try { const t = new Date(); utimesSync(LOCK, t, t); } catch {} } }

/** Run a node script. Non-fatal by default; returns the exit status (0 in dry-run). */
function node(name, script, args = [], { needs = [], stdoutTo = null, when, whyNot, dryArgs = null, dryCount = null } = {}) {
  if (!lane(name, { needs, script, when, whyNot })) return null;
  if (DRY && dryArgs) {
    // Zero-cost read-only lane: actually run it in its no-write mode and report real counts.
    const r = spawnSync(process.execPath, [script, ...dryArgs], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15 * 60e3 });
    const counts = r.status === 0 && dryCount ? dryCount(r.stdout || '') : '';
    results.push([name, r.status === 0 ? 'dry ok' : exitStr(r), counts]);
    log(`[dry-run] ${name}: node ${script} ${dryArgs.join(' ')} -> ${r.status === 0 ? counts || 'ok' : exitStr(r)}`);
    return r.status;
  }
  if (DRY) { results.push([name, 'would run', `node ${script} ${args.join(' ')}`]); log(`[dry] ${name}: node ${script} ${args.join(' ')}${stdoutTo ? ' > ' + stdoutTo : ''}`); return 0; }
  log(`[run] ${name}`);
  touchLock();
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 45 * 60e3 });
  if (stdoutTo) writeFileSync(stdoutTo, r.stdout || '');
  else if (r.stdout) appendFileSync(PLOG, r.stdout);
  if (r.stderr) appendFileSync(PLOG, r.stderr);
  results.push([name, r.status === 0 ? 'ok' : exitStr(r), '']);
  if (r.status !== 0) log(`[warn] ${name}: ${exitStr(r)}${r.error ? ` (${r.error.code || r.error.message})` : ""} (non-fatal)`);
  return r.status;
}

let quotaWall = false, capHit = false, limitHits = 0, resetsAt = 'unknown';
const LIMIT_RE = /hit your session limit|usage limit reached|rate limit.*resets|quota exceeded/i;
const CALL_LOG = 'data/_claude-calls.log';
/** Today's `claude -p` calls across every mode (data/_claude-calls.log, keyed by LOCAL date). */
function callsToday() {
  try { const d = localDate(); return readFileSync(CALL_LOG, 'utf8').split('\n').filter(l => l.startsWith(d + '\t')).length; }
  catch { return 0; }
}
/** Run one headless `claude -p` call: model pinned, turns and wall-clock bounded, logged, capped per day. */
function claude(name, prompt, { model = SCORING_MODEL, when, whyNot } = {}) {
  if (quotaWall) { results.push([name, 'skip', 'usage-limit wall earlier in this run']); log(`[skip] ${name}: usage-limit wall earlier in this run`); return null; }
  if (capHit) { results.push([name, 'skip', `daily_claude_cap ${DAILY_CLAUDE_CAP} reached`]); log(`[skip] ${name}: daily_claude_cap reached`); return null; }
  if (!lane(name, { needs: ['claude'], when, whyNot })) return null;
  const args = ['-p', prompt, '--model', model, '--max-turns', MAX_TURNS, ...CLAUDE_FLAGS];
  if (DRY) { results.push([name, 'would run', `claude -p (${model}, max-turns ${MAX_TURNS}, ${prompt.length} chars)`]); log(`[dry] ${name}: claude -p --model ${model} --max-turns ${MAX_TURNS} (${prompt.length}-char prompt; ${callsToday()}/${DAILY_CLAUDE_CAP} calls today)`); return 0; }
  if (callsToday() >= DAILY_CLAUDE_CAP) {
    capHit = true;
    log(`[warn] ${name}: daily_claude_cap ${DAILY_CLAUDE_CAP} reached (${CALL_LOG}); remaining LLM lanes are skipped, run exits 3`);
    results.push([name, 'deferred', `daily_claude_cap ${DAILY_CLAUDE_CAP}`]);
    return 3;
  }
  log(`[run] ${name} (claude ${model})`);
  touchLock();
  const t0 = Date.now();
  const r = spawnSync('claude', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: CLAUDE_TIMEOUT_MS });
  const secs = Math.round((Date.now() - t0) / 1000);
  const out = (r.stdout || '') + (r.stderr || '');
  appendFileSync(PLOG, out + '\n');
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const tail = out.slice(-2000);
  const wall = LIMIT_RE.test(tail);
  const st = wall ? 'usage-limit' : timedOut ? 'timeout' : exitStr(r);
  appendFileSync(CALL_LOG, `${localDate()}\t${new Date().toISOString()}\t${MODE}\t${name}\t${model}\t${secs}s\t${st}\n`);
  touchLock();
  if (wall) {
    quotaWall = true; limitHits++;
    const m = /resets\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(tail); if (m) resetsAt = m[1].replace(/\s+/g, '');
    log(`[warn] ${name}: claude hit a usage limit; remaining LLM lanes are skipped and the queue rolls to the next run`);
    results.push([name, 'deferred', 'usage limit']);
    return 3;
  }
  if (timedOut) { log(`[warn] ${name}: claude timed out after ${secs}s (claude_timeout_min)`); results.push([name, 'exit timeout', `killed after ${secs}s`]); return 124; }
  results.push([name, r.status === 0 ? 'ok' : exitStr(r), out.trim().split('\n').pop()?.slice(0, 120) || '']);
  return r.status;
}
/** Exit-3 bookkeeping: quota-guard marker, plus the speed/hot backoff file. */
function recordWall() {
  if (DRY || !quotaWall) return;
  spawnSync(process.execPath, ['scripts/quota-guard.mjs', 'mark', '--mode', MODE, '--resets', resetsAt, '--hits', String(limitHits || 1)], { encoding: 'utf8' });
  if (MODE !== 'daily') writeFileSync('data/_hot-quota-backoff', `${new Date().toISOString()} ${MODE} usage wall, resets ${resetsAt}\n`);
  log(`[warn] usage wall recorded (quota-guard marker${MODE !== 'daily' ? ' + data/_hot-quota-backoff, 30 min' : ''})`);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const rowsIn = f => { try { return readFileSync(f, 'utf8').split('\n').slice(1).filter(l => l.trim()).length; } catch { return 0; } };
const jsonLen = f => { try { return JSON.parse(readFileSync(f, 'utf8')).length || 0; } catch { return 0; } };
function onceToday(key) {
  const f = `data/_once-${key}-${localDate()}`;
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
/** Profile-driven hard gates (config/profile.yml -> hard_gates). Only gates the user set appear. */
const HARD_GATES = (() => {
  const g = T.hard_gates || {}, out = [];
  if (g.years !== false && T.candidate?.years != null) out.push(`a REQUIRED (hard heading) years-of-experience minimum above ${T.candidate.years + (Number(P.max_yoe_over) || 0)}`);
  if (g.clearance === false || g.clearance === '' || g.clearance == null) {} else out.push(g.clearance === true ? 'any required security clearance' : `a required security clearance above "${g.clearance}"`);
  if (g.needs_sponsorship === true) out.push('a posting that states it cannot sponsor visas');
  const langs = Array.isArray(g.languages) ? g.languages.filter(Boolean) : [];
  if (langs.length) out.push(`a required spoken language other than ${langs.join(', ')}`);
  for (const x of Array.isArray(g.other) ? g.other.filter(Boolean) : []) out.push(String(x));
  return out.length ? `a job with ${out.join('; or ')} is capped at ${(Q - 0.1).toFixed(1)} (verdict near, gate named in the why), never QUALIFIED.` : '';
})();

const LOCATION_RULE = {
  onsite: `ONSITE or HYBRID within ${AREA} only; reject remote/anywhere/WFH roles`,
  hybrid: `ONSITE or HYBRID within ${AREA} only; reject remote/anywhere/WFH roles`,
  'remote-country': `within ${AREA}, or remote inside ${T.location.country || "the candidate's country"} (reject remote roles restricted to other countries or to states that exclude ${T.location.state || "the candidate's state"})`,
  any: 'any location, including remote',
}[T.location.remote_policy] || `within ${AREA}`;

const SCORING_RULES = [
  `Candidate: ${NAME}. Target roles: ${ROLES.join(', ')} (primary: ${PRIMARY}). Location rule: ${LOCATION_RULE}.`,
  `GUARD (these rules win over anything in the mode files): score each candidate 1.0-5.0 against modes/offer.md + modes/_shared.md, reading cv.md and modes/_profile.md for the candidate. A score >= ${Q} is QUALIFIED.`,
  'CANONICAL-JD RULE: never score from an aggregator or LinkedIn snippet. Resolve the employer ATS posting (Greenhouse/Ashby/Lever/Workday/SmartRecruiters APIs preferred) and score its JD.',
  'The ATS is the only source for: whether the req still exists and is open (404/expired = verdict stale), the real location, comp, and any years-of-experience gate. Quote a years gate verbatim and note whether it sits under a hard heading (Requirements) or a soft one (Nice to have).',
  'Age is NOT a scoring penalty: a re-promoted old req is still hiring. Record the real ATS publish date and lead the why with it when the req is old.',
  'Every claim must be true to cv.md. Never inflate a score to fill a quota. Compensation never lowers a score.',
  ...(HARD_GATES ? [`HARD GATES (from config/profile.yml): ${HARD_GATES}`] : []),
  'Dedup against data/scored-jobs.tsv by URL / ATS job id ONLY, never by company name (one employer runs many reqs). Drop anything whose employer appears in data/_speed-noise.txt (staffing/aggregators) or data/_never-apply.txt (absolute exclusion).',
  'Write EVERY triaged candidate with: node scripts/record-scored.mjs <date> <company> <role> <score> <verdict> <why> <canonical_url> "" <source_lane>  (pass an EMPTY found_at so it defaults to NOW: found_at is when this run found it, never the ATS/aggregator posted date, which is not a freshness gate on nomination lanes; source_lane = the lane that surfaced the row, e.g. scan-index | hiringcafe | linkedin | websearch | discover; verdict QUALIFIED/near/pass/stale/SKIP; why <= 200 chars, no tabs).',
  `For a score >= ${Q} also append to data/qualifiers.tsv (tab-separated: date, company, role, score, why, url, source, posted_iso where posted_iso is the CURRENT time, i.e. when this run qualified it, NOT the ATS/aggregator date) if the url is not already there.`,
].join('\n');
/** Every scoring prompt opens with this (#12): the skill owns the method, SCORING_RULES is the guard. */
const FOLLOW_OFFER = 'Follow modes/offer.md (scoring method and dimensions) for every candidate.';
/** Headless section loader text (#5): load only the `## Headless` section; inline text overrides it. */
const headless = mode => `Read ONLY the "## Headless" section of modes/${mode}.md (not the rest of that file) and follow it; the instructions below override it.`;

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
/** Load linkedin.com/jobs (jobs pages only, never the feed) in a background tab and report 'ok' | 'logged-out' | 'checkpoint' | 'chrome-down' | 'error'. */
async function linkedinLoginState() {
  const forced = process.env.MORNING_LI_LOGIN_STATE;
  if (forced) return { state: forced, url: '(forced by MORNING_LI_LOGIN_STATE)' };
  if (!(await ensureChrome())) return { state: 'chrome-down', url: '' };
  let page;
  try {
    const { newPage } = await import('./cdp.mjs');
    page = await newPage();
    await page.navigate('https://www.linkedin.com/jobs/', { waitMs: 3500, loadTimeout: 45000 });
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

// ── kill switches (all before the lock) ─────────────────────────────────────────────────────
/** Log a SKIPPED line to this mode's log (even in dry-run it prints) and exit 0. */
function skipRun(why) {
  const line = `${stamp()} === career-finder ${MODE} run SKIPPED: ${why} ===`;
  console.log(line);
  if (!DRY) appendFileSync(PLOG, line + '\n');
  process.exit(0);
}
if (existsSync('data/PIPELINE_OFF')) {
  const since = (() => { try { return (readFileSync('data/PIPELINE_OFF', 'utf8').match(/^since:\s*(\S+)/m) || [])[1]; } catch { return null; } })();
  skipRun(`data/PIPELINE_OFF${since ? ` (since: ${since})` : ''}; resume with npm run pipeline:on`);
}
try {
  const today = localDate();
  const dates = readFileSync('data/_pipeline-skip-dates.txt', 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  if (dates.includes(today)) skipRun(`${today} is listed in data/_pipeline-skip-dates.txt`);
} catch {}
if (MODE === 'hot' && existsSync('data/HOT_OFF')) skipRun('data/HOT_OFF present (hot mode paused)');
if (MODE !== 'daily') {
  try {
    const age = Date.now() - statSync('data/_hot-quota-backoff').mtimeMs;
    if (age < 30 * 60e3) skipRun(`usage-wall backoff (data/_hot-quota-backoff, ${Math.ceil((30 * 60e3 - age) / 60e3)} min left)`);
  } catch {}
}

// ── lock: daily + hot share one, speed has its own ──────────────────────────────────────────
LOCK = resolve(process.env.TMPDIR || '/tmp', MODE === 'speed' ? 'career-finder-speed.lock' : 'career-finder-pipeline.lock');
if (DRY) LOCK = null;
else {
  try { if (Date.now() - statSync(LOCK).mtimeMs > 2 * 3600e3) rmdirSync(LOCK); } catch {}
  try { mkdirSync(LOCK); } catch { LOCK = null; skipRun('locked (another run holds the lock)'); }
  const lockPath = LOCK;
  const release = () => { try { rmdirSync(lockPath); } catch {} };
  process.on('exit', release);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(130); });
}

log(`=== career-finder ${MODE} run start${DRY ? ' (DRY RUN)' : ''} — ${ROLES.join(', ')} · ${AREA} · bar ${Q} · window ${WIN}h ===`);
log(`prereqs: claude=${PRE.claude} browser=${PRE.browser} gmail=${PRE.gmail} go=${PRE.go} · integrations: linkedin=${PRE.linkedin_on} gmail=${PRE.gmail_on} · claude calls today ${callsToday()}/${DAILY_CLAUDE_CAP}`);

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
  claude('hot:score', `${FOLLOW_OFFER}\nHOT-TIER scoring (headless). Candidates: data/_hot-candidates.tsv (header row; they already passed the title, location, recency and dedup filters and carry the canonical ATS url and posted timestamp). Process at most ${SCORE_CAP}.\n${SCORING_RULES}\nEnd with one line: 'hot: scored N, qualified M'.`,
    { when: DRY || n > 0, whyNot: 'no new hot candidates' });
  node('reconcile', 'scripts/reconcile-qualifiers.mjs');
  node('rotate-logs', 'scripts/rotate-logs.mjs', ['--quiet']);
  node('quota', 'scripts/daily-quota.mjs');   // #30: hot ends with the quota line (exit 1 = short, an outcome)
  recordWall();
  log(`=== hot run done ===`);
  process.exit(quotaWall || capHit ? 3 : 0);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. SCANS (zero LLM unless noted)
// ════════════════════════════════════════════════════════════════════════════════════════════
const KW = searchKeywords().join(',');
const DAILY = MODE === 'daily';

// 0. Deferred-backlog replay: a previous run hit a usage wall, so score what it collected first.
if (DAILY) {
  const qs = DRY ? { status: 1 } : spawnSync(process.execPath, ['scripts/quota-guard.mjs', 'status'], { encoding: 'utf8' });
  if (DRY) log('[dry] quota-replay: runs only when quota-guard status reports a deferred backlog');
  else if (qs.status === 0) {
    log(`quota-replay: ${(qs.stdout || '').trim()}`);
    const rc = claude('quota-replay:score', `${FOLLOW_OFFER}\nDEFERRED-BACKLOG scoring (headless). A previous run collected these candidates but hit a usage limit before scoring. Candidates: data/_candidates.tsv (header row), data/_web-roles.tsv, data/_aged-roles.tsv. Skip any url already in data/scored-jobs.tsv. HARD CAP: process AT MOST ${SCORE_CAP}, ${PRIMARY} first, most recent first.\n${SCORING_RULES}\nEnd with one line: 'replay: scored N, qualified M'.`);
    if (rc === 0) node('quota-replay:clear', 'scripts/quota-guard.mjs', ['clear']);
  } else results.push(['quota-replay', 'skip', 'no deferred backlog']);
}

// 0b. Hot-list bootstrap (#30): rebuild when empty or older than 7 days, so opt-in hot mode has a list.
if (DAILY) {
  const hotAge = (() => { try { return Date.now() - statSync('data/hot-companies.tsv').mtimeMs; } catch { return Infinity; } })();
  node('hot-list:build', 'scripts/hot-list.mjs', ['--build'],
    { when: rowsIn('data/hot-companies.tsv') === 0 || hotAge > 7 * 864e5, whyNot: 'data/hot-companies.tsv is fresh (<7d)' });
}

// 1a. Grow the company index once a day (LLM, WebSearch).
if (DAILY && (DRY || onceToday('discover'))) {
  claude('discover', `${headless('discover')}\nFind NEW companies with a public ATS job board (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday) that hire ${ROLES.join(' / ')} roles ${T.location.remote_policy === 'any' ? 'anywhere' : `in or near ${AREA}`}. Use WebSearch + WebFetch only. Skip any company whose board URL already appears in column 3 of data/company-index.tsv or in data/_discovered-companies.tsv, and anything in data/_speed-noise.txt or data/_never-apply.txt. Verify each board URL loads real postings for THAT company (an ATS returns 200 for nonsense slugs, so confirm the company name on the page). Append up to 25 verified finds to data/_discovered-companies.tsv as two tab-separated columns: company name, board URL. End with one line: 'discover: +N'.`, { model: SCORING_MODEL });
}

// 1b. LinkedIn. Logged-in lanes: 3 searches per role (crawl, faceted, semantic), past 24h,
// max 4 roles, strictly serial with jittered pacing. A missing login is a FAILED lane.
const LI_ROLES = ROLES.slice(0, 4);
const LI_PAGES = String(Math.max(1, Number(P.linkedin_pages ?? T.integrations?.linkedin_pages) || 2));
// Tier-3 Apply-href rescue: each is one extra logged-in page load, so it is capped by the profile
// (integrations.linkedin_rescue, default 5; 0 disables it) instead of the crawl's built-in 20.
const LI_RESCUE = Math.max(0, Math.floor(Number(P.linkedin_rescue ?? T.integrations?.linkedin_rescue ?? 5)) || 0);
const LI_RESCUE_ARGS = LI_RESCUE > 0 ? ['--rescue-max', String(LI_RESCUE)] : ['--no-rescue'];
const liWanted = PRE.linkedin_on && !selected(SKIP, 'linkedin') && (!ONLY.size || [...ONLY].some(o => o === 'linkedin' || o.startsWith('linkedin:')));
// Logged-in LinkedIn runs ONLY inside DAILY (never speed/hot), and only when a Chrome binary resolves.
if (DAILY && liWanted && !PRE.chrome) {
  results.push(['linkedin', 'skip', WHY_MISSING.chrome]); log(`[skip] ${WHY_MISSING.chrome}`);
} else if (DAILY && liWanted && existsSync('data/LINKEDIN_OFF')) {
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
        [`linkedin:crawl:${role}`, 'scripts/linkedin-crawl.mjs', ['--keywords', role, '--hours', '24', '--ats-hours', '48', '--pages', LI_PAGES, ...LI_RESCUE_ARGS, '--write']],
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
  // Direct scan-index (run-pipeline.mjs is retired; its discover-companies step is the fan-in lane below).
  node('ats:index', 'scripts/scan-index.mjs', ['--hours', INDEX_HOURS, '--out', 'data/_candidates.tsv'],
    { dryArgs: ['--hours', INDEX_HOURS, '--dry-run'], dryCount: scanIndexCounts });
} else {
  // --browser-queue is NOT passed: browser-boards.mjs does not drain data/_browser-queue.tsv (#19).
  node('ats:index', 'scripts/scan-index.mjs', ['--hours', '12', '--out', 'data/_candidates.tsv']);
  // #29 primary-gap sweep: when the board is missing the primary role, widen to 24h on it alone.
  const dq = DRY ? null : (() => { try { return JSON.parse(spawnSync(process.execPath, ['scripts/daily-quota.mjs', '--json'], { encoding: 'utf8' }).stdout); } catch { return null; } })();
  if (node('speed:primary-gap', 'scripts/scan-index.mjs', ['--primary-only', '--hours', '24', '--out', 'data/_candidates-primary-gap.tsv'],
    { when: DRY || (dq && dq.primaryOk === false), whyNot: dq ? `${PRIMARY} already on the board` : 'daily-quota --json unreadable' }) === 0) {
    const n = appendRows('data/_candidates-primary-gap.tsv', 'data/_candidates.tsv');
    if (n) log(`primary-gap: +${n} ${PRIMARY} candidate(s) for scoring (under SCORE_CAP ${SCORE_CAP})`);
  }
}

// 1c'. portals.yml scan (#18, zero LLM). Writes data/pipeline.md; scoring dedups it against scan-index.
if (DAILY) node('portals-scan', 'scripts/scan.mjs', [], { when: existsSync('portals.yml'), whyNot: 'no portals.yml' });

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
if (DAILY && (DRY || onceToday('websearch'))) {
  claude('websearch', `${headless('scan-web')}\nHeadless web search for NEW job postings (WebSearch + WebFetch only, no browser). If data/web-search-learnings.md exists, read it first and follow its playbook. GOAL: postings published in the last ${WIN} hours for these titles: ${ROLES.join(', ')}. Location rule: ${LOCATION_RULE}. For each find, resolve the employer's own ATS posting; drop anything without one, anything from a staffing agency or aggregator relist, and any employer in data/_speed-noise.txt or data/_never-apply.txt. Skip urls already in data/scored-jobs.tsv or data/_web-roles.tsv. Append each verified find to data/_web-roles.tsv as tab-separated columns: date, company, role, location, posted, url, source. Then run: node scripts/web-roles.mjs --clean. End with one line: 'web: +N'.`, { model: SCORING_MODEL });
}

// 1g. Fan-in: resolve boards for newly named employers, sweep them, clean queues.
if (DAILY) {
  node('probe-ats', 'scripts/probe-ats.mjs', ['--unresolved', '--append']);
  // #17 single owner of discover-companies. No queue gate: seeds + YC run even with an empty queue.
  // YC is on by default; `discovery.yc: false` turns it off.
  const dcArgs = [...(existsSync('data/_discovered-companies.tsv') ? ['--from', 'data/_discovered-companies.tsv'] : []),
    ...(T.discovery?.yc === false ? [] : ['--yc'])];
  node('discover-companies', 'scripts/discover-companies.mjs', dcArgs);
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
const scoreStatus = claude('score', `${FOLLOW_OFFER} Queue handling follows modes/pipeline.md.
Pipeline scoring (headless). HARD CAP: process AT MOST ${SCORE_CAP} candidates this run; the rest roll to the next run. Fill up to ${Math.ceil(SCORE_CAP * 0.6)} slots with ${PRIMARY} candidates first, then the other target roles, most recent first; spill unused slots either way.
Candidates: data/_candidates.tsv (ATS, header row), data/_speed-li.json (LinkedIn cards), data/_web-roles.tsv (header: date/company/role/location/posted/url/source).
For any candidate whose url is on linkedin.com, look it up in data/_resolved-noms.tsv by company+role and score its canonical_url instead; skip rows marked AMBIGUOUS. Score candidates that already have a real ATS url before linkedin.com ones.
${DAILY ? `Also the unchecked entries that scripts/scan.mjs added to data/pipeline.md today (portals.yml companies); skip any whose url or ATS job id is already in data/_candidates.tsv (scan-index found it too).\n` : ''}For rows whose source is hiringcafe, data/_hiringcafe.tsv (keyed by url) carries min_yoe, seniority, workplace_type and comp: use it as a starting point, never as the verdict.
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
  const owedReports = (() => { try { return JSON.parse(execFileSync(process.execPath, ['scripts/pipeline-owed.mjs', '--json'], { encoding: 'utf8', timeout: 60000 })).filter(j => (j.missing || []).some(m => m === 'report' || m === 'full-report')).length; } catch { return 1; } })();
  claude('reports', `Follow modes/offer.md (blocks A-G). Write the FULL A-G evaluation reports owed. HARD CAP: write AT MOST ${REPORT_CAP} reports this run (highest score first); the rest stay owed for the next run. STEP 1: run 'node scripts/pipeline-owed.mjs --json' and take every job whose missing list includes 'report' or 'full-report' (a stub exists but a real evaluation is owed). If none, end with 'reports: 0 owed'. STEP 2: for each, read modes/offer.md, modes/_shared.md, modes/_profile.md and cv.md, and the canonical JD (use data/jds/ when a snapshot exists). STEP 3: write reports/{NNN}-{company-slug}-{role-slug}-{YYYY-MM-DD}.md where NNN comes from 'node scripts/next-report-num.mjs', incrementing per report. Blocks A-G; header carries Date, Posted (real ATS age), Archetype, Score, URL, JD, PDF and Legitimacy, plus '**Verification:** unconfirmed (batch mode)' (no browser in headless runs) and '**PDF:** ❌' (no PDF is generated headless). ${HARD_GATES ? `HARD GATES: ${HARD_GATES} ` : ''}RULES: every claim true to cv.md; quote any years gate verbatim and say whether it clears; name the exact requisition and never merge two reqs at one employer; flag location contradictions between ATS fields and the JD body; never inflate a score to match the ledger. STEP 4: for each report write batch/tracker-additions/{NNN}-{company-slug}.tsv (9 tab-separated columns: num, date, company, role, status, score, pdf (always ❌ here), report-link, notes) then run 'node scripts/merge-tracker.mjs'. FORMAT: copy the layout of the most recent full report in reports/; if none exists, use the block order and headings of modes/offer.md (A-G) as the template. STEP 5: re-run 'node scripts/pipeline-owed.mjs' and use its count for M. End with one line: 'reports: wrote N, owed now M'.`, { model: REPORT_MODEL, when: DRY || owedReports > 0, whyNot: 'pipeline-owed: no reports owed' });
  // Stubs AFTER the A-G lane, only for qualifiers the report cap left uncovered; running it first
  // gave one job a stub plus a full report under two numbers.
  node('backfill-reports', 'scripts/backfill-reports.mjs', ['--min', String(Q)]);
}
node('merge-tracker', 'scripts/merge-tracker.mjs');

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. HOUSEKEEPING + LEARNING
// ════════════════════════════════════════════════════════════════════════════════════════════
node('prune-qualifiers', 'scripts/prune-qualifiers.mjs');
if (DAILY) node('prune-board', 'scripts/prune-board.mjs');
node('reconcile', 'scripts/reconcile-qualifiers.mjs');
if (DAILY) {
  node('web-roles-learn', 'scripts/web-roles-learn.mjs');
  node('pipeline-owed', 'scripts/pipeline-owed.mjs');
  // Outreach bullets only: contact discovery and drafting stay interactive and draft-only.
  node('outreach-bullets', 'scripts/drain-outreach.mjs', ['--bullets-only', '--limit', '5', '--quiet'], { needs: ['claude'] });
  verifyOutreach();
}

/** #20: judge outreach drafts touched in the last 24h (draft-only; a fail never fails the run). */
function verifyOutreach() {
  const name = 'verify-outreach';
  const on = T.pipeline?.verify_outreach !== false;
  const drafts = (() => { try { return readdirSync('output/outreach').filter(f => f.endsWith('.html'))
    .map(f => `output/outreach/${f}`).filter(f => Date.now() - statSync(f).mtimeMs < 864e5); } catch { return []; } })();
  const cap = 5;
  if (!lane(name, { needs: ['claude'], script: 'scripts/verify-stage.mjs',
    when: on && !existsSync('data/VERIFY_OFF') && !quotaWall && !capHit && drafts.length > 0,
    whyNot: !on ? 'pipeline.verify_outreach: false' : existsSync('data/VERIFY_OFF') ? 'data/VERIFY_OFF' : (quotaWall || capHit) ? 'usage wall / daily_claude_cap' : 'no outreach drafts in the last 24h (no claude call)' })) return;
  if (!DRY && !onceToday('verify-outreach')) { results.push([name, 'skip', 'already ran today']); return; }
  if (DRY) { results.push([name, 'would run', `${Math.min(cap, drafts.length)} draft(s)`]); return; }
  let fails = 0, done = 0;
  for (const f of drafts.slice(0, cap)) {
    if (callsToday() >= DAILY_CLAUDE_CAP) { capHit = true; log(`[warn] ${name}: daily_claude_cap reached`); break; }
    touchLock();
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['scripts/verify-stage.mjs', '--stage', 'outreach', '--artifact', f, '--model', 'sonnet'], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: CLAUDE_TIMEOUT_MS });
    appendFileSync(CALL_LOG, `${localDate()}\t${new Date().toISOString()}\t${MODE}\t${name}\tsonnet\t${Math.round((Date.now() - t0) / 1000)}s\texit ${r.status}\n`);
    appendFileSync(PLOG, (r.stdout || '') + (r.stderr || ''));
    done++;
    if (r.status === 1) { fails++; log(`[warn] ${name}: ${f} FAILED the outreach judge. Do NOT send it until fixed.`); }
  }
  results.push([name, 'ok', `${done} checked, ${fails} failed${fails ? ' (Do NOT send)' : ''}`]);
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
// Keep-search order (#28): near-miss re-score -> web rounds (MAX_ROUNDS, default 0) -> index backstop.
const MAX_ROUNDS = Math.max(0, Number(P.keep_search?.max_rounds) || 0);
if (DAILY && q && !q.met) {
  log(`quota SHORT: ${q.total}/${q.minCount} qualifiers, ${q.primary}/${q.primaryQuota} ${PRIMARY}; keep-search: near-miss, ${MAX_ROUNDS} web round(s), index backstop`);
  // Round 0 (#11): re-score recent near-misses against the canonical JD, capped, once a day.
  if (onceToday('near-miss')) {
    if (node('near-miss:pool', 'scripts/near-miss-pool.mjs', ['--days', '7', '--primary-only'], { stdoutTo: 'data/_near-miss-pool.txt' }) === 0
        && readFileSync('data/_near-miss-pool.txt', 'utf8').trim()) {
      claude('near-miss:score', `${FOLLOW_OFFER}\nNEAR-MISS re-score (headless). data/_near-miss-pool.txt lists recent ${PRIMARY} jobs that scored just under ${Q}. Re-read each canonical ATS JD and re-score it honestly; a re-score that clears ${Q} must be justified by the JD, never by the quota. Process AT MOST 10.\n${SCORING_RULES}\nEnd with one line: 'near-miss: rescored N, qualified M'.`);
      node('reconcile', 'scripts/reconcile-qualifiers.mjs');
      q = quota() || q;
    }
  } else results.push(['near-miss', 'skip', 'already ran today']);
  for (let round = 1; q && !q.met && round <= MAX_ROUNDS && !quotaWall && !capHit; round++) {
    claude(`keep-search:web:${round}`, `${headless('scan-web')}\nKEEP-SEARCH web round ${round}/${MAX_ROUNDS}: the board is short on ${PRIMARY}. Search ONLY for ${PRIMARY} postings from the last ${WIN} hours. Location rule: ${LOCATION_RULE}. Append verified finds to data/_web-roles.tsv (date, company, role, location, posted, url, source), then score ONLY those new rows (at most ${SCORE_CAP}).\n${SCORING_RULES}\nEnd with one line: 'keep-search web: +N, qualified M'.`);
    node('reconcile', 'scripts/reconcile-qualifiers.mjs');
    q = quota() || q;
  }
}
if (DAILY && q && !q.met) {
  if (node('keep-search:primary', 'scripts/scan-index.mjs', ['--primary-only', '--hours', '72', '--out', 'data/_candidates-primary-backstop.tsv']) === 0
      && rowsIn('data/_candidates-primary-backstop.tsv') > 0) {
    claude('keep-search:score', `${FOLLOW_OFFER}\nScore ONLY the candidate rows in data/_candidates-primary-backstop.tsv (header row present). These are ${PRIMARY} candidates from a full-index sweep. Process at most ${SCORE_CAP}.\n${SCORING_RULES}\nEnd with one line: 'backstop: scored N, qualified M'.`);
    node('reconcile', 'scripts/reconcile-qualifiers.mjs');
    q = quota();
  }
}
if (DRY && DAILY) log(`[dry] near-miss, ${MAX_ROUNDS} keep-search:web round(s), keep-search:primary + keep-search:score run only when the quota is short`);
if (!DRY) node('quota:report', 'scripts/daily-quota.mjs');

// ════════════════════════════════════════════════════════════════════════════════════════════
// 6. OUTCOMES (once a day, Gmail read-only) + digest
// ════════════════════════════════════════════════════════════════════════════════════════════
if (DAILY && (DRY || onceToday('outcomes'))) {
  const applied = DRY ? appliedFromTracker() : (() => {
    const r = spawnSync(process.execPath, ['scripts/applied-watchlist.mjs'], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout).length; } catch { return 0; }
  })();
  claude('outcomes', `Read ONLY the "## Outcomes (headless)" section of modes/feedback.md and follow it; the steps below override it.\nApplication outcome detection, READ-ONLY Gmail. STEP 1: run 'node scripts/applied-watchlist.mjs' for the JSON list of in-flight applied jobs. STEP 2: for each, search Gmail (gmail MCP search_emails, read_email) for messages since the applied date from that company. NEVER send, reply, draft, delete, archive, label or modify anything. STEP 3: classify the latest signal: rejected / interview (incl. scheduling links) / offer / responded (a real human reply, not an auto-acknowledgement) / NONE. Be conservative. STEP 4: for each decided signal run 'node scripts/record-outcome.mjs "<company>" <responded|interview|offer|rejected>' (it refuses ambiguous keys; narrow the key with the url if so), never regress a status, and update that row's Status in data/applications.md with a dated '(auto-detected from Gmail)' note; never add rows. Do NOT run feedback-outcomes --learn (the run does that once, after this step). End with one line: 'outcomes: rejected R, interview I, offer O, responded P'.`,
    { needs: ['gmail_on', 'gmail', 'gmail_mcp'], when: applied > 0, whyNot: 'applied-watchlist returned [] (no in-flight applied jobs, no claude call)' });
  node('feedback-outcomes', 'scripts/feedback-outcomes.mjs', ['--learn']);
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
const sw = Math.max(...results.map(r => skillOf(r[0]).length), 5);
for (const [n, s, why] of results) console.log(`  ${n.padEnd(width)}  -> ${skillOf(n).padEnd(sw)}  ${s}${why ? '  — ' + why : ''}`);
log(`=== career-finder ${MODE} run done ===`);

// Any lane that exited non-zero is named here, so a dead lane cannot hide in the table.
// A short quota (daily-quota.mjs exit 1) is an outcome, not a dead lane: its own QUOTA line.
const { failed, quotaShort } = splitFailures(results);
const qLine = DRY ? '' : quotaLine(q, quotaShort, PRIMARY);
if (qLine) console.log(`\n${qLine}`);
if (failed.length) {
if (!DRY) {
  try {
    const { readLedger, aggregate, formatSummary } = await import('./request-ledger.mjs');
    console.log('\n' + formatSummary(aggregate(readLedger({ runId: process.env.CAREER_FINDER_RUN_ID })), `REQUEST LEDGER run ${process.env.CAREER_FINDER_RUN_ID}`));
  } catch (e) { console.log(`\nREQUEST LEDGER: unavailable (${e.message})`); }
}
  console.log(`\nFAILED LANES (${failed.length}):`);
  for (const [n, st, why] of failed) console.log(`  ${n}  ${st}${n.startsWith('linkedin') && why ? '  — ' + why : ''}  (see ${PLOG})`);
}

if (DRY) process.exit(0);
recordWall();
if (quotaWall || capHit) process.exit(3);
if (failed.length) process.exit(1);
process.exit((DAILY && q && !q.met) || quotaShort ? 1 : 0);
