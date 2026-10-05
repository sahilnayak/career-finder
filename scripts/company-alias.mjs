#!/usr/bin/env node

/**
 * company-alias.mjs — turn an employer name as a SOURCE prints it into the name we index under.
 *
 * WHY IT IS ITS OWN MODULE. This logic belongs to linkedin-crawl.mjs conceptually, but that
 * script has top-level side effects (it opens a browser and spends LinkedIn budget the moment
 * it is loaded), so `import { canonicalCompany } from './linkedin-crawl.mjs'` starts a crawl.
 * That has now cost real budget twice. Anything importable lives here instead.
 *
 * Two failure shapes:
 *
 *   RENAME      LinkedIn serves reqs from the company PAGE they were posted on, and a rebrand
 *               leaves the legacy page live for months. Three Firecrawl reqs were listed under
 *               "Mendable"; one of them had never been scored at all, even though Firecrawl is
 *               in the index with a working Ashby board.
 *
 *   DECORATION  "Siemens EDA (Siemens Digital Industries Software)", "Monolithic Power Systems,
 *               Inc." — suffixes and parentheticals the index key does not carry, so the exact
 *               lookup misses and the prefix fallback is thrown by the extra tokens.
 *
 * Renames are data (data/company-aliases.tsv, two columns). Decoration-stripping is structural
 * and lives in code. Both are deliberately conservative: a wrong canonical name degrades to
 * "board not found", never to a wrong job, because callers still require a title match.
 *
 *   node scripts/company-alias.mjs "Mendable" "Siemens EDA (Siemens Digital Industries Software)"
 */

import { readFileSync } from 'fs';

const ALIAS_FILE = new URL('../data/company-aliases.tsv', import.meta.url).pathname;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const ALIASES = (() => {
  const m = new Map();
  try {
    for (const line of readFileSync(ALIAS_FILE, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [from, to] = t.split('\t').map(s => (s || '').trim());
      if (from && to) m.set(norm(from), to);
    }
  } catch { /* the alias file is optional; decoration-stripping still applies */ }
  return m;
})();

/** Source display name -> the name data/company-index.tsv uses. */
export function canonicalCompany(name) {
  let s = String(name || '').trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  s = s.replace(/[,\s]+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|corp|corp\.|corporation|gmbh|plc|s\.a\.|pty)\s*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return ALIASES.get(norm(s)) || s;
}

/** Index-lookup key for a company name. */
export const companyKey = name => norm(canonicalCompany(name));

export const aliasCount = () => ALIASES.size;

// CLI: only when run directly, so importing this file is always free of side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(`company-alias: ${ALIASES.size} alias(es) loaded from data/company-aliases.tsv`);
    for (const [k, v] of ALIASES) console.log(`  ${k} -> ${v}`);
  } else {
    for (const a of args) console.log(`${JSON.stringify(a)} -> ${JSON.stringify(canonicalCompany(a))}  [key: ${companyKey(a)}]`);
  }
}
