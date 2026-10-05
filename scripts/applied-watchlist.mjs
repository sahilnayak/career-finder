#!/usr/bin/env node

/**
 * applied-watchlist.mjs — jobs you've applied to that are still awaiting a
 * decided outcome, for the Gmail outcome sweep (the outcomes step in scripts/morning.mjs, prompt
 * from the outcomes section of modes/feedback.md). An empty list `[]` lets that step skip for free.
 *
 * Source of truth for "applied" = data/applications.md Status column. A row is
 * on the watchlist when its status is in-flight (Applied / Responded / Interview)
 * — i.e. there is still a next signal (a reply, an interview invite, an offer, a
 * rejection) to detect in the inbox. Terminal rows (Offer / Rejected / SKIP /
 * Discarded / Evaluated) are excluded.
 *
 * Joins the company email domain from data/li-slugs.tsv (3rd column) so the
 * inbox search can be scoped to from:@domain when known.
 *
 * Usage:  node scripts/applied-watchlist.mjs [--json]   (default: JSON)
 */

import { readFileSync, existsSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const INFLIGHT = new Set(['applied', 'responded', 'interview']);

// email domain by normalized company (from li-slugs.tsv: company \t slug \t domain)
const domainBy = new Map();
const slugPath = `${ROOT}data/li-slugs.tsv`;
if (existsSync(slugPath)) for (const line of readFileSync(slugPath, 'utf8').split('\n')) {
  const [co, , dom] = line.split('\t'); if (co && dom) domainBy.set(norm(co), dom.trim());
}

const appsPath = `${ROOT}data/applications.md`;
if (!existsSync(appsPath)) { process.stdout.write('[]\n'); process.exit(0); }

const rows = [];
for (const line of readFileSync(appsPath, 'utf8').split('\n')) {
  if (!/^\s*\|/.test(line)) continue;                 // table rows only
  const c = line.split('|').map(s => s.trim());
  // c[0] is '' (leading pipe). columns: # Date Company Role Score Status PDF Report Notes
  const [, num, date, company, role, score, status] = c;
  if (!num || num === '#' || /^-+$/.test(num)) continue; // header / divider
  if (!company || !status) continue;
  if (!INFLIGHT.has(status.toLowerCase())) continue;
  // pull a url out of the Report link if present (else null; detect step searches by name)
  rows.push({
    num: Number(num) || num,
    date: date || null,
    company,
    role: role || null,
    score: score || null,
    status,
    domain: domainBy.get(norm(company)) || null,
  });
}

process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
