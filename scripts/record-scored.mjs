#!/usr/bin/env node

/**
 * record-scored.mjs — append a scored job to data/scored-jobs.tsv with a precise found_at
 * timestamp (so the dashboard's rolling-24h "Found" panel is accurate to the minute).
 *
 * Schema (12 cols): date company role score verdict why url found_at applied_at
 *                   dismissed_at aged source
 *
 * cols 10-11 (`dismissed_at`, `aged`) were UNDOCUMENTED until 2026-09-10 but have always been
 * written by prune-board.mjs:77. They are load-bearing: prune-board.mjs:66 treats a non-empty
 * col 10 as "already dismissed", so anything written there is silently exempted from pruning.
 * That is why `source` is col 12 and NOT col 10.
 *
 * `source` (added 2026-09-10) names the LANE that found the row: scan-index | linkedin |
 * hiringcafe | google | wellfound | yc | builtin | careers | indeed | linkedin-loggedin |
 * linkedin-crawl | aged-backlog | near-miss-reread | primary-backstop | web-roles.
 * Without it, qualifiers-per-lane is uncomputable, which is the state the pipeline was in:
 * the 1898 historical rows carry no lane tag and the queue files they came from are
 * overwritten each cycle, so that history is NOT recoverable. The column only pays forward.
 * Rows written before this date have 9 fields; every consumer guards with `length < 9`,
 * so a missing 10th reads as empty rather than breaking.
 *
 * Usage:
 *   node scripts/record-scored.mjs <date> <company> <role> <score> <verdict> <why> <url> [found_at_iso]
 * Example:
 *   node scripts/record-scored.mjs 2026-06-08 Acme "Senior Data Engineer" 4.3 QUALIFIED "stack match" https://...
 *
 * found_at defaults to now (ISO). applied_at is left empty (the dashboard sets it on "mark applied").
 * Dedup: if an identical company+role+url already exists, the row is skipped.
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';

const a = process.argv.slice(2);
if (a.length < 7) {
  console.error('usage: node scripts/record-scored.mjs <date> <company> <role> <score> <verdict> <why> <url> [found_at_iso] [source]');
  process.exit(1);
}
const [date, company, role, score, verdict, why, url, foundAtArg, sourceArg] = a;
const source = sourceArg || '';
const foundAt = foundAtArg || new Date().toISOString();
const path = 'data/scored-jobs.tsv';

// dedup vs existing company+role+url
if (existsSync(path)) {
  const txt = readFileSync(path, 'utf-8').toLowerCase();
  const key = `${company}\t${role}`.toLowerCase();
  if (txt.includes(key) && txt.includes(url.toLowerCase())) {
    console.log(`skip (already present): ${company} | ${role}`);
    process.exit(0);
  }
}

const row = [date, company, role, score, verdict, why, url, foundAt, '', '', '', source].join('\t');
appendFileSync(path, row + '\n');
console.log(`recorded: ${company} | ${role} | ${score} | found_at=${foundAt}`);
