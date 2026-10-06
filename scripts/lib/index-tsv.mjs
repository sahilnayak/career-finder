/**
 * index-tsv.mjs — pure helpers for data/company-index.tsv, the bundled starter seed and the
 * sector registries (data/registries/*.tsv). No network, no profile, no side effects except
 * ensureSeedIndex() which copies one file.
 *
 *   mergeImport()      --import mode of build-company-index.mjs
 *   ensureSeedIndex()  restore the starter index offline (doctor, scan-index, update-system)
 *   loadRegistries()   rows scan-index sweeps in addition to the company index
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const INDEX_COLS = ['company', 'hq', 'careers_url', 'ats_type', 'ats_api_url', 'source', 'date_added', 'last_scanned', 'last_status'];
export const INDEX_HEADER = INDEX_COLS.join('\t') + '\n';
export const SEED_PATH = 'templates/company-index.starter.tsv';
export const REGISTRY_DIR = 'data/registries';
export const REGISTRY_COLS = ['company', 'ats_type', 'ats_api_url', 'careers_url', 'status', 'verified_on', 'how_verified', 'note'];
export const REGISTRY_STATUSES = ['verified', 'unverified', 'needs-parser'];

export function parseTsv(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const header = (lines[0] || '').split('\t');
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const c = l.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
  return { header, rows };
}

export const toLine = (row, cols = INDEX_COLS) => cols.map(c => String(row[c] ?? '').replace(/[\t\n]/g, ' ')).join('\t');

/** A board the source index already knows is gone: 404/410, "gone", "dead", "migrated", "not found". */
export function isDeadStatus(status) {
  return /\b(404|410|gone|dead|migrated|not found)\b/i.test(String(status || ''));
}

/** Identity of a board: the API URL (compensation flag stripped), else the careers URL. */
export function rowKey(r) {
  const norm = u => String(u || '').trim().toLowerCase().replace(/[?&]includecompensation=true/, '').replace(/\/+$/, '');
  const api = norm(r.ats_api_url);
  if (api) return 'api:' + api;
  const cu = norm(r.careers_url);
  return cu ? 'url:' + cu : '';
}

/**
 * Merge incoming rows (another career-ops/career-finder index) into local rows.
 *  - keyed on rowKey(); first incoming row for a key wins
 *  - incoming rows whose last_status marks them dead are skipped
 *  - a live local row is never overwritten; a DEAD local row is replaced by a live incoming one
 *  - scrub: reset last_scanned/last_status and stamp source (the starter file carries nobody's history)
 */
export function mergeImport(local, incoming, { scrub = false, source = '', today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = local.map(r => ({ ...r }));
  const byKey = new Map();
  out.forEach((r, i) => { const k = rowKey(r); if (k && !byKey.has(k)) byKey.set(k, i); });
  const stats = { added: 0, revived: 0, skippedDead: 0, skippedDuplicate: 0, skippedLiveLocal: 0, skippedNoKey: 0 };
  const seenIncoming = new Set();
  for (const raw of incoming) {
    const k = rowKey(raw);
    if (!k || !raw.company) { stats.skippedNoKey++; continue; }
    if (isDeadStatus(raw.last_status)) { stats.skippedDead++; continue; }
    if (seenIncoming.has(k)) { stats.skippedDuplicate++; continue; }
    seenIncoming.add(k);
    const row = Object.fromEntries(INDEX_COLS.map(c => [c, raw[c] ?? '']));
    if (source) row.source = source;
    if (scrub) { row.last_scanned = ''; row.last_status = ''; row.date_added = today; }
    else if (!row.date_added) row.date_added = today;
    if (byKey.has(k)) {
      const i = byKey.get(k);
      if (isDeadStatus(out[i].last_status)) { out[i] = row; stats.revived++; }
      else stats.skippedLiveLocal++;
      continue;
    }
    byKey.set(k, out.length);
    out.push(row);
    stats.added++;
  }
  return { rows: out, stats };
}

export const countIndexRows = path => existsSync(path) ? parseTsv(readFileSync(path, 'utf-8')).rows.length : 0;

/**
 * Copy the bundled starter index over data/company-index.tsv when that file is missing or
 * header-only. Never touches an index that already has rows. Offline.
 * Returns {restored: boolean, rows: number, reason?: string}.
 */
export function ensureSeedIndex({ root = ROOT, index = 'data/company-index.tsv', seed = SEED_PATH, seedRoot = root } = {}) {
  // `index` is resolved against `root` (cwd-relative callers pass root: process.cwd()); the bundled
  // seed always ships with the repo, so it resolves against `seedRoot`.
  const idx = resolve(root, index), sd = resolve(seedRoot, seed);
  const have = countIndexRows(idx);
  if (have > 0) return { restored: false, rows: have };
  if (process.env.CAREER_FINDER_SEED_OFF === '1') return { restored: false, rows: 0, reason: 'CAREER_FINDER_SEED_OFF=1' };   // tests of the empty-index failure path
  if (!existsSync(sd)) return { restored: false, rows: 0, reason: `no seed at ${seed}` };
  mkdirSync(dirname(idx), { recursive: true });
  copyFileSync(sd, idx);
  return { restored: true, rows: countIndexRows(idx) };
}

/** Every registry row (all sectors), tagged with its sector and file. */
export function loadRegistries({ root = ROOT, dir = REGISTRY_DIR } = {}) {
  // CAREER_FINDER_REGISTRY_DIR (absolute) lets a test or a sandboxed run point at a different set.
  const d = process.env.CAREER_FINDER_REGISTRY_DIR || join(root, dir);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d).filter(f => f.endsWith('.tsv')).sort()) {
    for (const r of parseTsv(readFileSync(join(d, f), 'utf-8')).rows) out.push({ ...r, sector: f.replace(/\.tsv$/, ''), file: f });
  }
  return out;
}

/**
 * Registry rows the ATS sweep may read, shaped like index rows. Only status=verified rows with an
 * API URL; rows whose API already sits in the company index are dropped (index wins).
 */
export function registryScanRows(registryRows, indexRows = []) {
  const known = new Set(indexRows.map(rowKey).filter(Boolean));
  const out = [];
  for (const r of registryRows) {
    if (r.status !== 'verified' || !r.ats_api_url) continue;
    const row = { company: r.company, hq: '', careers_url: r.careers_url, ats_type: r.ats_type, ats_api_url: r.ats_api_url, source: `registry:${r.sector}`, date_added: r.verified_on, last_scanned: '', last_status: '' };
    const k = rowKey(row);
    if (known.has(k)) continue;
    known.add(k);
    out.push(row);
  }
  return out;
}

/** Schema problems in one registry file's rows; empty array = clean. */
export function validateRegistryRows(rows, header = REGISTRY_COLS) {
  const errs = [];
  for (const c of REGISTRY_COLS) if (!header.includes(c)) errs.push(`missing column ${c}`);
  rows.forEach((r, i) => {
    const w = `row ${i + 2} (${r.company || '?'})`;
    if (!r.company) errs.push(`${w}: no company`);
    if (!REGISTRY_STATUSES.includes(r.status)) errs.push(`${w}: bad status "${r.status}"`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.verified_on || '')) errs.push(`${w}: verified_on not YYYY-MM-DD`);
    if (!r.how_verified) errs.push(`${w}: how_verified empty`);
    if (r.status === 'verified' && !/^https:\/\//.test(r.ats_api_url || '')) errs.push(`${w}: verified without an https ats_api_url`);
    if (r.status === 'unverified' && r.ats_api_url) errs.push(`${w}: unverified row must not store an API URL`);
    if (r.status !== 'verified' && !r.note) errs.push(`${w}: ${r.status} row needs a note (the reason)`);
  });
  return errs;
}
