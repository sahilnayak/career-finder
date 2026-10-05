#!/usr/bin/env node

/**
 * find-people.mjs — find real people at a company WITHOUT touching LinkedIn.
 *
 * WHY. Contact discovery had exactly one route (the LinkedIn roster/search), so whenever
 * that route was blocked the whole outreach pipeline stalled. On 2026-07-27 all three of
 * its gates closed at once: the people-search lane hit 12/12, the rolling-hour burst hit
 * 11/12, and Hunter's monthly quota hit 50/50 with 0 searches left. Four qualified jobs sat
 * undraftable, waiting on a clock. This is the second route.
 *
 * WHAT IT ACTUALLY BUYS — the pattern, not just the names. GitHub commit metadata carries
 * `author.email` verbatim, so a single API call yields REAL employees at their REAL
 * corporate addresses. Verified on Cursor/Anysphere: 7 confirmed staff and, more usefully,
 * **the address pattern** (`first@anysphere.co`, `flast@cursor.com`). Once the pattern is
 * known, ANY name learned from ANY source — a blog byline, a conference bill, a press
 * quote, a name the user already has — converts into a reachable address with no Hunter
 * credit and no LinkedIn action. Patterns generalise; scraped individuals do not.
 *
 * HONEST LIMITS, so this is not oversold:
 *   - GitHub finds ENGINEERS. It reliably fills the Peer slot and rarely the Hiring
 *     Manager, essentially never a Recruiter. Non-technical staff do not commit code.
 *   - A corporate-domain commit email PROVES employment at commit time; a gmail address on
 *     an org repo usually means an outside contributor. Only the former confirms employer.
 *   - Pattern-derived addresses for people found elsewhere are INFERRED. Label them so, and
 *     prefer a verified channel for the first touch.
 *
 * Usage:
 *   node scripts/find-people.mjs --company Cursor --github cursor,anysphere --domain cursor.com
 *   node scripts/find-people.mjs --company Notion --github notion --domain notion.com --json
 *   node scripts/find-people.mjs --company X --domain x.com --derive "Jane Doe,John Roe"
 */

import { existsSync, readFileSync } from 'fs';

// INTERACTIVE-ONLY (item #21). Contact discovery spends lookups and touches people data. The scheduled run (morning.mjs) sets UNATTENDED=1 and runs
// claude with --dangerously-skip-permissions, so this must never fire from cron.
if (!process.stdout.isTTY || process.env.UNATTENDED === '1') {
  console.error('find-people: refused — interactive-only (no TTY or UNATTENDED=1). Run it yourself from a terminal.');
  process.exit(2);
}

const val = (f, d = '') => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const has = f => process.argv.includes(f);
const COMPANY = val('--company');
const GH_ORGS = val('--github').split(',').map(s => s.trim()).filter(Boolean);
const DOMAIN = val('--domain');
const DERIVE = val('--derive').split(',').map(s => s.trim()).filter(Boolean);
const JSON_OUT = has('--json');
const MAX_REPOS = Number(val('--repos', 6));

if (!COMPANY) { console.error('Usage: find-people.mjs --company "X" [--github org1,org2] [--domain x.com] [--derive "Name One,Name Two"] [--json]'); process.exit(2); }

const BOT = /noreply|users\.noreply|actions@|bot@|\[bot\]|dependabot|renovate|semantic-release/i;
const out = { company: COMPANY, people: [], patterns: [], derived: [], notes: [] };

async function gh(path) {
  try {
    const h = { accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com${path}`, { headers: h, signal: AbortSignal.timeout(12000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ── 1. GitHub commit-author mining ─────────────────────────────────────────
for (const org of GH_ORGS) {
  const repos = await gh(`/orgs/${org}/repos?sort=pushed&per_page=${MAX_REPOS}`);
  if (!Array.isArray(repos)) { out.notes.push(`github: org "${org}" not readable (private or nonexistent)`); continue; }
  for (const r of repos.slice(0, MAX_REPOS)) {
    const commits = await gh(`/repos/${org}/${r.name}/commits?per_page=60`);
    if (!Array.isArray(commits)) continue;
    for (const c of commits) {
      const a = c.commit?.author || {};
      if (!a.name || !a.email || BOT.test(a.email) || BOT.test(a.name)) continue;
      const email = a.email.toLowerCase();
      if (out.people.some(p => p.email === email)) continue;
      out.people.push({ name: a.name, email, login: c.author?.login || null, via: `${org}/${r.name}`, source: 'github-commit' });
    }
  }
}

// ── 2. Infer the address pattern — the part that generalises ───────────────
// Only corporate-domain addresses count: a gmail on an org repo is an outside contributor,
// not proof of employment.
const domTokens = [DOMAIN, ...GH_ORGS].filter(Boolean).map(d => String(d).split('.')[0].toLowerCase());
const corp = out.people.filter(p => domTokens.some(t => p.email.includes(t)));
const patternOf = (name, email) => {
  const [local, dom] = email.split('@');
  const parts = String(name).toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return local === parts[0] ? { pattern: '{first}', dom } : null;
  const [f, l] = [parts[0], parts[parts.length - 1]];
  const map = {
    '{first}': f, '{last}': l, '{first}{last}': f + l, '{first}.{last}': `${f}.${l}`,
    '{f}{last}': f[0] + l, '{first}_{last}': `${f}_${l}`, '{f}.{last}': `${f[0]}.${l}`,
    '{first}{l}': f + l[0],
  };
  for (const [pat, v] of Object.entries(map)) if (v === local) return { pattern: pat, dom };
  return null;
};
const tally = {};
for (const p of corp) {
  const m = patternOf(p.name, p.email);
  if (m) { const k = `${m.pattern}@${m.dom}`; tally[k] = (tally[k] || 0) + 1; }
}
out.patterns = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ pattern: k, evidence: n }));
out.corporate = corp.map(p => ({ name: p.name, email: p.email, via: p.via }));

// ── 3. Derive addresses for names learned ANYWHERE else ────────────────────
if (DERIVE.length && out.patterns.length) {
  const [pat, dom] = out.patterns[0].pattern.split('@');
  for (const full of DERIVE) {
    const parts = full.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [f, l] = [parts[0], parts[parts.length - 1]];
    const local = pat.replace('{first}', f).replace('{last}', l).replace('{f}', f[0]).replace('{l}', l[0]);
    out.derived.push({ name: full, email: `${local}@${dom}`, confidence: 'INFERRED from pattern — verify before relying on it', basis: `${out.patterns[0].pattern} (${out.patterns[0].evidence} confirmed)` });
  }
}

if (!GH_ORGS.length) out.notes.push('no --github org given; pass one to mine commit metadata (that is where the pattern comes from)');
if (!out.corporate.length && GH_ORGS.length) out.notes.push('no corporate-domain commit emails — org may squash-merge or use noreply addresses');
out.notes.push('GitHub finds ENGINEERS: fills Peer, sometimes Hiring Manager, essentially never Recruiter.');

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`\n━━━ PEOPLE AT ${COMPANY} — found without LinkedIn ━━━\n`);
console.log(`CONFIRMED EMPLOYEES (corporate-domain commit email = employed at commit time): ${out.corporate.length}`);
for (const p of out.corporate) console.log(`  ${p.name.padEnd(24)} ${p.email.padEnd(32)} via ${p.via}`);
if (out.patterns.length) {
  console.log(`\nADDRESS PATTERN — the part that generalises:`);
  for (const p of out.patterns) console.log(`  ${p.pattern.padEnd(28)} (${p.evidence} confirmed example${p.evidence > 1 ? 's' : ''})`);
  console.log(`  → any name you learn ANYWHERE now converts to an address, no Hunter credit, no LinkedIn action.`);
}
if (out.derived.length) {
  console.log(`\nDERIVED (INFERRED — verify before relying on it):`);
  for (const d of out.derived) console.log(`  ${d.name.padEnd(24)} ${d.email.padEnd(32)} [${d.basis}]`);
}
const others = out.people.filter(p => !out.corporate.includes(p));
if (others.length) console.log(`\n(${others.length} other commit authors on non-corporate addresses — likely outside contributors, NOT employer-confirmed)`);
console.log('\nNOTES:');
for (const n of out.notes) console.log('  · ' + n);
console.log('');
