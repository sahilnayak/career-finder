#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-finder
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, config contract, scripts, dashboard, data contract, personal data, paths.
 *
 * Runs against the FIXTURE profile (scripts/fixtures/profile.test.yml) via CAREER_FINDER_PROFILE,
 * so it passes on a fresh clone before onboarding and never depends on the user's config.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SCRIPTS_DIR = __dirname;
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

// Child processes inherit this: every script resolves targets from the fixture, not the user's config.
const FIXTURE_PROFILE = join(SCRIPTS_DIR, 'fixtures', 'profile.test.yml');
process.env.CAREER_FINDER_PROFILE ||= FIXTURE_PROFILE;

console.log('\n🧪 career-finder test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', join('scripts', f)]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 1b. CONFIG CONTRACT ─────────────────────────────────────────
// Every role/location rule is read from config/profile.yml through scripts/targets.mjs. A missing
// profile must produce the onboarding message and exit 2, never a stack trace.

console.log('\n1b. Config contract (scripts/targets.mjs)');

{
  const resolved = run('node', ['scripts/targets.mjs']);
  if (resolved !== null && /Data Engineer/.test(resolved)) pass('targets.mjs resolves the fixture profile');
  else fail('targets.mjs could not resolve the fixture profile');

  let out = '', code = 0;
  try {
    out = execFileSync('node', ['scripts/targets.mjs'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CAREER_FINDER_PROFILE: join(ROOT, 'config', '__no-such-profile__.yml') },
    });
  } catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
  if (code === 2 && /onboarding/i.test(out) && !/\n\s+at /.test(out)) pass('missing profile -> exit 2 with the onboarding message, no stack trace');
  else fail(`missing profile handled badly (exit ${code}): ${out.split('\n')[0].slice(0, 100)}`);

  const verdict = run('node', ['scripts/targets.mjs', '--test', 'Senior Data Engineer', 'Chicago, IL']);
  if (verdict && /"locationMatches":\s*true/.test(verdict) && /"isPrimaryRole":\s*true/.test(verdict)) {
    pass('fixture posting judged local + primary');
  } else fail('targets.mjs --test misjudged the fixture posting');
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'scripts/cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'scripts/verify-pipeline.mjs', expectExit: 0 },
  { name: 'scripts/normalize-statuses.mjs', expectExit: 0 },
  { name: 'scripts/dedup-tracker.mjs', expectExit: 0 },
  { name: 'scripts/merge-tracker.mjs', expectExit: 0 },
  { name: 'scripts/update-system.mjs check', expectExit: 0 },
];

for (const { name, allowFail } of scripts) {
  const result = run('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(SCRIPTS_DIR, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 4. DASHBOARD BUILD ──────────────────────────────────────────

if (!QUICK) {
  console.log('\n4. Dashboard build');
  const goBuild = run('cd dashboard && go build -o /tmp/career-dashboard-test . 2>&1');
  if (goBuild !== null) {
    pass('Dashboard compiles');
  } else {
    fail('Dashboard build failed');
  }
} else {
  console.log('\n4. Dashboard build (skipped --quick)');
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/offer.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-finder/SKILL.md', '.claude/skills/career-finder-onboarding/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'go.mod', 'scripts/test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 6b. FORK HYGIENE ─────────────────────────────────────────────
// career-finder was forked from one person's career-ops. The system layer must carry no trace of
// that person or of their target role / metro: everything role- or place-specific comes from
// config/profile.yml. Scans the WORKING TREE (tracked or not), system layer only. User-layer
// content (data/, reports/, output/, interview-prep/) is the new user's own and is not scanned.

console.log('\n6b. Fork hygiene (no previous-owner or hard-coded target leftovers)');
{
  const SYSTEM_DIRS = ['scripts', 'modes', 'templates', 'dashboard', 'batch', 'docs', '.claude', '.opencode', 'config'];
  const SYSTEM_FILES = ['CLAUDE.md', 'AGENTS.md', 'DATA_CONTRACT.md', 'package.json'];
  const FORBIDDEN = 'sahil|nayak|productboard|versa networks|buzzhero|saratoga|95070|resolve ai';
  const targets = [...SYSTEM_DIRS.filter((d) => fileExists(d)), ...SYSTEM_FILES.filter((f) => fileExists(f))];
  const hits = targets.length
    ? run(`grep -rniIE '${FORBIDDEN}' ${targets.map((t) => `'${t}'`).join(' ')} --exclude-dir=node_modules --exclude='test-*.mjs' 2>/dev/null`)
    : null;
  if (!hits) {
    pass('No previous-owner names, employers or home metro in the system layer');
  } else {
    for (const line of hits.split('\n').filter(Boolean).slice(0, 25)) fail(`Leftover: ${line.slice(0, 120)}`);
  }
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
// User-layer content (DATA_CONTRACT.md) is excluded: interview-prep/, learning/ and
// output/ are the user's own notes and generated artifacts, where an absolute path to
// a local file is legitimate and not a portability bug — including the one-off build
// scripts kept alongside a generated deck in output/micro-demos/script-src/.
// This check is about SYSTEM-layer code being portable.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v scripts/test-all.mjs | grep -v '^interview-prep/' | grep -v '^learning/' | grep -v '^output/'`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'offer.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contact.md', 'deep.md',
  'offers.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. CLAUDE.md INTEGRITY ──────────────────────────────────────

console.log('\n9. CLAUDE.md integrity');

const claude = readFile('CLAUDE.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (claude.includes(section)) {
    pass(`CLAUDE.md has section: ${section}`);
  } else {
    fail(`CLAUDE.md missing section: ${section}`);
  }
}

// ── 10. VERSION FILE ─────────────────────────────────────────────

console.log('\n10. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── OFFLINE SUB-SUITES ──────────────────────────────────────────
// Standalone offline suites that must never be skipped. They cover the two places this
// project has silently lost data: the LinkedIn results parser (a bug there destroyed one
// card per page for months, undetected, because the parser lived inside a page.evaluate()
// closure and could not be run without a browser) and the LinkedIn guardrails.
console.log('\n🧪 Offline sub-suites');
for (const suite of ['test-linkedin-parse.mjs', 'test-li-safety.mjs', 'test-linkedin-applyurl.mjs', 'test-hiringcafe.mjs', 'test-ats-families.mjs']) {
  try {
    const out = execFileSync('node', [`scripts/${suite}`], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    const m = out.match(/📊 (\d+) passed, (\d+) failed/);
    if (m && Number(m[2]) === 0) pass(`${suite}: ${m[1]} passed`);
    else fail(`${suite}: ${m ? `${m[2]} FAILED` : 'unparseable output'}`);
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const m = out.match(/📊 (\d+) passed, (\d+) failed/);
    fail(`${suite}: ${m ? `${m[2]} failed` : `did not run — ${e.message.split('\n')[0]}`}`);
  }
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
