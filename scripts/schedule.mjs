#!/usr/bin/env node
/**
 * schedule.mjs — one-command scheduler for the morning run.
 *
 *   npm run schedule -- install [--with-speed N] [--with-hot [MIN]]   preflight, then write + load the jobs
 *   npm run schedule -- uninstall                                      remove every career-finder job
 *   npm run schedule -- status                                         jobs, last run, call budget, kill switches
 *   npm run schedule -- run-now [daily|speed|hot]                      run one mode now, in the foreground
 *   npm run schedule -- --print [--with-speed N] [--with-hot [MIN]]    print the job definitions, change nothing
 *
 * Every job calls `node scripts/morning.mjs --mode daily|speed|hot` directly (absolute node path,
 * PATH that includes node + claude, the repo as working directory, a log file). There are no shell
 * wrappers; the kill switches and the usage-wall backoff live in morning.mjs.
 *
 * Defaults: daily ON at config/profile.yml schedule.daily_time (default 07:00, local time).
 *   --with-speed N   speed mode N times a day (recommended 2-4), spread 09:00-18:00
 *   --with-hot [MIN] hot mode every MIN minutes (default 60, minimum 30). Refused until
 *                    data/hot-companies.tsv has rows (node scripts/hot-list.mjs --build).
 *
 * Backends: macOS launchd (LaunchAgents, label com.career-finder.<mode>), Linux crontab (a block
 * between `# career-finder BEGIN` and `# career-finder END`, rewritten in place, idempotent).
 * Windows: not automated; see docs/SCHEDULING.md.
 *
 * Other flags:
 *   --platform launchd|cron   force a backend (default: from the OS)
 *   --label-prefix P          job label prefix (default com.career-finder; must start with it)
 *   --skip-preflight          install without doctor / morning --dry-run / claude auth check
 *
 * Env (tests): CAREER_FINDER_LAUNCH_DIR (plist dir; when set, launchctl is never called),
 *              CAREER_FINDER_CRONTAB_CMD (command used instead of `crontab`).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const die = (msg, code = 2) => { console.error(`schedule: ${msg}`); process.exit(code); };

const BASE_PREFIX = 'com.career-finder';
const LEGACY_PREFIX = 'com.careerfinder.'; // hand-written plists from older docs
const PREFIX = opt('--label-prefix', BASE_PREFIX);
if (!PREFIX.startsWith(BASE_PREFIX)) die(`--label-prefix must start with ${BASE_PREFIX} (refusing to touch other labels)`);
const BEGIN = `# ${PREFIX.replace(/^com\./, '')} BEGIN`;
const END = `# ${PREFIX.replace(/^com\./, '')} END`;

const CMD = flag('--print') ? 'print' : (argv.find((a) => !a.startsWith('--') && ['install', 'uninstall', 'status', 'run-now'].includes(a)) || '');
if (!CMD) die('usage: schedule.mjs install|uninstall|status|run-now|--print [--with-speed N] [--with-hot [MIN]]', 2);

const PLAT = opt('--platform', platform() === 'darwin' ? 'launchd' : platform() === 'linux' ? 'cron' : '');
if (CMD !== 'run-now' && !['launchd', 'cron'].includes(PLAT)) {
  die(`${platform()} is not automated. Follow the Windows section of docs/SCHEDULING.md (Task Scheduler).`);
}

// ── profile ──────────────────────────────────────────────────────────────────────────────────
let PROFILE = {};
try { PROFILE = yaml.load(readFileSync('config/profile.yml', 'utf8')) || {}; } catch {}
const PIPE = PROFILE.pipeline || {};
const CAP = Number(PIPE.daily_claude_cap) || 40;
const DAILY_TIME = String(PROFILE.schedule?.daily_time || '07:00');
const tm = DAILY_TIME.match(/^(\d{1,2}):(\d{2})$/);
if (!tm || +tm[1] > 23 || +tm[2] > 59) die(`schedule.daily_time "${DAILY_TIME}" is not HH:MM`);
const DAILY_AT = { h: +tm[1], m: +tm[2] };

// ── requested jobs ───────────────────────────────────────────────────────────────────────────
const speedRaw = flag('--with-speed') ? opt('--with-speed', '3') : null;
const SPEED_N = speedRaw === null ? 0 : Number(speedRaw);
if (speedRaw !== null && (!Number.isInteger(SPEED_N) || SPEED_N < 1 || SPEED_N > 6)) die('--with-speed takes 1-6 runs/day (recommended 2-4)');
const hotRaw = flag('--with-hot') ? opt('--with-hot', '60') : null;
const HOT_MIN = hotRaw === null ? 0 : Number(hotRaw);
if (hotRaw !== null && (!Number.isInteger(HOT_MIN) || HOT_MIN < 30)) die('--with-hot takes an interval in minutes, minimum 30 (default 60)');

/** N speed runs spread evenly 09:00-18:00. */
function speedTimes(n) {
  if (n === 1) return [{ h: 13, m: 0 }];
  return Array.from({ length: n }, (_, i) => { const t = 9 * 60 + Math.round((i * 9 * 60) / (n - 1)); return { h: Math.floor(t / 60), m: t % 60 }; });
}
const JOBS = [{ mode: 'daily', times: [DAILY_AT] }];
if (SPEED_N) JOBS.push({ mode: 'speed', times: speedTimes(SPEED_N) });
if (HOT_MIN) JOBS.push({ mode: 'hot', intervalMin: HOT_MIN });
const label = (mode) => `${PREFIX}.${mode}`;

// ── paths ────────────────────────────────────────────────────────────────────────────────────
const which = (bin) => { const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
// The node path is baked into the plist / cron line. A version-manager path (fnm, nvm, volta,
// asdf) breaks silently when that version is upgraded or removed, so prefer a stable system node.
const VERSIONED_NODE = /node-versions|fnm_multishells|\.nvm\/versions|\.volta\/tools|\.asdf\/installs/;
const NODE = (() => {
  const cur = process.execPath;
  if (!VERSIONED_NODE.test(cur)) return cur;
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find((p) => existsSync(p)) || cur;
})();
const CLAUDE = which('claude');
const PATH_DIRS = [...new Set([dirname(NODE), CLAUDE && dirname(CLAUDE), which('go') && dirname(which('go')),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))];
const PATH_ENV = PATH_DIRS.join(':');
const MORNING = join(ROOT, 'scripts', 'morning.mjs');
const outLog = (mode) => join(ROOT, 'data', `_schedule-${mode}.out`);
const MODE_LOG = { daily: 'data/_pipeline.log', speed: 'data/_speed-cron.log', hot: 'data/_hot.log' };

const LAUNCH_DIR = process.env.CAREER_FINDER_LAUNCH_DIR || join(homedir(), 'Library', 'LaunchAgents');
const USE_LAUNCHCTL = !process.env.CAREER_FINDER_LAUNCH_DIR;
const CRONTAB = process.env.CAREER_FINDER_CRONTAB_CMD || 'crontab';

// ── launchd ──────────────────────────────────────────────────────────────────────────────────
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const calDict = ({ h, m }) => `<dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`;
function plist(job) {
  const when = job.intervalMin
    ? `  <key>StartInterval</key><integer>${job.intervalMin * 60}</integer>`
    : job.times.length === 1
      ? `  <key>StartCalendarInterval</key>\n  ${calDict(job.times[0])}`
      : `  <key>StartCalendarInterval</key>\n  <array>\n${job.times.map((t) => `    ${calDict(t)}`).join('\n')}\n  </array>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- written by scripts/schedule.mjs; remove with: npm run schedule -- uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label(job.mode))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
    <string>${xml(MORNING)}</string>
    <string>--mode</string>
    <string>${job.mode}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH_ENV)}</string>
    <key>CAREER_FINDER_SCHEDULED</key><string>1</string>
  </dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><false/>
${when}
  <key>StandardOutPath</key><string>${xml(outLog(job.mode))}</string>
  <key>StandardErrorPath</key><string>${xml(outLog(job.mode))}</string>
</dict>
</plist>
`;
}
const plistPath = (mode) => join(LAUNCH_DIR, `${label(mode)}.plist`);
const ownedPlists = () => (existsSync(LAUNCH_DIR) ? readdirSync(LAUNCH_DIR) : [])
  .filter((f) => f.startsWith(`${PREFIX}.`) && f.endsWith('.plist'));
const legacyPlists = () => (existsSync(LAUNCH_DIR) ? readdirSync(LAUNCH_DIR) : [])
  .filter((f) => f.startsWith(LEGACY_PREFIX) && f.endsWith('.plist'));
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
function launchctl(...args) { if (!USE_LAUNCHCTL) return { status: 0, stdout: '', stderr: '' }; return spawnSync('launchctl', args, { encoding: 'utf8' }); }
function unloadPlist(file) {
  const lbl = file.replace(/\.plist$/, '');
  if (!lbl.startsWith(BASE_PREFIX)) die(`refusing to touch ${lbl}`);
  const r = launchctl('bootout', `gui/${uid()}/${lbl}`);
  if (r.status !== 0) launchctl('unload', '-w', join(LAUNCH_DIR, file));
}
function loadPlist(path) {
  const r = launchctl('bootstrap', `gui/${uid()}`, path);
  if (r.status !== 0) { const r2 = launchctl('load', '-w', path); if (r2.status !== 0) return (r.stderr || r2.stderr || '').trim(); }
  return '';
}

// ── crontab ──────────────────────────────────────────────────────────────────────────────────
function cronSpec(job) {
  if (job.intervalMin) {
    const m = job.intervalMin;
    if (m % 60 === 0) return [`0 ${m === 60 ? '*' : `*/${m / 60}`} * * *`];
    return [`*/${m} * * * *`]; // non-divisors of 60 restart each hour
  }
  return job.times.map(({ h, m }) => `${m} ${h} * * *`);
}
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function cronLines(job) {
  const cmd = `cd ${sh(ROOT)} && PATH=${sh(PATH_ENV)} CAREER_FINDER_SCHEDULED=1 ${sh(NODE)} ${sh(MORNING)} --mode ${job.mode} >> ${sh(outLog(job.mode))} 2>&1`;
  return cronSpec(job).map((spec) => `${spec} ${cmd}  # ${label(job.mode)}`);
}
const cronBlock = () => [BEGIN, '# written by scripts/schedule.mjs; remove with: npm run schedule -- uninstall', ...JOBS.flatMap(cronLines), END].join('\n');
function readCrontab() {
  const r = spawnSync(CRONTAB, ['-l'], { encoding: 'utf8' });
  if (r.error) die(`cannot run ${CRONTAB}: ${r.error.message}`);
  return r.status === 0 ? r.stdout : ''; // "no crontab for user" exits 1
}
function writeCrontab(text) {
  const r = spawnSync(CRONTAB, ['-'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) die(`${CRONTAB} - failed: ${(r.stderr || '').trim()}`);
}
function stripBlock(text) {
  const out = []; let inside = false;
  for (const l of text.split('\n')) {
    if (l.trim() === BEGIN) { inside = true; continue; }
    if (l.trim() === END) { inside = false; continue; }
    if (!inside) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}
const blockOf = (text) => { const a = text.indexOf(BEGIN), b = text.indexOf(END); return a !== -1 && b > a ? text.slice(a, b + END.length) : ''; };
/** Lines OUTSIDE our block that already run the pipeline (hand-written cron, legacy wrappers). */
const foreignCron = (text) => stripBlock(text).split('\n').filter((l) => !l.trim().startsWith('#') && /morning\.mjs|pipeline-cron\.sh|speed-cron\.sh|hot-cron\.sh/.test(l));

// ── shared helpers ───────────────────────────────────────────────────────────────────────────
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA');
const hotRows = () => { try { return readFileSync('data/hot-companies.tsv', 'utf8').split('\n').slice(1).filter((l) => l.trim()).length; } catch { return 0; } };
function callsToday() { try { const d = localDate(); return readFileSync('data/_claude-calls.log', 'utf8').split('\n').filter((l) => l.startsWith(d + '\t')).length; } catch { return 0; } }
/** Rough per-run upper bound on claude -p calls; the hard ceiling is daily_claude_cap. */
function worstCase(jobs) {
  const rounds = Number(PIPE.keep_search?.max_rounds) || 0;
  const per = { daily: 13 + rounds, speed: 2, hot: 1 };
  let sum = 0;
  for (const j of jobs) sum += per[j.mode] * (j.intervalMin ? Math.ceil((24 * 60) / j.intervalMin) : j.times.length);
  return { sum, ceiling: Math.min(sum, CAP) };
}
const DISCLOSURE = Array.isArray(PIPE.claude_flags)
  ? `Unattended claude -p calls use pipeline.claude_flags: ${PIPE.claude_flags.join(' ')}`
  : 'Unattended claude -p calls run with --dangerously-skip-permissions (no one is there to answer a prompt). '
    + 'Set pipeline.claude_flags in config/profile.yml (e.g. ["--allowedTools", "Bash,Read,Write,Edit,WebSearch,WebFetch"]) to restrict them.';
const fmt = ({ h, m }) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const describe = (j) => (j.intervalMin ? `every ${j.intervalMin} min` : j.times.map(fmt).join(', '));

function printDefinitions() {
  if (PLAT === 'launchd') for (const j of JOBS) console.log(`# ${plistPath(j.mode)}\n${plist(j)}`);
  else console.log(cronBlock());
}

function preflight() {
  const step = (name, args, ok, timeout = 300e3) => {
    process.stdout.write(`preflight: ${name} ... `);
    const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout, env: { ...process.env, PATH: `${PATH_ENV}:${process.env.PATH || ''}` } });
    if (ok(r)) { console.log('ok'); return; }
    console.log('FAILED');
    console.error(((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-15).join('\n'));
    die(`${name} failed; fix it, then re-run install (or --skip-preflight to bypass).`);
  };
  step('doctor', [NODE, 'scripts/doctor.mjs'], (r) => r.status === 0);
  step('morning --dry-run', [NODE, MORNING, '--dry-run'], (r) => r.status === 0);
  if (!CLAUDE) die('claude CLI not found on PATH; install it and log in (claude), then re-run.');
  const t0 = Date.now();
  step('claude -p auth check', [CLAUDE, '-p', 'Reply with exactly: OK', '--model', 'sonnet', '--max-turns', '1'],
    (r) => {
      // Count the preflight against the day's budget like every other claude -p call.
      try { appendFileSync(join(ROOT, 'data', '_claude-calls.log'), `${localDate()}\t${new Date().toISOString()}\tinstall\tpreflight-auth\tsonnet\t${Math.round((Date.now() - t0) / 1000)}s\texit ${r.status}\n`); } catch { /* data/ may not exist yet */ }
      return r.status === 0 && /\bOK\b/.test(r.stdout || '');
    }, 120e3);
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────
if (CMD === 'print') { printDefinitions(); process.exit(0); }

if (CMD === 'run-now') {
  const mode = argv.find((a) => ['daily', 'speed', 'hot'].includes(a)) || 'daily';
  // Forward every other flag (--dry-run etc.) to morning.mjs; only the command and mode are ours.
  const fwd = argv.filter((a) => a !== 'run-now' && a !== mode);
  const r = spawnSync(NODE, [MORNING, '--mode', mode, ...fwd], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (CMD === 'install') {
  if (HOT_MIN && hotRows() === 0) die('--with-hot needs rows in data/hot-companies.tsv; build it first: node scripts/hot-list.mjs --build');
  if (PLAT === 'launchd') {
    const legacy = legacyPlists();
    if (legacy.length) die(`legacy jobs found (${legacy.join(', ')}) in ${LAUNCH_DIR}. They would double-run the pipeline. Remove them by hand:\n`
      + legacy.map((f) => `  launchctl unload -w ${join(LAUNCH_DIR, f)} && rm ${join(LAUNCH_DIR, f)}`).join('\n'));
  } else {
    const foreign = foreignCron(readCrontab());
    if (foreign.length) die(`your crontab already runs the pipeline outside the career-finder block. Remove these lines (crontab -e), then re-run:\n${foreign.map((l) => `  ${l}`).join('\n')}`);
  }
  if (!flag('--skip-preflight')) preflight();
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  if (PLAT === 'launchd') {
    mkdirSync(LAUNCH_DIR, { recursive: true });
    const want = new Set(JOBS.map((j) => `${label(j.mode)}.plist`));
    for (const f of ownedPlists()) { unloadPlist(f); if (!want.has(f)) { unlinkSync(join(LAUNCH_DIR, f)); console.log(`removed ${f}`); } }
    for (const j of JOBS) {
      writeFileSync(plistPath(j.mode), plist(j));
      const err = loadPlist(plistPath(j.mode));
      console.log(`${err ? 'written, NOT loaded' : 'installed'}: ${label(j.mode)} (${describe(j)})${err ? ` — ${err}` : ''}`);
    }
  } else {
    const rest = stripBlock(readCrontab());
    writeCrontab(`${rest ? rest + '\n\n' : ''}${cronBlock()}\n`);
    for (const j of JOBS) console.log(`installed: ${label(j.mode)} (${describe(j)})`);
  }
  const wc = worstCase(JOBS);
  console.log(`worst case: ~${wc.sum} claude calls/day, hard ceiling ${wc.ceiling} (pipeline.daily_claude_cap ${CAP}).`);
  if (wc.sum > CAP) console.log(`WARNING: the worst case (~${wc.sum}) exceeds pipeline.daily_claude_cap (${CAP}); late runs will be cut off at the cap. Lower --with-speed/--with-hot or raise the cap.`);
  if (VERSIONED_NODE.test(NODE)) console.log(`WARNING: the schedule uses a version-manager node (${NODE}); upgrading or removing that version breaks it silently. Install a system node (e.g. brew install node) and re-run install.`);
  console.log(DISCLOSURE);
  console.log('Check it with: npm run schedule -- status');
  process.exit(0);
}

if (CMD === 'uninstall') {
  if (PLAT === 'launchd') {
    const files = ownedPlists();
    for (const f of files) { unloadPlist(f); unlinkSync(join(LAUNCH_DIR, f)); console.log(`removed ${f}`); }
    if (!files.length) console.log('no career-finder jobs installed.');
  } else {
    const cur = readCrontab();
    if (!blockOf(cur)) console.log('no career-finder block in crontab.');
    else { const rest = stripBlock(cur); writeCrontab(rest ? rest + '\n' : ''); console.log('removed the career-finder crontab block.'); }
  }
  const legacy = PLAT === 'launchd' ? legacyPlists() : [];
  if (legacy.length) console.log(`not touched (legacy, remove by hand): ${legacy.join(', ')}`);
  process.exit(0);
}

// status
const installed = [];
if (PLAT === 'launchd') {
  for (const f of ownedPlists()) {
    const lbl = f.replace(/\.plist$/, '');
    const body = readFileSync(join(LAUNCH_DIR, f), 'utf8');
    const mode = (body.match(/<string>--mode<\/string>\s*<string>(\w+)<\/string>/) || [])[1] || '?';
    const iv = body.match(/<key>StartInterval<\/key><integer>(\d+)/);
    const times = [...body.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)/g)].map((m) => ({ h: +m[1], m: +m[2] }));
    const r = launchctl('list', lbl);
    const loaded = !USE_LAUNCHCTL ? 'n/a' : r.status === 0 ? 'loaded' : 'NOT loaded';
    const lastExit = (r.stdout?.match(/"LastExitStatus"\s*=\s*(\d+)/) || [])[1];
    installed.push({ lbl, mode, job: iv ? { mode, intervalMin: +iv[1] / 60 } : { mode, times }, loaded, lastExit });
  }
} else {
  const block = blockOf(readCrontab());
  const byMode = {};
  for (const l of block.split('\n')) {
    const m = l.match(/^(\S+) (\S+) \* \* \* .*--mode (\w+)/);
    if (!m) continue;
    const j = byMode[m[3]] ||= { mode: m[3], times: [] };
    if (m[1].startsWith('*/')) j.intervalMin = +m[1].slice(2);
    else if (m[2] === '*' || m[2].startsWith('*/')) j.intervalMin = m[2] === '*' ? 60 : +m[2].slice(2) * 60;
    else j.times.push({ h: +m[2], m: +m[1] });
  }
  for (const j of Object.values(byMode)) installed.push({ lbl: label(j.mode), mode: j.mode, job: j, loaded: 'crontab', lastExit: undefined });
}

console.log(`backend: ${PLAT}${PLAT === 'launchd' ? ` (${LAUNCH_DIR})` : ''}`);
if (!installed.length) console.log('jobs: none installed (npm run schedule -- install)');
for (const i of installed) {
  const ls = (() => { try { return readFileSync(MODE_LOG[i.mode] || '', 'utf8').split('\n'); } catch { return []; } })();
  const lastStart = [...ls].reverse().find((l) => /=== career-finder \w+ run (start|SKIPPED)/.test(l)) || '';
  const lastDone = [...ls].reverse().find((l) => /=== career-finder \w+ run done/.test(l)) || '';
  const when = (lastStart.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) || ['never'])[0];
  const state = /SKIPPED/.test(lastStart) ? 'skipped' : lastStart && lastDone >= lastStart ? 'finished' : lastStart ? 'started, no "done" line (running, or it died)' : '';
  // launchd reports LastExitStatus 0 for a job that has never run; only show it after a run.
  const exit = i.lastExit !== undefined && lastStart ? `, last exit ${i.lastExit}` : '';
  console.log(`  ${i.lbl}: ${describe(i.job)} [${i.loaded}] last run ${when}${state ? ` (${state})` : ''}${exit}  log ${MODE_LOG[i.mode]}`);
}
for (const f of PLAT === 'launchd' ? legacyPlists() : []) console.log(`  LEGACY ${f}: not managed by schedule.mjs; remove it by hand`);
const wc = worstCase(installed.map((i) => i.job));
console.log(`claude calls: ${callsToday()} today (data/_claude-calls.log) · worst case ~${wc.sum}/day · hard ceiling ${CAP}/day (pipeline.daily_claude_cap)`);
console.log('exit codes: 0 ok · 1 quota short or a lane failed · 2 setup problem · 3 deferred (usage wall / daily cap)');
const switches = [
  ['data/PIPELINE_OFF', 'every mode paused (npm run pipeline:on)'],
  ['data/HOT_OFF', 'hot mode paused'],
  ['data/LINKEDIN_OFF', 'LinkedIn lanes off (npm run linkedin:on)'],
  ['data/VERIFY_OFF', 'outreach verification off'],
  ['data/_hot-quota-backoff', 'speed/hot back off 30 min after a usage wall'],
];
const on = switches.filter(([f]) => existsSync(f));
console.log(`kill switches: ${on.length ? on.map(([f, w]) => `${f} (${w})`).join('; ') : 'none set'}`);
try {
  const today = localDate();
  if (readFileSync('data/_pipeline-skip-dates.txt', 'utf8').split('\n').some((l) => l.replace(/#.*/, '').trim() === today)) console.log(`  today (${today}) is in data/_pipeline-skip-dates.txt`);
} catch {}
console.log(DISCLOSURE);
