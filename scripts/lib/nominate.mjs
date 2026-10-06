/**
 * nominate.mjs — the nomination loop (build plan step 5). Every employer that HiringCafe, the
 * LinkedIn guest lane or the Gmail job alerts surfaced is turned into a verified ATS board,
 * appended to data/company-index.tsv and queued for an immediate sweep.
 *
 *   nominations (employer + any urls)
 *     -> board root from an ATS url / HiringCafe source+token (free)
 *     -> logged-in LinkedIn Apply-href tier (OFF unless integrations.linkedin_apply_href_tier)
 *     -> slug probe across the supported families (probe-ats-core, capped)
 *     -> Workday tenant resolver (capped, slow by design)
 *     -> board must return postings AND a nonsense-slug control must NOT (a 200 that answers for
 *        any slug proves nothing)
 *     -> append to the index, write data/_new-boards.tsv (scan-index --only reads it)
 *
 * Everything that touches the network goes through `deps`, so the loop runs on fixtures with no
 * network (scripts/test-nominate.mjs). resolve-nominations.mjs --nominate is the CLI around it.
 *
 * Kill switch: data/NOMINATE_OFF (or NOMINATE_OFF=1 in the env). data/PIPELINE_OFF also stops it.
 * The ledger data/_nominations.tsv records every attempt so doctor / the digest can report the
 * resolve rate (target >= 70%).
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { INDEX_COLS, INDEX_HEADER, parseTsv, toLine, rowKey } from './index-tsv.mjs';

export const GUEST_CAP_PER_DAY = 3;        // LinkedIn guest requests this loop may spend per day
export const GUEST_PACE_MS = 10_000;       // >= 10s between them
export const PROBE_CAP = 15;               // slug-probed employers per run (each is a handful of GETs)
export const WORKDAY_CAP = 5;              // Workday tenant lookups per run (8-16s apart, DDG throttles)
export const RETRY_DAYS = 7;               // an unresolved employer is not re-probed for a week
export const TARGET_RESOLVE_RATE = 0.7;
export const LEDGER_COLS = ['date', 'company', 'lane', 'status', 'family', 'board', 'detail'];
export const RESOLVED = 'resolved';
/** Statuses that count against the resolve rate: we tried, and could not produce a working board. */
export const FAILED_STATUSES = new Set(['unresolved', 'board-empty', 'control-failed']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const today = () => new Date().toISOString().slice(0, 10);
/** Employer on the shared staffing/aggregator blocklist (role-filters loadNoise()). */
export const isNoise = (company, noise = []) => { const l = String(company || '').toLowerCase(); return noise.some((n) => n && l.includes(n)); };

// ── switches ─────────────────────────────────────────────────────────────────────────────────
/** @returns {string|null} why the loop must not run, else null */
export function nominateOff({ dataDir = 'data', env = process.env } = {}) {
  if (env.NOMINATE_OFF === '1' || env.NOMINATE_OFF === 'true') return 'NOMINATE_OFF=1 in the environment';
  if (existsSync(join(dataDir, 'NOMINATE_OFF'))) return `${dataDir}/NOMINATE_OFF present (delete it to resume)`;
  if (existsSync(join(dataDir, 'PIPELINE_OFF'))) return `${dataDir}/PIPELINE_OFF present (npm run pipeline:on)`;
  return null;
}

/** The logged-in LinkedIn Apply-href tier. Default OFF. Flat or nested config key. */
export function applyHrefTierOn(integrations = {}) {
  if (integrations.linkedin_apply_href_tier === true) return true;
  const li = integrations.linkedin;
  return !!(li && typeof li === 'object' && li.apply_href_tier === true);
}

// ── board roots ──────────────────────────────────────────────────────────────────────────────
/** HiringCafe `source` token -> board root (the index stores the root in careers_url). */
export const BOARD_ROOT = {
  grnhse: (t) => `https://job-boards.greenhouse.io/${t}`,
  greenhouse: (t) => `https://job-boards.greenhouse.io/${t}`,
  ashby: (t) => `https://jobs.ashbyhq.com/${t}`,
  lever: (t) => `https://jobs.lever.co/${t}`,
  smartrecruiters: (t) => `https://careers.smartrecruiters.com/${t}`,
  workable: (t) => `https://apply.workable.com/${t}`,
  recruitee: (t) => `https://${t}.recruitee.com`,
  bamboohr: (t) => `https://${t}.bamboohr.com`,
  teamtailor: (t) => `https://${t}.teamtailor.com`,
  rippling: (t) => `https://ats.rippling.com/${t}`,
};

const LOCALE_SEG = /^[a-z]{2}(?:[-_][A-Za-z]{2})?$/;
/** An employer apply/job URL -> its board root, or null (aggregator, LinkedIn, unknown host). */
export function boardRootFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const slug = u.searchParams.get('for') || (seg[0] && !['embed', 'v1'].includes(seg[0]) ? seg[0] : '');
    return slug ? BOARD_ROOT.greenhouse(slug) : null;
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) return seg[0] ? BOARD_ROOT.ashby(seg[0]) : null;
  if (/(^|\.)lever\.co$/.test(host)) return seg[0] ? BOARD_ROOT.lever(seg[0]) : null;
  if (/(^|\.)smartrecruiters\.com$/.test(host)) return seg[0] ? BOARD_ROOT.smartrecruiters(seg[0]) : null;
  if (/(^|\.)workable\.com$/.test(host)) return seg[0] && seg[0] !== 'api' ? BOARD_ROOT.workable(seg[0]) : null;
  if (/\.myworkdayjobs\.com$/.test(host)) {
    const site = seg.find((s) => !LOCALE_SEG.test(s));
    return site ? `https://${host}/${site}` : null;
  }
  const m = host.match(/^([a-z0-9-]+)\.(recruitee|bamboohr|teamtailor)\.com$/);
  if (m) return BOARD_ROOT[m[2]](m[1]);
  return null;
}

/** The board's identity token inside its root: first path segment, or the host label for host-keyed families. */
export function slugOfRoot(root) {
  try {
    const u = new URL(root);
    if (/\.myworkdayjobs\.com$/.test(u.hostname) || /\.(recruitee|bamboohr|teamtailor)\.com$/.test(u.hostname)) return u.hostname.split('.')[0];
    return u.pathname.split('/').filter(Boolean)[0] || '';
  } catch { return ''; }
}

/** Same board, nonsense slug. Used by the control check. */
export function controlRoot(root, nonsense) {
  const slug = slugOfRoot(root);
  return slug ? root.split(slug).join(nonsense) : null;
}

// ── gathering nominations ────────────────────────────────────────────────────────────────────
const laneOfSource = (src) => {
  const s = String(src || '').toLowerCase();
  if (/hiringcafe/.test(s)) return 'hiringcafe';
  if (/alert|email/.test(s)) return 'email-alerts';
  if (/linkedin/.test(s)) return 'linkedin';
  return '';
};

/**
 * Employers seen by the nomination lanes, from the files those lanes already write:
 *   data/_web-roles.tsv (date company role location posted url source) — hiringcafe, LinkedIn, alerts
 *   data/_hiringcafe.tsv (sidecar; `ats` = source/board_token)
 *   data/_speed-li.json  (LinkedIn guest survivors)
 * @returns {Map<string, {company: string, lanes: Set<string>, urls: Set<string>, hints: Array<{src: string, token: string}>, titles: Set<string>}>}
 */
export function collectNominations({ dataDir = 'data' } = {}) {
  const out = new Map();
  const add = (company, lane, { url = '', title = '', hint = null } = {}) => {
    const k = norm(company);
    if (!k || !lane) return;
    const e = out.get(k) || { company: String(company).trim(), lanes: new Set(), urls: new Set(), hints: [], titles: new Set() };
    e.lanes.add(lane);
    if (url) e.urls.add(url);
    if (title) e.titles.add(title);
    if (hint) e.hints.push(hint);
    out.set(k, e);
  };
  for (const line of read(join(dataDir, '_web-roles.tsv')).split('\n').slice(1)) {
    const c = line.split('\t');
    if (!c[1]) continue;
    add(c[1], laneOfSource(c[6]), { url: (c[5] || '').trim(), title: c[2] });
  }
  const side = parseTsv(read(join(dataDir, '_hiringcafe.tsv'))).rows;
  for (const r of side) {
    const [src, token] = String(r.ats || '').split('/');
    add(r.company, 'hiringcafe', { url: r.url, title: r.role, hint: src && token ? { src: src.toLowerCase(), token } : null });
  }
  try {
    const li = JSON.parse(read(join(dataDir, '_speed-li.json')) || '[]');
    for (const c of Array.isArray(li) ? li : []) add(c.company, 'linkedin-guest', { url: c.url, title: c.title });
  } catch { /* an empty or half-written file is "no nominations", not an error */ }
  return out;
}

// ── index + ledger io ────────────────────────────────────────────────────────────────────────
export function readIndex(dataDir = 'data') {
  return parseTsv(read(join(dataDir, 'company-index.tsv'))).rows;
}
export function readLedger(dataDir = 'data') {
  return parseTsv(read(join(dataDir, '_nominations.tsv'))).rows;
}
function appendLedger(dataDir, rows) {
  if (!rows.length) return;
  const p = join(dataDir, '_nominations.tsv');
  const head = existsSync(p) ? '' : LEDGER_COLS.join('\t') + '\n';
  appendFileSync(p, head + rows.map((r) => toLine(r, LEDGER_COLS)).join('\n') + '\n');
}

/**
 * Resolve rate over a ledger window: resolved / (resolved + failed). Skips (already indexed, noise,
 * deferred by a cap, kill switch) are not attempts and never move the rate.
 * @returns {{resolved: number, failed: number, attempts: number, rate: number|null, byStatus: Record<string, number>}}
 */
export function resolveRate(rows) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const resolved = byStatus[RESOLVED] || 0;
  const failed = [...FAILED_STATUSES].reduce((s, k) => s + (byStatus[k] || 0), 0);
  const attempts = resolved + failed;
  return { resolved, failed, attempts, rate: attempts ? resolved / attempts : null, byStatus };
}

// ── LinkedIn Apply-href budget: <= 3 lookups/day, >= 10s apart ───────────────────────────────
// There is ONE LinkedIn counter: li-budget.mjs. This used to keep a second one in
// data/_nominate-state.json, which no other lane could see and which drifted from the `jobsearch`
// claim the lookup also spends. Now take() makes the single li-budget charge itself, and the daily
// 3-cap is read back from li-budget's own event log (the notes tagged NOMINATE_NOTE), so there is no
// extra file and no second count. `li` is injectable for tests (needs claim() and EVENTS_PATH).
export const NOMINATE_NOTE = 'nominate applyurl';
export function makeGuestBudget({ cap = GUEST_CAP_PER_DAY, paceMs = GUEST_PACE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = null, li = null } = {}) {
  let mod = li, spent = 0, base = 0, loaded = false;
  const lib = async () => (mod ||= await import('../li-budget.mjs'));
  const localDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  now ||= () => localDay(new Date().toISOString());
  const usedToday = (m) => {
    try {
      return read(m.EVENTS_PATH).split('\n').filter((l) => { const c = l.split('\t'); return c[1] === 'jobsearch' && c[2] === 'spend' && c[3] === NOMINATE_NOTE && localDay(c[0]) === now(); }).length;
    } catch { return 0; }
  };
  return {
    used: () => base + spent,
    /** true = the caller may make ONE Apply-href lookup now (already paced and charged to li-budget). */
    async take() {
      const m = await lib();
      if (!loaded) { base = usedToday(m); loaded = true; }
      if (base + spent >= cap) return false;
      if (spent > 0) await sleep(paceMs);
      const c = m.claim('jobsearch', NOMINATE_NOTE);
      if (!c?.ok) return false;
      spent++;
      return true;
    },
  };
}

// ── default network deps (lazy: tests never load these) ──────────────────────────────────────
export async function defaultDeps({ dataDir = 'data' } = {}) {
  const core = await import('../scan-core.mjs');
  const probe = await import('../probe-ats-core.mjs');
  return {
    /** api descriptor + name -> parsed jobs (throws on HTTP/DNS failure). */
    async fetchBoard(api, name) {
      if (!api || !core.PARSERS[api.type]) return [];
      return core.PARSERS[api.type](await core.fetchProvider(api), name, api) || [];
    },
    detectApi: (c) => core.detectApi(c),
    /** employer name -> board root or null (slug probe; Workday skipped, handled by workdayTenant). */
    async probeName(name) {
      const hit = await probe.probeCompany(name, { skipWorkday: true });
      return hit?.careers || null;
    },
    /** employer name -> Workday careers root or null (DuckDuckGo lookup, cached, 8-16s apart). */
    async workdayTenant(name) {
      const { spawnSync } = await import('child_process');
      spawnSync(process.execPath, ['scripts/resolve-workday-tenants.mjs', '--names', name, '--limit', '1'], { encoding: 'utf8', timeout: 120_000 });
      try { return JSON.parse(read(join(dataDir, '_workday-tenants.json')))[name.toLowerCase()]?.careers || null; } catch { return null; }
    },
    /** LinkedIn job url -> employer ATS board root via the logged-in Apply href (tier ON only). */
    async applyHref(url, { guest } = {}) {
      const id = (String(url).match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) || [])[1];
      if (!id) return null;
      // The li-budget charge was already made by guest.take() (one counter, not two).
      const { applyUrlForJob } = await import('../linkedin-applyurl.mjs');
      const res = await applyUrlForJob(id);
      return res?.raw ? boardRootFromUrl(res.raw) : null;
    },
  };
}

/**
 * Run the loop.
 * @param {object} o
 * @param {string} [o.dataDir]
 * @param {object} o.deps          see defaultDeps()
 * @param {string[]} [o.noise]     lower-cased employer substrings to drop (role-filters loadNoise())
 * @param {boolean} [o.tierOn]     logged-in Apply-href tier (default false)
 * @param {object} [o.budget]      makeGuestBudget()
 * @param {number} [o.probeCap] [o.workdayCap] [o.limit]
 * @param {boolean} [o.dryRun]
 * @param {string} [o.laneFilter]
 */
export async function runNominationLoop({ dataDir = 'data', deps, noise = [], tierOn = false, budget = null,
  probeCap = PROBE_CAP, workdayCap = WORKDAY_CAP, limit = Infinity, dryRun = false, nonsense = 'zz-cf-control-0x', now = today } = {}) {
  const off = nominateOff({ dataDir });
  if (off) return { off, results: [], added: [], summary: `nominate: OFF (${off})` };

  const noms = collectNominations({ dataDir });
  const idx = readIndex(dataDir);
  const names = new Set(idx.map((r) => norm(r.company)));
  const keys = new Set(idx.map(rowKey).filter(Boolean));
  const ledger = readLedger(dataDir);
  const recentFail = new Set(ledger.filter((r) => FAILED_STATUSES.has(r.status)
    && (Date.parse(now()) - Date.parse(r.date)) / 864e5 < RETRY_DAYS).map((r) => norm(r.company)));
  const guest = budget || makeGuestBudget({ dataDir, now });

  const results = [];
  const added = [];
  let probes = 0, wdLookups = 0, attempted = 0;
  const log = (e, status, extra = {}) => {
    const r = { date: now(), company: e.company, lane: [...e.lanes].join('+'), status, family: '', board: '', detail: '', ...extra };
    results.push(r); return r;
  };

  for (const e of noms.values()) {
    if (isNoise(e.company, noise)) { log(e, 'noise'); continue; }
    if (names.has(norm(e.company))) { log(e, 'already-indexed'); continue; }
    if (recentFail.has(norm(e.company))) { log(e, 'skipped-recent-fail', { detail: `unresolved within ${RETRY_DAYS}d` }); continue; }
    if (attempted >= limit) { log(e, 'deferred', { detail: '--limit' }); continue; }

    // 1. candidate board roots, cheapest first
    let root = null, via = '';
    for (const h of e.hints) { const r = BOARD_ROOT[h.src]?.(h.token); if (r) { root = r; via = `hiringcafe:${h.src}`; break; } }
    if (!root) for (const u of e.urls) { const r = boardRootFromUrl(u); if (r) { root = r; via = 'apply-url'; break; } }

    // 2. logged-in Apply href (default OFF)
    if (!root && tierOn && deps.applyHref) {
      for (const u of e.urls) {
        if (!/linkedin\.com\/jobs\/view\//.test(u)) continue;
        if (!(await guest.take())) { break; }
        root = await deps.applyHref(u, { guest }).catch(() => null);
        if (root) { via = 'apply-href'; break; }
      }
    }
    // 3. slug probe (capped)
    if (!root) {
      if (probes >= probeCap) { log(e, 'deferred', { detail: `probe cap ${probeCap}/run` }); continue; }
      probes++;
      root = await deps.probeName(e.company).catch(() => null);
      if (root) via = 'probe';
    }
    // 4. Workday tenant (capped, slow)
    if (!root) {
      if (wdLookups >= workdayCap) { log(e, 'unresolved', { detail: `no board by probe; workday cap ${workdayCap}/run reached` }); attempted++; continue; }
      wdLookups++;
      root = await deps.workdayTenant(e.company).catch(() => null);
      if (root) via = 'workday-tenant';
    }
    attempted++;
    if (!root) { log(e, 'unresolved', { detail: 'no ATS board found (apply url, probe, workday)' }); continue; }

    // 5. the board must exist and return postings
    const api = deps.detectApi({ careers_url: root });
    if (!api) { log(e, 'unresolved', { board: root, detail: 'unsupported ATS family' }); continue; }
    let jobs = [];
    try { jobs = await deps.fetchBoard(api, e.company); } catch (err) { log(e, 'board-empty', { family: api.type, board: root, detail: `fetch failed: ${err.message}` }); continue; }
    if (!jobs.length) { log(e, 'board-empty', { family: api.type, board: root, detail: `0 postings (${via})` }); continue; }

    // 6. nonsense-slug control: the same family must NOT answer for a slug that cannot exist
    const cRoot = controlRoot(root, nonsense);
    if (cRoot) {
      const cApi = deps.detectApi({ careers_url: cRoot });
      let cJobs = [];
      try { cJobs = cApi ? await deps.fetchBoard(cApi, 'control') : []; } catch { cJobs = []; }
      if (cJobs.length) { log(e, 'control-failed', { family: api.type, board: root, detail: `nonsense slug returned ${cJobs.length} postings; HTTP 200 proves nothing for this host` }); continue; }
    }

    // 7. not the same board under another name
    const row = { company: e.company, hq: '', careers_url: root, ats_type: api.type, ats_api_url: api.url,
      source: `nomination:${[...e.lanes][0]}`, date_added: now(), last_scanned: '', last_status: '' };
    const k = rowKey(row);
    if (k && keys.has(k)) { log(e, 'already-indexed', { family: api.type, board: root, detail: 'same board under another name' }); continue; }
    if (k) keys.add(k);
    names.add(norm(e.company));
    added.push(row);
    log(e, RESOLVED, { family: api.type, board: root, detail: `${jobs.length} postings via ${via}` });
  }

  if (!dryRun) {
    mkdirSync(dataDir, { recursive: true });
    if (added.length) {
      const p = join(dataDir, 'company-index.tsv');
      if (!existsSync(p) || !read(p).trim()) writeFileSync(p, INDEX_HEADER);
      appendFileSync(p, added.map((r) => toLine(r, INDEX_COLS)).join('\n') + '\n');
    }
    // Rewritten every run, so scan-index --only sweeps exactly today's new boards and nothing stale.
    writeFileSync(join(dataDir, '_new-boards.tsv'), 'company\tcareers_url\n' + added.map((r) => `${r.company}\t${r.careers_url}`).join('\n') + (added.length ? '\n' : ''));
    appendLedger(dataDir, results.filter((r) => !['noise', 'already-indexed', 'skipped-recent-fail'].includes(r.status)));
  }
  const rr = resolveRate(results);
  const summary = `nominate: ${noms.size} employer(s) seen -> ${added.length} new board(s) indexed` +
    ` | resolve rate ${rr.rate == null ? 'n/a (no attempts)' : `${Math.round(rr.rate * 100)}% (${rr.resolved}/${rr.attempts}, target ${TARGET_RESOLVE_RATE * 100}%)`}` +
    ` | already indexed ${rr.byStatus['already-indexed'] || 0}, noise ${rr.byStatus.noise || 0}, deferred ${rr.byStatus.deferred || 0}` +
    ` | probes ${probes}/${probeCap}, workday ${wdLookups}/${workdayCap}, guest ${guest.used?.() ?? 0}/${GUEST_CAP_PER_DAY}`;
  return { off: null, results, added, summary, rate: rr };
}
