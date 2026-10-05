#!/usr/bin/env node
/**
 * discovery-audit.mjs — recall of the discovery lanes against a hand-verified truth set.
 *
 * Offline mode (default): compare a truth TSV against what a career-finder data dir found.
 *   node scripts/discovery-audit.mjs --truth scripts/fixtures/discovery/2026-10-04-weekend/truth.tsv [--data ./data] [--json]
 *     [--exclude-flagged]   drop truth rows whose `flags` column is set (reposts, out-of-window)
 *
 * Live mode (the weekday rerun harness): run the ZERO-LLM lanes per role into a temp data dir and
 * report what each found plus the request ledger. No claude -p, no logged-in LinkedIn, no :9222.
 *   node scripts/discovery-audit.mjs --live --roles sdr,software-engineer --hours 24 \
 *     [--index data/company-index.tsv] [--roles-file <fixture>/roles.json] [--truth <tsv>] [--pace-s 20] [--keep] [--json] [--out f.json]
 *     [--allow-browser]  let HiringCafe fall back to the debug Chrome on :9222. OFF by default: plain HTTP
 *                        is Cloudflare-403'd (measured 2026-10-05: 8/8 403), so without it the HC lane
 *                        reports its 403s in the ledger and finds nothing. Never while LinkedIn owns :9222.
 *   Lanes: scan-index.mjs --hours H, hiringcafe-scan.mjs --no-browser --days ceil(H/24), scan.mjs.
 *
 * Matching (truth row -> found row), first hit wins:
 *   1. ATS job id (ashby/lever uuid, greenhouse numeric id, workday JR/req id, smartrecruiters id)
 *   2. canonical URL (lowercased host+path, no query/hash/trailing slash)
 *   3. company + normalized title
 * Miss buckets (using <data>/company-index.tsv):
 *   no-public-ATS    truth URL is not a recognised ATS family and the employer is not indexed
 *   not-in-index     the employer has no row in the index
 *   in-index-missed  the employer IS indexed and the lanes still missed it (filters, dates, paging)
 */

import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = join(REPO, 'scripts/fixtures/discovery/2026-10-04-weekend');

// ── parsing ──────────────────────────────────────────────────────────────────────────────
export function parseTsv(text) {
  const lines = String(text).split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(l => { const c = l.split('\t'); return Object.fromEntries(head.map((h, i) => [h, (c[i] || '').trim()])); });
}
export const readTsv = (p) => existsSync(p) ? parseTsv(readFileSync(p, 'utf8')) : [];

export function canonicalUrl(u = '') {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).toLowerCase().replace(/\/+$/, ''); }
  catch { return String(u).toLowerCase().trim(); }
}

export function atsFamily(u = '') {
  const h = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
  if (/ashbyhq\.com$/.test(h)) return 'ashby';
  if (/greenhouse\.io$/.test(h) || /gh_jid=/.test(u)) return 'greenhouse';
  if (/lever\.co$/.test(h)) return 'lever';
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(h)) return 'workday';
  if (/smartrecruiters\.com$/.test(h)) return 'smartrecruiters';
  if (/icims\.com$/.test(h)) return 'icims';
  if (/oraclecloud\.com$|taleo\.net$/.test(h)) return 'oracle';
  return 'other';
}

/** "family:id" or '' when no stable id can be read off the URL. */
export function atsJobId(u = '') {
  const fam = atsFamily(u);
  const s = String(u);
  let m;
  if (fam === 'ashby' || fam === 'lever') m = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  else if (fam === 'greenhouse') m = s.match(/gh_jid=(\d+)/) || s.match(/\/jobs\/(\d+)/);
  else if (fam === 'workday') m = s.match(/_((?:JR|R|REQ)?[-_]?\d{4,}(?:-\d+)?)(?:[/?#]|$)/i);
  else if (fam === 'smartrecruiters') m = s.match(/\/(\d{6,})/);
  else if (fam === 'icims') m = s.match(/\/jobs\/(\d+)/);
  else if (fam === 'oracle') m = s.match(/\/job\/(\d+)/) || s.match(/job=(\d+)/);
  return m ? `${fam}:${m[1].toLowerCase()}` : '';
}

export const normCompany = (s = '') => String(s).toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|technologies|labs?)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
export const normTitle = (s = '') => String(s).toLowerCase().replace(/[–—-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(sr)\b/g, 'senior').replace(/\s+/g, ' ').trim();

// ── found rows per lane ──────────────────────────────────────────────────────────────────
/** Every row a lane wrote into `dataDir`, as { lane, company, title, url }. */
export function loadFound(dataDir) {
  const out = [];
  const push = (lane, r, title = r.role || r.title) => { if (r.url || title) out.push({ lane, company: r.company || '', title: title || '', url: r.url || '' }); };
  for (const r of readTsv(join(dataDir, '_candidates-new.tsv'))) push('scan-index', r);
  for (const r of readTsv(join(dataDir, '_candidates.tsv'))) push('scan-index', r);
  for (const r of readTsv(join(dataDir, '_speed-ats.tsv'))) push('scan-index', r);
  for (const r of readTsv(join(dataDir, '_web-roles.tsv'))) {
    const src = (r.source || '').toLowerCase();
    push(/hiringcafe/.test(src) ? 'hiringcafe' : /linkedin|li-/.test(src) ? 'linkedin' : (src.split(/[:\s]/)[0] || 'web-roles'), r);
  }
  for (const r of readTsv(join(dataDir, '_hiringcafe.tsv'))) push('hiringcafe', r);
  for (const r of readTsv(join(dataDir, 'scan-history.tsv'))) push('scan', r, r.title);
  return out;
}

/** Index lookup: normalized company names + board tokens out of the api/careers URLs. */
export function loadIndex(dataDir) {
  const rows = readTsv(join(dataDir, 'company-index.tsv'));
  const names = new Set(), tokens = new Set();
  for (const r of rows) {
    if (r.company) names.add(normCompany(r.company));
    for (const u of [r.ats_api_url, r.careers_url]) for (const t of boardTokens(u)) tokens.add(t);
  }
  return { size: rows.length, names, tokens };
}

/** Board identity tokens: "ashby:sentry", "workday:nvidia.wd5/nvidiaexternalcareersite", ... */
export function boardTokens(u = '') {
  if (!u) return [];
  let x; try { x = new URL(u); } catch { return []; }
  const h = x.hostname.toLowerCase(), p = x.pathname.split('/').filter(Boolean).map(s => s.toLowerCase());
  const fam = atsFamily(u), out = [];
  if (fam === 'ashby') { const i = p.indexOf('job-board'); out.push(`ashby:${i >= 0 ? p[i + 1] : p[0]}`); }
  else if (fam === 'greenhouse') { const i = p.indexOf('boards'); out.push(`greenhouse:${i >= 0 ? p[i + 1] : p[0]}`); const q = x.searchParams.get('for'); if (q) out.push(`greenhouse:${q.toLowerCase()}`); }
  else if (fam === 'lever') out.push(`lever:${p[0] === 'v0' ? p[2] : p[0]}`);
  else if (fam === 'workday') out.push(`workday:${h.split('.')[0]}`);
  else if (fam === 'smartrecruiters') out.push(`smartrecruiters:${p.includes('companies') ? p[p.indexOf('companies') + 1] : p[0]}`);
  return out.filter(t => !/:(undefined|)$/.test(t));
}

// ── recall ───────────────────────────────────────────────────────────────────────────────
export function matchTruth(t, found) {
  const id = atsJobId(t.url), cu = canonicalUrl(t.url);
  const key = normCompany(t.company) + '|' + normTitle(t.title);
  // Company+title is a fallback only when one side has no ATS job id: two different ids under the
  // same title (same role in two cities, or a repost) are different postings and must not match.
  const hits = found.filter(f => {
    const fid = atsJobId(f.url);
    if (id && fid === id) return true;
    if (f.url && canonicalUrl(f.url) === cu) return true;
    if (id && fid) return false;
    return (normCompany(f.company) + '|' + normTitle(f.title)) === key;
  });
  return { matched: hits.length > 0, lanes: [...new Set(hits.map(h => h.lane))] };
}

export function bucketMiss(t, index) {
  const indexed = index.names.has(normCompany(t.company)) || boardTokens(t.url).some(tk => index.tokens.has(tk));
  if (indexed) return 'in-index-missed';
  return atsFamily(t.url) === 'other' ? 'no-public-ATS' : 'not-in-index';
}

/** Core audit: truth rows x found rows x index -> per-row results + per-role / per-lane recall. */
export function audit(truth, found, index, { excludeFlagged = false } = {}) {
  const rows = truth.filter(t => !(excludeFlagged && t.flags)).map(t => {
    const m = matchTruth(t, found);
    return { role: t.role || '(all)', company: t.company, title: t.title, url: t.url, flags: t.flags || '',
      found: m.matched, lanes: m.lanes, bucket: m.matched ? '' : bucketMiss(t, index) };
  });
  const byRole = {}, byLane = {}, buckets = {};
  const allLanes = new Set(found.map(f => f.lane));
  for (const r of rows) {
    const e = byRole[r.role] ||= { truth: 0, found: 0 };
    e.truth++; if (r.found) e.found++;
    if (r.bucket) buckets[r.bucket] = (buckets[r.bucket] || 0) + 1;
    for (const l of r.lanes) allLanes.add(l);
  }
  for (const l of allLanes) byLane[l] = { truth: rows.length, found: rows.filter(r => r.lanes.includes(l)).length, rows_written: found.filter(f => f.lane === l).length };
  const pct = (a, b) => b ? Math.round((a / b) * 1000) / 10 : null;
  for (const v of [...Object.values(byRole), ...Object.values(byLane)]) v.recall_pct = pct(v.found, v.truth);
  const total = { truth: rows.length, found: rows.filter(r => r.found).length };
  total.recall_pct = pct(total.found, total.truth);
  return { total, byRole, byLane, buckets, rows };
}

export function formatAudit(a) {
  const L = [];
  const pct = (v) => v == null ? '  n/a' : `${v.toFixed(1).padStart(5)}%`;
  L.push(`RECALL ${a.total.found}/${a.total.truth} (${pct(a.total.recall_pct).trim()})`);
  L.push('\nper role:');
  for (const [k, v] of Object.entries(a.byRole)) L.push(`  ${k.padEnd(28)} ${String(v.found).padStart(3)}/${String(v.truth).padEnd(3)} ${pct(v.recall_pct)}`);
  L.push('\nper lane (truth rows each lane found / rows the lane wrote):');
  if (!Object.keys(a.byLane).length) L.push('  (no lane wrote any rows)');
  for (const [k, v] of Object.entries(a.byLane)) L.push(`  ${k.padEnd(28)} ${String(v.found).padStart(3)}/${String(v.truth).padEnd(3)} ${pct(v.recall_pct)}   wrote ${v.rows_written}`);
  L.push('\nmiss buckets:');
  if (!Object.keys(a.buckets).length) L.push('  (none)');
  for (const [k, v] of Object.entries(a.buckets)) L.push(`  ${k.padEnd(28)} ${v}`);
  const misses = a.rows.filter(r => !r.found);
  if (misses.length) {
    L.push('\nmisses:');
    for (const r of misses) L.push(`  [${r.bucket}] ${r.role} · ${r.company} · ${r.title}${r.flags ? `  {${r.flags}}` : ''}`);
  }
  return L.join('\n');
}

// ── live mode ────────────────────────────────────────────────────────────────────────────
const BAY_CITIES = ['San Francisco', 'Oakland', 'Berkeley', 'Emeryville', 'San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Palo Alto',
  'Menlo Park', 'Redwood City', 'San Mateo', 'Foster City', 'Burlingame', 'South San Francisco', 'San Bruno', 'Daly City', 'Cupertino', 'Milpitas',
  'Fremont', 'Hayward', 'San Leandro', 'Walnut Creek', 'Pleasanton', 'Livermore', 'Dublin', 'San Ramon', 'Concord', 'Richmond', 'Alameda',
  'Los Gatos', 'Campbell', 'Los Altos', 'Belmont', 'San Carlos', 'Brisbane', 'Newark', 'Union City', 'Danville', 'Lafayette',
  'Orinda', 'Martinez', 'Antioch', 'Vallejo', 'Napa', 'Santa Rosa', 'Petaluma', 'San Rafael', 'Novato', 'Mill Valley', 'Sausalito', 'Larkspur',
  'Corte Madera', 'Greenbrae', 'Fairfield', 'Morgan Hill', 'Gilroy', 'Half Moon Bay', 'Stanford', 'Bay Area'];

/** Profile + portals for one role, same shape as the 2026-10-04 method (gen.mjs). */
export async function roleProfile(slug, R, hours) {
  const yaml = (await import('js-yaml')).default;
  const p = yaml.load(readFileSync(join(REPO, 'config/profile.example.yml'), 'utf8'));
  const days = Math.max(1, Math.ceil(hours / 24));
  p.candidate = { ...p.candidate, full_name: 'Test Candidate', email: 'test@example.com', location: 'San Francisco, CA', years: R.years, linkedin: '' };
  p.targets = { roles: [R.role, ...(R.alt || [])], title_keywords: R.kw || [], title_negatives: ['!director', '!vp', '!head of', '!intern', ...(R.neg || [])],
    primary_role: R.role, seniority: 'mid', include_management: !!R.mgmt, dealbreakers: [] };
  p.target_roles = { primary: [R.role], archetypes: [{ name: R.role, level: 'Mid', fit: 'primary' }] };
  p.location = { metro: 'San Francisco Bay Area', city: 'San Francisco', state: 'CA', country: 'United States', lat: 37.7749, lng: -122.4194,
    radius_mi: 50, linkedin_geo_id: '90000084', remote_policy: 'hybrid', cities: BAY_CITIES, timezone: 'America/Los_Angeles', visa_status: 'No sponsorship needed' };
  p.pipeline = { ...p.pipeline, window_hours: hours, scan_window_days: days, hiringcafe_days: days };
  p.discovery = { yc: false, seed_companies: [] };
  p.integrations = { ...p.integrations, linkedin: false, gmail: false };
  p.outreach = { ...p.outreach, sender_name: 'Test Candidate', sender_email: 'test@example.com' };
  const portals = { title_filter: { positive: [R.role, ...(R.alt || []), ...(R.kw || [])], negative: ['Intern'], seniority_boost: ['Senior'] },
    location_filter: { allowed_regions: BAY_CITIES, remote_policy: 'hybrid' }, search_queries: [], tracked_companies: [] };
  return { profile: yaml.dump(p, { lineWidth: 200 }), portals: yaml.dump(portals, { lineWidth: 200 }) };
}

function runRecord({ indexPath, truthPath, args, rolesFile }) {
  const sha = (p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : null;
  const rows = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).length - 1 : null;
  const git = (a) => { try { return spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim(); } catch { return null; } };
  return { git_sha: git(['rev-parse', '--short', 'HEAD']) || null, scripts_dirty: (git(['status', '--porcelain', 'scripts']) || '').length > 0,
    date_pt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }),
    index_rows: rows(indexPath), index_sha256: sha(indexPath),
    truth: truthPath, truth_rows: truthPath ? rows(truthPath) : null, truth_sha256: truthPath ? sha(truthPath) : null,
    roles_file: rolesFile, allow_browser: !!args['allow-browser'], pace_s: Number(args['pace-s'] ?? 20), exclude_flagged: !!args['exclude-flagged'],
    windows: { 'scan-index': `${args.hours || 24}h rolling on the ATS date`, scan: '--days N = local calendar day(s), NOT a rolling 24h window',
      hiringcafe: '--days N on HiringCafe indexed-at; nomination only, not ATS-dated truth' },
    not_run: ['linkedin guest + logged-in lanes (never run by --live)'],
    notes: ['scan lane has tracked_companies: [] so it scans no boards; not an independent source', 'BAY_CITIES differs from the 10-04 weekend run by one city (removed by fixture-hygiene)'],
    bay_cities: BAY_CITIES.length };
}

async function live(args) {
  const { readLedger, aggregate, formatSummary } = await import('./request-ledger.mjs');
  const hours = Number(args.hours || 24);
  const rolesFile = resolve(args['roles-file'] || join(DEFAULT_FIXTURE, 'roles.json'));
  const catalog = JSON.parse(readFileSync(rolesFile, 'utf8'));
  const slugs = String(args.roles || Object.keys(catalog).join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const unknown = slugs.filter(s => !catalog[s]);
  if (unknown.length) { console.error(`unknown role(s): ${unknown.join(', ')} (known: ${Object.keys(catalog).join(', ')})`); process.exit(2); }
  const indexPath = resolve(args.index || 'data/company-index.tsv');
  const truth = args.truth ? readTsv(resolve(args.truth)) : [];
  if (!args.truth) console.error('NOTE: no --truth given: lane counts and request totals only, NO recall.\n'
    + '  Re-score later with: node scripts/discovery-audit.mjs --truth <weekday truth.tsv> --data <a --keep data dir>');
  const paceMs = Number(args['pace-s'] ?? 20) * 1000;
  const runStamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const report = { started: new Date().toISOString(), weekday: new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' }),
    hours, index: indexPath, roles: {},
    // Run record (FINAL-REPORT step 0): enough to tell two runs apart. The career-ops index is copied
    // while its cron edits it, so the row count + hash pin which snapshot this run actually used.
    record: runRecord({ indexPath, truthPath: args.truth ? resolve(args.truth) : null, args, rolesFile }) };

  for (const [i, slug] of slugs.entries()) {
    if (i > 0 && paceMs) await new Promise(r => setTimeout(r, paceMs)); // HiringCafe pacing between roles
    const dir = mkdtempSync(join(tmpdir(), `cf-audit-${slug}-`));
    mkdirSync(join(dir, 'data'), { recursive: true }); mkdirSync(join(dir, 'config'), { recursive: true });
    if (existsSync(indexPath)) copyFileSync(indexPath, join(dir, 'data/company-index.tsv'));
    for (const f of ['_speed-noise.txt', '_never-apply.txt']) if (existsSync(join(REPO, 'data', f))) copyFileSync(join(REPO, 'data', f), join(dir, 'data', f));
    const { profile, portals } = await roleProfile(slug, catalog[slug], hours);
    writeFileSync(join(dir, 'config/profile.yml'), profile);
    writeFileSync(join(dir, 'portals.yml'), portals);
    const runId = `audit-${runStamp}-${slug}`;
    const env = { ...process.env, CAREER_FINDER_PROFILE: join(dir, 'config/profile.yml'), CAREER_FINDER_RUN_ID: runId,
      CAREER_FINDER_NO_BROWSER: args['allow-browser'] ? '0' : '1', CAREER_FINDER_LI_EVENTS: join(dir, 'data/li-events.tsv'), CAREER_FINDER_LI_DIR: join(dir, 'data/li-usage'),
      CAREER_FINDER_LI_COOLDOWN: join(dir, 'data/LI_COOLDOWN'),
      CAREER_FINDER_LEDGER: join(dir, 'data/_request-ledger.tsv'), CAREER_FINDER_LEDGER_OFF: '0', CAREER_FINDER_QUIET: '1' };
    const lanes = [
      ['scan-index', ['scripts/scan-index.mjs', '--hours', String(hours)]],
      ['hiringcafe', ['scripts/hiringcafe-scan.mjs', ...(args['allow-browser'] ? [] : ['--no-browser']), '--quiet', '--days', String(Math.max(1, Math.ceil(hours / 24)))]],
      ['scan', ['scripts/scan.mjs', '--days', String(Math.max(1, Math.ceil(hours / 24)))]],
    ];
    const laneStatus = {};
    for (const [name, a] of lanes) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [join(REPO, a[0]), ...a.slice(1)], { cwd: dir, env: { ...env, CAREER_FINDER_RUN_MODE: name }, encoding: 'utf8', timeout: 15 * 60e3, maxBuffer: 64 << 20 });
      // status null = killed (timeout or signal): say so, or a timed-out lane reads as "found nothing".
      const timedOut = r.status === null;
      laneStatus[name] = { exit: timedOut ? `killed:${r.signal || r.error?.code || '?'}` : r.status, timedOut, secs: Math.round((Date.now() - t0) / 1000), tail: String(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 240) };
      if (!args.json) console.error(`[${slug}] ${name}: exit ${laneStatus[name].exit}${timedOut ? ' (TIMEOUT, rows incomplete)' : ''} in ${laneStatus[name].secs}s`);
    }
    const found = loadFound(join(dir, 'data'));
    const ledger = aggregate(readLedger({ path: join(dir, 'data/_request-ledger.tsv'), runId }));
    const roleTruth = truth.filter(t => !t.role || t.role === slug);
    const res = { dir, lanes: laneStatus, found: found.length,
      foundByLane: found.reduce((m, f) => (m[f.lane] = (m[f.lane] || 0) + 1, m), {}),
      sample: found.slice(0, 15).map(f => `${f.lane} · ${f.company} · ${f.title}`),
      ledger: Object.fromEntries([...ledger].map(([k, v]) => [k, { requests: v.requests, statuses: v.statuses }])),
      audit: roleTruth.length ? audit(roleTruth, found, loadIndex(join(dir, 'data')), { excludeFlagged: !!args['exclude-flagged'] }) : null };
    report.roles[slug] = res;
    if (!args.json) {
      console.log(`\n=== ${slug} (${hours}h) — ${found.length} rows found  ${JSON.stringify(res.foundByLane)}`);
      for (const [n, s] of Object.entries(laneStatus)) console.log(`  lane ${n.padEnd(11)} exit ${s.exit}  ${s.secs}s${s.exit ? `  ${s.tail}` : ''}`);
      res.sample.forEach(s => console.log(`  + ${s}`));
      console.log(formatSummary(ledger, `  REQUEST LEDGER ${runId}`));
      if (res.audit) console.log(formatAudit(res.audit).replace(/^/gm, '  '));
      console.log(`  data dir: ${dir}`);
    }
    if (!args.keep) { try { rmSync(dir, { recursive: true, force: true }); res.dir = '(removed; pass --keep)'; } catch { /* ignore */ } }
  }
  report.finished = new Date().toISOString();
  if (args.json) console.log(JSON.stringify(report, null, 2));
  if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) a[k] = argv[++i]; else a[k] = true;
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  if (args.live) await live(args);
  else {
    if (!args.truth) { console.error('--truth <tsv> is required (or --live). See --help.'); process.exit(2); }
    const dataDir = resolve(args.data || 'data');
    const a = audit(readTsv(resolve(args.truth)), loadFound(dataDir), loadIndex(dataDir), { excludeFlagged: !!args['exclude-flagged'] });
    console.log(args.json ? JSON.stringify(a, null, 2) : formatAudit(a));
  }
}
