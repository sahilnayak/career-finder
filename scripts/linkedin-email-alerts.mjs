#!/usr/bin/env node

/**
 * linkedin-email-alerts.mjs — mine the Gmail inbox for LinkedIn job alerts and recruiter InMail.
 *
 * WHY. LinkedIn emails two things worth having, and the pipeline was reading neither:
 *   1. SAVED-SEARCH ALERTS (jobalerts-noreply@) whose SUBJECT already carries company, title
 *      and posted date, e.g.  “<saved search>”: <Company> - <Job Title> posted on 6/8/26
 *   2. RECRUITER INMAIL (inmail-hit-reply@) — a named human at a company who contacted the
 *      candidate first. Recruiters tend to be the highest-replying persona, so an
 *      inbound recruiter is the warmest contact the system can get.
 *
 * TRUST MODEL — identical to every other lane. The alert's "posted on" is LinkedIn's claim and
 * is worth exactly what a card's "3 hours ago" is worth (measured elsewhere: routinely off by
 * months). Nothing here is written as a find on LinkedIn's say-so. Where the email body yields
 * a /jobs/view/ id, that id goes through linkedin-applyurl.mjs to reach the employer's own ATS
 * record, which is the only accepted source of a date or a location.
 *
 * READ-ONLY. This never sends, replies, labels, archives or deletes. Gmail is queried with an
 * existing refresh token; the only API method used is users.messages.list/get.
 *
 * Usage:
 *   node scripts/linkedin-email-alerts.mjs                 # report only
 *   node scripts/linkedin-email-alerts.mjs --write         # append verified reqs + contacts
 *   node scripts/linkedin-email-alerts.mjs --days 30
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { canonicalCompany } from './company-alias.mjs';
import { applyUrlForJob, parseAtsUrl } from './linkedin-applyurl.mjs';
import { requireTargets, loadNoise, titleMatches, titleDropped, locationMatches, areaLabel } from './role-filters.mjs';
import { tracked as trackedFetch } from './request-ledger.mjs'; // every outbound request is counted

requireTargets();

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const val = (f, d) => { const i = argv.indexOf(f); const n = argv[i + 1]; return i > -1 && n && !n.startsWith('--') ? n : d; };
const DAYS = Number(val('--days', 14)) || 14;
// Historical sweeps exist to harvest EMPLOYERS, not reqs — a June alert's job is long closed,
// but the employer is a permanent addition to ATS coverage. Skip the per-job browser spend.
const EMPLOYERS_ONLY = argv.includes('--employers-only');
const CRED = `${homedir()}/.gmail-mcp/credentials.json`;
const KEYS = `${homedir()}/.gmail-mcp/gcp-oauth.keys.json`;

// ── auth ───────────────────────────────────────────────────────────────────
async function accessToken() {
  if (!existsSync(CRED) || !existsSync(KEYS)) throw new Error('gmail credentials not found in ~/.gmail-mcp');
  const cred = JSON.parse(readFileSync(CRED, 'utf-8'));
  const keys = JSON.parse(readFileSync(KEYS, 'utf-8')).installed;
  if (cred.access_token && Date.now() < (cred.expiry_date || 0) - 60000) return cred.access_token;
  const r = await trackedFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: keys.client_id, client_secret: keys.client_secret,
      refresh_token: cred.refresh_token, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).access_token;
}

const api = async (tok, path) => {
  const r = await trackedFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
    { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`gmail ${path.split('?')[0]}: ${r.status}`);
  return r.json();
};

// ── subject parsing ────────────────────────────────────────────────────────
// Every observed LinkedIn job-email subject shape, most specific first. Each returns
// {company, title} or null. Kept pure so it is testable without a network or a mailbox.
export function parseJobSubject(subjectRaw) {
  const s = String(subjectRaw || '').replace(/\s+/g, ' ').trim();
  let m;
  // “saved search”: Company - Title posted on M/D/YY
  if ((m = s.match(/^[“"](.+?)[”"]\s*:\s*(.+?)\s+-\s+(.+?)\s+posted on\s+\d/i)))
    return { company: m[2], title: m[3], savedSearch: m[1] };
  // Title at Company: up to $160K/year
  if ((m = s.match(/^(.+?)\s+at\s+(.+?)\s*:\s*up to\s*\$/i)))
    return { company: m[2], title: m[1] };
  // You may be a fit for Company’s Title role
  if ((m = s.match(/^You may be a fit for\s+(.+?)[’']s\s+(.+?)\s+role/i)))
    return { company: m[1], title: m[2] };
  // New jobs similar to Title at Company
  if ((m = s.match(/^New jobs similar to\s+(.+?)\s+at\s+(.+)$/i)))
    return { company: m[2], title: m[1] };
  // Company is hiring for a X role   → title is a category, not a req; keep for discovery only
  if ((m = s.match(/^(.+?)\s+is hiring for a\s+(.+?)\s+role/i)))
    return { company: m[1], title: m[2], vague: true };
  // Title [TAG] at Company   /   Title at Company
  if ((m = s.match(/^(.+?)\s+at\s+(.+?)$/i)) && !/^re:/i.test(s))
    return { company: m[2], title: m[1].replace(/\s*\[[^\]]*\]\s*/g, ' ').trim() };
  return null;
}

// Off-target inbound is the majority of InMail volume. Filtering here
// keeps the warm-contact file worth reading rather than a dump of every recruiter blast.
// Gates applied to the RESOLVED ATS record before any row is written. The first version of this
// lane resolved the record and wrote it unconditionally, which put a years-old out-of-area req, a
// remote req and two unparsed epoch timestamps straight into the shared feed. The
// crawl's tier 3 applies exactly these gates; a second lane writing to the same file must apply
// them too or it silently lowers the bar for everyone downstream.
// Location gate = config/profile.yml `location` (targets.locationMatches, remote_policy aware).
const REMOTE_LOC = /\b(remote|anywhere|distributed|wfh)\b/i;
const MAX_AGE_H = Number(process.env.CAREER_OPS_EMAIL_MAX_AGE_H || 72);

/** Boards do not agree on a date format: ISO strings, Unix SECONDS and Unix MILLIS all occur
 *  (Lever returns millis, some Greenhouse mirrors return seconds). Guess by magnitude. */
function parsePub(v) {
  if (v == null) return NaN;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n > 1e11 ? n : n * 1000;      // >1e11 is already millis
  }
  return Date.parse(v);
}

// Target titles come from config (targets.roles + title_keywords; negatives per role-filters).
const ON_ARCHETYPE = { test: (t) => titleMatches(String(t || '')) };
const OFF_ARCHETYPE = { test: (t) => titleDropped(String(t || '')) };

const header = (payload, name) =>
  (payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function bodyText(payload) {
  let out = '';
  const walk = (p) => {
    if (!p) return;
    if (p.body?.data) { try { out += Buffer.from(p.body.data, 'base64').toString('utf-8'); } catch {} }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}

/** Fetch the exact req an apply href named, so the row carries a REAL location and date rather
 *  than the alert's claim. Mirrors linkedin-crawl.mjs's fetchExactReq. */
async function fetchExact(a) {
  try {
    const r = await trackedFetch(a.apiUrl, { headers: { 'User-Agent': 'career-finder/1.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (a.atsType === 'greenhouse') return { loc: j.location?.name, pub: j.first_published || j.updated_at, url: j.absolute_url };
    if (a.atsType === 'lever') return { loc: j.categories?.location, pub: j.createdAt, url: j.hostedUrl };
    if (a.atsType === 'ashby') {
      const h = (j?.jobs || []).find(x => String(x.id) === String(a.jobId) || String(x.jobUrl || '').includes(a.jobId));
      return h ? { loc: h.location, pub: h.publishedAt, url: h.jobUrl } : null;
    }
  } catch {}
  return null;
}

// ── main ───────────────────────────────────────────────────────────────────
// Guarded so `import { parseJobSubject }` costs nothing. Importing this module used to run the
// whole mailbox sweep as a side effect, which is the same untestability trap linkedin-parse.mjs
// was split out to escape: a parser you cannot exercise offline is a parser that rots silently.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await main();

async function main() {
const tok = await accessToken();
const after = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '/');

// `in:anywhere` is REQUIRED, not optional. Without it Gmail searches only the inbox, and these
// alerts are auto-archived — so the first version of this lane reported "0 alerts in 3 days" and
// "the stream died on July 20" when in fact 20 alerts had arrived in the previous 40 days, the
// most recent that same morning. A lane that silently sees an empty mailbox looks exactly like a
// quiet market; same failure shape as the LinkedIn crawl's dead-lane problem.
const SCOPE = 'in:anywhere';
const QUERIES = {
  alerts: `from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com) ${SCOPE} after:${after}`,
  inmail: `from:inmail-hit-reply@linkedin.com ${SCOPE} after:${after}`,
};

const jobs = [], contacts = [];
for (const [kind, q] of Object.entries(QUERIES)) {
  const list = await api(tok, `messages?q=${encodeURIComponent(q)}&maxResults=100`);
  const ids = (list.messages || []).map(m => m.id);
  console.log(`${kind}: ${ids.length} message(s) in the last ${DAYS}d`);

  for (const id of ids) {
    const msg = await api(tok, `messages/${id}?format=full`);
    const subj = header(msg.payload, 'Subject');
    const from = header(msg.payload, 'From');
    const date = new Date(Number(msg.internalDate)).toISOString();

    if (kind === 'inmail') {
      const who = (from.match(/^"?([^"<]+?)"?\s*</) || [])[1]?.trim() || from;
      contacts.push({ date, name: who, subject: subj,
        archetype: ON_ARCHETYPE.test(subj) ? 'on' : OFF_ARCHETYPE.test(subj) ? 'off' : 'unclear' });
      continue;
    }

    const p = parseJobSubject(subj);
    if (!p) { console.log(`  (unparsed subject) ${subj.slice(0, 80)}`); continue; }
    // Job ids in the body are the bridge to the employer's real ATS record.
    const jobIds = [...new Set([...bodyText(msg.payload).matchAll(/jobs\/view\/(\d{8,})/g)].map(x => x[1]))];
    jobs.push({ date, subject: subj, ...p, jobIds });
  }
}

// ── classify ───────────────────────────────────────────────────────────────
// The shared staffing/aggregator blocklist. Skipping it queued "Stott and May" — a recruiting
// firm ALREADY listed in data/_speed-noise.txt — straight into the discovery queue on the first
// run. Any lane that names employers has to consult the same list or it re-imports known noise.
const NOISE = loadNoise();
const isNoise = (c) => { const l = String(c || '').toLowerCase(); return NOISE.some(n => l.includes(n)); };

// Dedup across saved searches: the same req arrives once per matching alert, so two
// overlapping saved searches both deliver the same role. Keep the
// earliest sighting (that is the real time-to-lead) and carry every job id seen for it.
function dedupeJobs(list) {
  const by = new Map();
  for (const j of list) {
    const k = `${canonicalCompany(j.company).toLowerCase()}|${j.title.toLowerCase()}`;
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...j, jobIds: [...j.jobIds], seenTimes: 1 }); continue; }
    prev.seenTimes++;
    if (j.date < prev.date) prev.date = j.date;
    for (const id of j.jobIds) if (!prev.jobIds.includes(id)) prev.jobIds.push(id);
  }
  return [...by.values()];
}
const onArch = dedupeJobs(
  jobs.filter(j => ON_ARCHETYPE.test(j.title) && !j.vague && !isNoise(canonicalCompany(j.company))));
console.log(`\n${jobs.length} job email(s) parsed → ${onArch.length} distinct on-archetype req(s)`);

const dropped = [...new Set(jobs.map(j => canonicalCompany(j.company)).filter(c => c && isNoise(c)))];
if (dropped.length) console.log(`blocklisted (staffing/aggregator): ${dropped.join(', ')}`);
const employers = new Set(jobs.map(j => canonicalCompany(j.company)).filter(c => c && !isNoise(c)));
console.log(`employers seen: ${[...employers].join(', ') || '(none)'}`);

// Verify on-archetype reqs through the ATS, exactly as every other lane does.
const verified = [], unverified = EMPLOYERS_ONLY ? onArch.slice() : [];
for (const j of (EMPLOYERS_ONLY ? [] : onArch)) {
  let done = false;
  for (const id of j.jobIds.slice(0, 2)) {
    const r = await applyUrlForJob(id).catch(() => null);
    if (r?.ats?.apiUrl) {
      const exact = await fetchExact(r.ats).catch(() => null);
      verified.push({ ...j, ats: { ...r.ats, loc: exact?.loc, pub: exact?.pub, url: exact?.url || r.ats.url } });
      done = true; break;
    }
    if (r?.throttled || r?.authwall) { console.log('  LinkedIn pushed back — stopping ATS resolution'); done = true; break; }
  }
  if (!done) unverified.push(j);
}

console.log(`\nON-ARCHETYPE REQS:`);
for (const v of verified) console.log(`  ✅ ${v.company} — ${v.title} → ${v.ats.atsType}/${v.ats.slug}  ${v.ats.url}`);
for (const u of unverified) console.log(`  ·  ${u.company} — ${u.title}  (no ATS link resolved; employer queued for index)`);

console.log(`\nINBOUND RECRUITERS (warm contacts):`);
for (const c of contacts) console.log(`  ${c.archetype === 'on' ? '★' : ' '} ${c.date.slice(0, 10)}  ${c.name} — ${c.subject.slice(0, 70)}`);

if (WRITE) {
  // Employers → the index discovery queue. This is where historical/aged alerts pay off:
  // the req is long stale but the EMPLOYER is a permanent addition to ATS coverage.
  const DISC = `${ROOT}data/_discovered-companies.tsv`;
  const known = new Set();
  for (const f of [`${ROOT}data/company-index.tsv`, DISC]) {
    try { for (const l of readFileSync(f, 'utf-8').split('\n').slice(1)) {
      const c = l.split('\t')[0]; if (c) known.add(c.toLowerCase().replace(/[^a-z0-9]+/g, ''));
    } } catch {}
  }
  let q = 0;
  for (const e of employers) {
    const k = e.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!k || known.has(k)) continue;
    known.add(k); appendFileSync(DISC, `${e}\t\n`); q++;
  }
  for (const c of contacts) {
    appendFileSync(`${ROOT}data/_inbound-recruiters.tsv`,
      [c.date, c.name, c.archetype, c.subject.replace(/\t/g, ' ')].join('\t') + '\n');
  }
  // Verified reqs join the SAME feed every other lane writes to, in the same 7 columns, so
  // scoring treats an email-sourced role identically to an ATS-sourced one. Without this the
  // lane was decorative: it printed findings and fed nothing.
  const today = new Date().toLocaleDateString('en-CA');
  let w = 0; const gated = [];
  for (const v of verified) {
    const loc = v.ats.loc || '';
    const ms = parsePub(v.ats.pub);
    const ageH = Number.isFinite(ms) ? (Date.now() - ms) / 3.6e6 : Infinity;
    if (loc && !locationMatches(loc, v.title || '')) {
      gated.push(`${v.company}: ${REMOTE_LOC.test(loc) ? 'remote' : `not in ${areaLabel()}`} ("${loc}")`); continue;
    }
    // AGE IS NOT A GATE. It used to drop anything older than MAX_AGE_H.
    // A job alert re-surfaces reqs the employer is still promoting, and promoting means still
    // hiring; publishedAt records when the req was created, not whether they want applicants.
    // The ATS resolution above is still mandatory and still does the real work — it proves the
    // req exists and yields the true location, which is what the two gates above test. Only the
    // clock stopped mattering. The real date is still written so the report can name the age.
    if (ageH > MAX_AGE_H) {
      console.log(`  kept (older than ${MAX_AGE_H}h): ${v.company} — ` +
        `${Number.isFinite(ageH) ? Math.round(ageH) + 'h' : 'ATS date unparseable'}`);
    }
    appendFileSync(`${ROOT}data/_web-roles.tsv`,
      [today, canonicalCompany(v.company), v.title, loc,
       Number.isFinite(ms) ? new Date(ms).toISOString() : 'ats-date-unparseable',
       v.ats.url, 'linkedin-email'].join('\t') + '\n');
    w++;
  }
  for (const g of gated) console.log(`  gated: ${g}`);
  console.log(`wrote ${w} verified req(s) → _web-roles.tsv (${gated.length} gated)`);
  console.log(`\nwrote: ${q} new employer(s) → _discovered-companies.tsv, ${contacts.length} contact(s) → _inbound-recruiters.tsv`);
} else {
  console.log('\n(dry run — pass --write to persist)');
}
}
