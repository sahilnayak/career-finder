#!/usr/bin/env node

/**
 * build-company-index.mjs — Seeds & grows data/company-index.tsv.
 *
 * Sources (incremental, idempotent — append new, skip existing):
 *   1. data/scan-history.tsv  → derive ATS board career pages from past job URLs
 *   2. portals.yml tracked_companies (careers_url) and config/profile.yml
 *      discovery.seed_companies ([{company, careers_url}]) — the user's own seed list
 *
 * The index starts EMPTY in a fresh install; this and discover-companies.mjs seed it for
 * whatever role + metro the profile targets.
 *
 * For each candidate it derives the board careers_url and runs detectApi() to
 * record the ATS type + zero-token API URL so scan-index.mjs can sweep it.
 *
 * Usage:  node scripts/build-company-index.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { detectApi } from './scan-core.mjs';
import { detectFamily } from './probe-ats-core.mjs';
import { requireTargets } from './targets.mjs';

const INDEX_PATH = 'data/company-index.tsv';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const HEADER = 'company\thq\tcareers_url\tats_type\tats_api_url\tsource\tdate_added\tlast_scanned\tlast_status\n';
const TODAY = new Date().toISOString().slice(0, 10);

// Derive a board-level careers_url + slug from a job-posting URL (ATS boards only).
function deriveBoard(url) {
  let m;
  if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/)))
    return { careers_url: `https://jobs.ashbyhq.com/${m[1]}`, slug: m[1].toLowerCase() };
  if ((m = url.match(/jobs\.lever\.co\/([^/?#]+)/)))
    return { careers_url: `https://jobs.lever.co/${m[1]}`, slug: m[1].toLowerCase() };
  if ((m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/)))
    return { careers_url: `https://job-boards.greenhouse.io/${m[1]}`, slug: m[1].toLowerCase() };
  if ((m = url.match(/boards\.greenhouse\.io\/([^/?#]+)/)))
    return { careers_url: `https://job-boards.greenhouse.io/${m[1]}`, slug: m[1].toLowerCase() };
  // Enterprise families (2026-10-04): a job URL carries the board id in its host/path.
  if ((m = url.match(/\/\/([a-z0-9-]+\.icims\.com)\/jobs\//i)))
    return { careers_url: `https://${m[1].toLowerCase()}/jobs`, slug: m[1].toLowerCase().replace(/^careers-|\.icims\.com$/g, '') };
  if ((m = url.match(/\/\/([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([A-Za-z0-9_]+)/i)))
    return { careers_url: `https://${m[1].toLowerCase()}/hcmUI/CandidateExperience/en/sites/${m[2]}/requisitions`, slug: m[1].split('.')[0].toLowerCase() };
  if ((m = url.match(/\/\/([a-z0-9-]+\.taleo\.net)\/careersection\/([^/?#]+)/i)))
    return { careers_url: `https://${m[1].toLowerCase()}/careersection/${m[2]}/jobsearch.ftl`, slug: m[1].split('.')[0].toLowerCase() };
  if ((m = url.match(/\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/)))
    return { careers_url: `https://${m[1]}.${m[2]}.myworkdayjobs.com/${m[3]}`, slug: m[1].toLowerCase() };
  return null;
}

// User seed: portals.yml tracked_companies + profile discovery.seed_companies. No built-in list —
// which employers matter depends entirely on the user's role and metro.
function loadSeeds(profile) {
  const out = [];
  const push = (company, url) => { if (company && /^https?:\/\//.test(url || '')) out.push({ company: String(company).trim(), careers_url: String(url).trim() }); };
  if (existsSync('portals.yml')) {
    try {
      const p = yaml.load(readFileSync('portals.yml', 'utf-8')) || {};
      for (const c of p.tracked_companies || []) if (c.enabled !== false) push(c.name, c.careers_url);
    } catch (e) { console.error(`  portals.yml unreadable (${e.message}); skipping`); }
  }
  for (const c of profile.discovery?.seed_companies || []) {
    if (typeof c === 'string') {
      const [name, url] = c.split('|').map(s => s.trim());
      push(name, url || undefined);
    } else if (c && typeof c === 'object') push(c.company || c.name, c.careers_url || c.url);
  }
  return out;
}

function loadExisting() {
  const keys = new Set();
  const names = new Set();
  if (existsSync(INDEX_PATH)) {
    for (const line of readFileSync(INDEX_PATH, 'utf-8').split('\n').slice(1)) {
      const cols = line.split('\t');
      const cu = cols[2];
      if (cu) keys.add(cu.toLowerCase());
      const name = (cols[0] || '').trim();
      if (name) names.add(name.toLowerCase());
    }
  }
  keys.names = names;
  return keys;
}

function collectFromScanHistory() {
  const out = new Map(); // careers_url -> {company, careers_url}
  if (!existsSync(SCAN_HISTORY_PATH)) return out;
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1);
  for (const line of lines) {
    const cols = line.split('\t');
    const url = cols[0]; const company = (cols[4] || '').trim();
    if (!url) continue;
    const board = deriveBoard(url);
    if (!board) continue;
    if (!out.has(board.careers_url)) {
      out.set(board.careers_url, { company: company || board.slug, careers_url: board.careers_url });
    }
  }
  return out;
}

function main() {
  const profile = requireTargets();
  const dryRun = process.argv.includes('--dry-run');
  const existing = loadExisting();

  // Merge candidate sources (careers_url -> {company, careers_url, source})
  const candidates = new Map();
  for (const [cu, v] of collectFromScanHistory()) candidates.set(cu, { ...v, source: 'scan-history' });
  for (const c of loadSeeds(profile)) if (!candidates.has(c.careers_url)) candidates.set(c.careers_url, { ...c, source: 'seed' });

  const rows = [];
  let withApi = 0, browserOnly = 0; const unsupported = {};
  for (const c of candidates.values()) {
    if (existing.has(c.careers_url.toLowerCase())) continue; // dedup on careers_url
    const nameKey = (c.company || '').trim().toLowerCase();
    if (nameKey && existing.names.has(nameKey)) continue; // dedup on company name
    const api = detectApi({ careers_url: c.careers_url });
    if (api) withApi++; else browserOnly++;
    const fam = api ? null : detectFamily(c.careers_url);
    if (fam) unsupported[fam] = (unsupported[fam] || 0) + 1;
    if (nameKey) existing.names.add(nameKey); // guard against dupes within this batch
    rows.push([
      c.company, '', c.careers_url, api?.type || fam || '', api?.url || '',
      c.source, TODAY, '', '',
    ].join('\t'));
  }

  console.log(`Candidates: ${candidates.size} | already indexed: ${existing.size} | new: ${rows.length}`);
  console.log(`  with ATS API: ${withApi} | browser-only: ${browserOnly}`);
  if (Object.keys(unsupported).length) console.log(`  unsupported ATS (detected, not scanned): ${JSON.stringify(unsupported)}`);

  if (dryRun) { console.log('(dry run — nothing written)'); rows.slice(0, 10).forEach(r => console.log('  + ' + r.split('\t').slice(0,5).join(' | '))); return; }

  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, HEADER, 'utf-8');
  if (rows.length) appendFileSync(INDEX_PATH, rows.join('\n') + '\n', 'utf-8');

  const total = readFileSync(INDEX_PATH, 'utf-8').split('\n').filter(Boolean).length - 1;
  console.log(`Wrote ${rows.length} new rows → ${INDEX_PATH} (total: ${total} companies)`);
}

main();
