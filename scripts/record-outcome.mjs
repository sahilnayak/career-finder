#!/usr/bin/env node

/**
 * record-outcome.mjs — Log what happened with a qualifier (feeds feedback-outcomes.mjs).
 *
 * Usage:  node scripts/record-outcome.mjs <url|company-substring> <outcome> [--role <substring>]
 *   outcome ∈ pending | applied | responded | interview | offer | rejected | skipped
 *
 * AN AMBIGUOUS KEY IS A HARD STOP — it does not write.
 *
 * The company key is a SUBSTRING match and an employer routinely has several live requisitions.
 * This used to update every matching row at once, so a single
 *     record-outcome.mjs "Antithesis" rejected
 * stamped `rejected` on BOTH the req that was actually rejected AND a second req at the same
 * employer that was still pending, when the rejection mail named only one role.
 *
 * That corrupts the thing this file exists to feed: feedback-outcomes.mjs computes response rates
 * per archetype from these rows, so one bad stamp teaches the search that a live lane is dead.
 * Harm is asymmetric — refusing costs one re-run with a narrower key, a false stamp silently
 * poisons targeting — so match ONE requisition or write nothing.
 *
 * Same failure class as the merge-tracker row-773 overwrite and the old web-roles.mjs dedup:
 * employer-level identity applied to per-requisition data.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const OUT = 'data/qualifier-outcomes.tsv';
const VALID = ['pending', 'applied', 'responded', 'interview', 'offer', 'rejected', 'skipped'];

const argv = process.argv.slice(2);
const roleIdx = argv.indexOf('--role');
// Guard the flag value the same way the crawler's val() does: a missing operand must not silently
// swallow the next flag and become a filter nobody intended.
const role = roleIdx !== -1 && argv[roleIdx + 1] && !argv[roleIdx + 1].startsWith('--')
  ? argv[roleIdx + 1] : null;
// `roleIdx + 1` is only the flag's operand when the flag is actually present; guarding on
// roleIdx !== -1 matters because -1 + 1 === 0 would otherwise drop the FIRST positional (the key).
const valueIdx = roleIdx !== -1 && role ? roleIdx + 1 : -1;
const positional = argv.filter((a, i) => i !== roleIdx && i !== valueIdx && !a.startsWith('--'));
const [key, outcome] = positional;

if (!key || !VALID.includes(outcome)) {
  console.error(`usage: node scripts/record-outcome.mjs <url|company> <${VALID.join('|')}> [--role <substring>]`);
  process.exit(1);
}
if (!existsSync(OUT)) { console.error('No outcomes file yet — run: node scripts/feedback-outcomes.mjs'); process.exit(1); }

const lines = readFileSync(OUT, 'utf-8').split('\n').filter(Boolean);
const I = Object.fromEntries(lines[0].split('\t').map((h, i) => [h, i]));
const today = new Date().toISOString().slice(0, 10);

const rows = lines.slice(1).map(l => l.split('\t'));
const matches = [];
rows.forEach((c, i) => {
  const hit = (c[I.url] || '').includes(key)
    || (c[I.company] || '').toLowerCase().includes(key.toLowerCase());
  if (!hit) return;
  if (role && !(c[I.role] || '').toLowerCase().includes(role.toLowerCase())) return;
  matches.push(i);
});

if (matches.length === 0) {
  console.log(`no match for "${key}"${role ? ` + --role "${role}"` : ''} in ${OUT}`);
  process.exit(0);
}

if (matches.length > 1) {
  console.error(`AMBIGUOUS: "${key}"${role ? ` + --role "${role}"` : ''} matches ${matches.length} requisitions — refusing to write.`);
  console.error('These are separate reqs; stamping them together would corrupt the per-archetype response rates.\n');
  for (const i of matches) {
    console.error(`  ${rows[i][I.company]} | ${rows[i][I.role]}  [${rows[i][I.outcome] || 'pending'}]`);
    console.error(`    ${rows[i][I.url]}`);
  }
  console.error('\nRe-run with --role "<distinguishing words>", or pass the exact URL.');
  process.exit(2);
}

const c = rows[matches[0]];
c[I.outcome] = outcome; c[I.updated] = today;
writeFileSync(OUT, [lines[0], ...rows.map(r => r.join('\t'))].join('\n') + '\n');
console.log(`updated 1 row → ${outcome}: ${c[I.company]} | ${c[I.role]}`);
