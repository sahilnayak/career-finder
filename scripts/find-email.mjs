#!/usr/bin/env node

/**
 * find-email.mjs — email finder helper, run automatically while building the
 * outreach HTML (gen-outreach.mjs imports findEmail). Only matches with
 * confidence >= threshold (default 80) are returned; weaker guesses are
 * rejected so the HTML never carries an address below the bar.
 *
 * Sources, in order of trust:
 *   1. Hunter.io Email Finder API (set HUNTER_API_KEY in .env) — uses Hunter's
 *      own 0-100 score. Memory: Hunter verdicts are trustworthy.
 *   2. Company-site scrape (/, /about, /team, /contact, /people) — mailto: and
 *      plain addresses on the company's own domain. 90 for first+last name
 *      match, 85 for unambiguous first-name match.
 *   3. GitHub commit emails via `gh api search/commits` — engineers leak real
 *      addresses in commit metadata. 92 when an address on the company domain
 *      matches the person's name.
 *   4. Pattern + verifier fallback — when 1-3 miss but the company's address
 *      pattern is knowable, construct the candidate(s) (first@, first.last@,
 *      firstlast@, flast@) and verify each against the real mailbox via Hunter's
 *      email-verifier. Only a `valid` + `deliverable` + `accept_all:false`
 *      verdict counts (a catch-all domain returns valid for everything, so it
 *      proves nothing). Confidence capped at 88 (an alias can also be valid).
 *      Pass `pattern:"first"` to force just that pattern (e.g. when colleagues
 *      already confirmed first@domain), else all common patterns are tried.
 * A failing DNS MX lookup on the domain rejects everything (no mailbox there).
 *
 * CLI:    node scripts/find-email.mjs --name "Vivek Muppalla" --domain hippocraticai.com [--threshold 80] [--pattern first]
 *         node scripts/find-email.mjs --verify cat@anthropic.com   # verify one address
 * Module: import { findEmail, verifyEmail } from './find-email.mjs'
 *         await findEmail({ name, domain, threshold, pattern }) -> { email, confidence, source } | { email: null, reason }
 *         await verifyEmail('cat@anthropic.com') -> { email, confidence, source, status } | { email: null, reason }
 */

import './load-env.mjs'; // make HUNTER_API_KEY (etc.) from .env visible
import { execSync } from 'child_process';
import dns from 'dns/promises';

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function hasMx(domain) {
  try { return (await dns.resolveMx(domain)).length > 0; } catch { return false; }
}

async function tryHunter(first, last, domain) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  try {
    const url = `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (data?.email && typeof data.score === 'number') {
      return { email: data.email, confidence: data.score, source: 'hunter.io email-finder' };
    }
  } catch { /* network/quota — fall through to next source */ }
  return null;
}

async function trySiteScrape(first, last, domain) {
  const pages = ['', 'about', 'team', 'contact', 'people', 'company'];
  const found = new Set();
  for (const p of pages) {
    try {
      const res = await fetch(`https://${domain}/${p}`, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const html = await res.text();
      const re = new RegExp(`[a-z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'gi');
      for (const m of html.match(re) || []) found.add(m.toLowerCase());
    } catch { /* page missing or slow — skip */ }
  }
  const fullHit = [...found].find(e => e.includes(first) && e.includes(last));
  if (fullHit) return { email: fullHit, confidence: 90, source: `site scrape (${domain})` };
  const firstHits = [...found].filter(e => e.split('@')[0].replace(/[._-]/g, '').startsWith(first));
  if (firstHits.length === 1) return { email: firstHits[0], confidence: 85, source: `site scrape (${domain})` };
  return null;
}

function tryGithubCommits(name, first, last, domain) {
  try {
    // GitHub's commit search needs the cloak-preview Accept header and a properly
    // URL-encoded query; without both, `gh api search/commits` returns empty
    // (this is how a real address was missed before the fix).
    const q = `author-name:${encodeURIComponent(`"${name}"`)}`;
    const out = execSync(
      `gh api -H "Accept: application/vnd.github.cloak-preview+json" 'search/commits?q=${q}&per_page=30' --jq '[.items[].commit.author | {name, email}] | unique'`,
      { encoding: 'utf-8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const authors = JSON.parse(out);
    const hit = authors.find(a =>
      a.email?.toLowerCase().endsWith(`@${domain}`) &&
      (norm(a.name).includes(first) || a.email.toLowerCase().includes(first)));
    if (hit) return { email: hit.email.toLowerCase(), confidence: 92, source: 'github commit metadata' };
  } catch { /* gh not authed or no results */ }
  return null;
}

// Hunter email-verifier on a specific address. A non-catch-all domain (accept_all:false)
// that returns valid+deliverable is a real mailbox confirmation; a catch-all (accept_all:true)
// returns valid for any address, so it proves nothing and is rejected here.
async function verifyAddress(email) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${key}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const { data } = await res.json();
    if (data && data.status === 'valid' && data.result === 'deliverable' && data.accept_all === false) {
      return { email, confidence: Math.min(88, data.score ?? 88), source: 'hunter email-verifier (pattern)', status: data.status };
    }
    return { email: null, status: data?.status, accept_all: data?.accept_all, score: data?.score };
  } catch { return null; }
}

// Public: verify one address (CLI --verify / module verifyEmail).
export async function verifyEmail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (!domain) return { email: null, reason: 'not an email address' };
  if (!(await hasMx(domain))) return { email: null, reason: `no MX records for ${domain}` };
  const v = await verifyAddress(email);
  if (v?.email) return v;
  return { email: null, reason: v?.accept_all ? `${domain} is catch-all (accept_all) — cannot confirm a specific address` : `not deliverable (status=${v?.status ?? 'unknown'})` };
}

// Common corporate address patterns, in order of prevalence.
function patternCandidates(first, last, domain, only) {
  const f = first, l = last;
  const all = {
    first: `${f}@${domain}`,
    'first.last': `${f}.${l}@${domain}`,
    firstlast: `${f}${l}@${domain}`,
    flast: `${f[0]}${l}@${domain}`,
    'first_last': `${f}_${l}@${domain}`,
  };
  if (only && all[only]) return [all[only]];
  return [all.first, all['first.last'], all.firstlast, all.flast];
}

export async function findEmail({ name, domain, threshold = 80, pattern = null }) {
  const parts = norm(name).trim().split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !domain) return { email: null, reason: 'name and domain required' };
  if (!(await hasMx(domain))) return { email: null, reason: `no MX records for ${domain}` };

  const candidates = [];
  const hunter = await tryHunter(first, last, domain);
  if (hunter) candidates.push(hunter);
  if (!candidates.some(c => c.confidence >= threshold)) {
    const site = await trySiteScrape(first, last, domain);
    if (site) candidates.push(site);
  }
  if (!candidates.some(c => c.confidence >= threshold)) {
    const gh = tryGithubCommits(name, first, last, domain);
    if (gh) candidates.push(gh);
  }
  // 4. Pattern + verifier fallback — when name-based finders miss, construct and verify.
  if (!candidates.some(c => c.confidence >= threshold)) {
    for (const cand of patternCandidates(first, last, domain, pattern)) {
      const v = await verifyAddress(cand);
      if (v?.email) { candidates.push(v); break; }
    }
  }

  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
  if (best && best.confidence >= threshold) return best;
  return {
    email: null,
    reason: best
      ? `best match ${best.email} only ${best.confidence}% (${best.source}) — below ${threshold}% bar`
      : `no address found >= ${threshold}% across hunter/site/github`,
  };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (args.verify) {
    verifyEmail(args.verify).then(r => console.log(JSON.stringify(r, null, 2)));
  } else if (args.name && args.domain) {
    findEmail({ name: args.name, domain: args.domain, threshold: Number(args.threshold) || 80, pattern: args.pattern || null })
      .then(r => console.log(JSON.stringify(r, null, 2)));
  } else {
    console.error('Usage: node scripts/find-email.mjs --name "First Last" --domain company.com [--threshold 80] [--pattern first]');
    console.error('   or: node scripts/find-email.mjs --verify name@company.com');
    process.exit(1);
  }
}
