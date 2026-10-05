#!/usr/bin/env node

/**
 * snapshot-jd.mjs — make sure every board-worthy job has a local JD snapshot in data/jds/.
 *
 * WHY. Two separate problems, one fix.
 *
 *  1. THE DASHBOARD SHOWED "not linked". A job could be fully populated — scored, on the board,
 *     outreach drafted — and pressing r still said "no report linked", because the report is OWED
 *     at qualify time, not required. There was no JD concept at all, so there was nothing to fall
 *     back to. The dashboard now resolves data/jds/ (AttachJDPaths) and falls back to it, but that
 *     only helps if the file exists, which is what this script guarantees.
 *
 *  2. THE LIVE POSTING IS NOT A STABLE RECORD. An employer can edit or pull a req after it is
 *     scored. One posting read "(Hybrid)" in the candidate's city when it scored 4.5 at
 *     midday and "(Remote)" three hours later — caught only because a snapshot existed.
 *     Without a snapshot there is no before-record and no way to prove the flip.
 *
 * Idempotent: skips any job that already has a snapshot. Safe to run on every pipeline cycle.
 *
 * Usage:
 *   node scripts/snapshot-jd.mjs                 # snapshot every qualifier missing one
 *   node scripts/snapshot-jd.mjs --min 4.0       # widen to near-misses
 *   node scripts/snapshot-jd.mjs --dry-run
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { parseAtsUrl, applyUrlForJob } from './linkedin-applyurl.mjs';
import { loadTargets } from './targets.mjs';
import { tracked as trackedFetch } from './request-ledger.mjs'; // every outbound request is counted

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const val = (f, d) => { const i = argv.indexOf(f); const n = argv[i + 1]; return i > -1 && n && !n.startsWith('--') ? n : d; };
const MIN = Number(val('--min', (() => { try { return loadTargets().pipeline.qualify_score; } catch { return 4.3; } })()));
const JD_DIR = `${ROOT}data/jds`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const he = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const toText = (html) => he(html)
  .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/\n{3,}/g, '\n\n').trim();

export const htmlToText = (h) => toText(String(h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' '));

/** Read one req out of an ATS API response. */
function pick(atsType, j, a) {
  if (atsType === 'greenhouse')
    return { title: j.title, loc: j.location?.name, pub: j.first_published, upd: j.updated_at, url: j.absolute_url, body: toText(j.content) };
  if (atsType === 'lever')
    return { title: j.text, loc: j.categories?.location, pub: j.createdAt, url: j.hostedUrl, body: toText(j.description || j.descriptionPlain) };
  if (atsType === 'ashby') {
    const h = (j?.jobs || []).find(x => String(x.id) === String(a.jobId) || String(x.jobUrl || '').includes(a.jobId));
    if (!h) return null;
    return { title: h.title, loc: h.location, pub: h.publishedAt, url: h.jobUrl, remote: h.isRemote, body: toText(h.descriptionHtml || h.descriptionPlain) };
  }
  return null;
}

async function viaApi(a) {
  try {
    const r = await trackedFetch(a.apiUrl, { headers: { 'User-Agent': 'career-finder/1.0' } });
    if (!r.ok) return null;
    const got = pick(a.atsType, await r.json(), a);
    return got?.body ? { a, ...got } : null;
  } catch { return null; }
}

/**
 * FALLBACK LADDER — the apply href is a direct link to the job AND its description, so it is the
 * fallback whenever the stored URL is not itself a queryable API (user-set 2026-08-20).
 *
 * Before this, `snapshot-jd` gave up the moment parseAtsUrl produced no apiUrl and logged
 * "board not queryable" — 49 jobs on the first backfill, 26 of them at >= 4.3. But most of those
 * were not unqueryable at all: they were stored as a LinkedIn URL (whose job id resolves straight
 * to the employer's apply href) or as a BOARD ROOT with no job path (queryable by title). Only a
 * genuine in-house careers page needs raw HTML.
 */
export async function fetchPosting(url, role) {
  const a0 = parseAtsUrl(url);

  // 1. The stored URL already names a queryable req.
  if (a0?.apiUrl) {
    const got = await viaApi(a0);
    if (got) return got;
    // The API answered but this req was not on it. That is not "unqueryable" — it means the board
    // is fine and the requisition is CLOSED. Reporting those as the same thing hid real signal.
    if (a0.atsType === 'ashby') {
      try {
        const r = await trackedFetch(a0.apiUrl, { headers: { 'User-Agent': 'career-finder/1.0' } });
        if (r.ok) {
          const n = ((await r.json())?.jobs || []).length;
          if (n > 0) return { closed: true, detail: `req not on the ${a0.slug} board (${n} live jobs) — closed` };
        } else {
          return { unsupported: 'ashby', host: `board ${a0.slug} returned HTTP ${r.status}` };
        }
      } catch { /* fall through */ }
    }
  }

  // 2. LinkedIn URL -> job id -> Apply href -> the employer's real req. This is the tier the user
  //    asked for: LinkedIn stores no JD worth reading, but its Apply button names the ATS exactly.
  const li = String(url).match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{8,})/);
  if (li) {
    const res = await applyUrlForJob(li[1]).catch(() => null);
    if (res?.throttled || res?.authwall) return { throttled: true };
    if (res?.ats?.apiUrl) {
      const got = await viaApi(res.ats);
      if (got) return { ...got, via: 'apply-href' };
    }
    if (res?.raw) {
      const html = await trackedFetch(res.raw, { headers: { 'User-Agent': UA } }).then(r => r.ok ? r.text() : '').catch(() => '');
      const body = htmlToText(html);
      if (body.length > 400) return { a: res.ats || { atsType: 'html', slug: null, jobId: null }, title: res.title || role, url: res.raw, body, via: 'apply-href-html' };
    }
    return { unsupported: 'linkedin', host: 'linkedin.com' };
  }

  // 2b. `gh_jid` on a company's OWN careers page. Very common: a site embeds Greenhouse and passes
  //     the req id in the query string (www.asana.com/jobs/apply/8031595?gh_jid=8031595). The board
  //     slug is not in the URL, but the hostname is a reliable guess. Verified: that Asana URL
  //     resolves against boards/asana and returns 8,004 chars of JD.
  try {
    const u = new URL(url);
    const gh = u.searchParams.get('gh_jid');
    if (gh) {
      const host = u.hostname.replace(/^www\./, '').split('.')[0];
      for (const slug of [...new Set([host, host.replace(/-/g, ''), a0?.slug].filter(Boolean))]) {
        const got = await viaApi({ atsType: 'greenhouse', slug, jobId: gh,
          apiUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${gh}` });
        if (got) return { ...got, via: `gh_jid:${slug}` };
      }
    }
  } catch { /* not a parseable URL */ }

  // 3. Board ROOT with no job path (boards.greenhouse.io/cognition, jobs.ashbyhq.com/commure).
  //    The family is known and the board is queryable — only the req id is missing, so match on title.
  const root = String(url).match(/(greenhouse|ashbyhq|lever)\.(?:io|co)\/([^/?#]+)\/?$/);
  if (root && role) {
    const fam = root[1] === 'ashbyhq' ? 'ashby' : root[1] === 'lever' ? 'lever' : 'greenhouse';
    const listUrl = fam === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${root[2]}/jobs?content=true`
                  : fam === 'ashby' ? `https://api.ashbyhq.com/posting-api/job-board/${root[2]}`
                  : `https://api.lever.co/v0/postings/${root[2]}?mode=json`;
    try {
      const r = await trackedFetch(listUrl, { headers: { 'User-Agent': 'career-finder/1.0' } });
      if (r.ok) {
        const j = await r.json();
        const list = fam === 'lever' ? (Array.isArray(j) ? j : []) : (j.jobs || []);
        const want = String(role).toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 3);
        let best = null, bestScore = 0;
        for (const x of list) {
          const t = String(x.title || x.text || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 3);
          const inter = want.filter(w => t.includes(w)).length;
          const sc = inter / (new Set([...want, ...t]).size || 1);
          if (sc > bestScore) { bestScore = sc; best = x; }
        }
        if (best && bestScore >= 0.45) {
          const got = pick(fam, fam === 'ashby' ? { jobs: [best] } : best, { jobId: best.id, atsType: fam });
          if (got?.body) return { a: { atsType: fam, slug: root[2], jobId: String(best.id) }, ...got, via: 'board-title-match' };
        }
      }
    } catch { /* fall through */ }
  }

  // 4. A real employer careers page: read the HTML directly. Server-rendered pages yield the JD;
  //    JS-only ones (Workday) return chrome and are correctly reported as unfetched.
  if (a0 && a0.atsType !== 'unknown' || /^https?:/.test(url)) {
    try {
      const r = await trackedFetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (r.ok) {
        const body = htmlToText(await r.text());
        if (body.length > 800) return { a: a0 || { atsType: 'html', slug: null, jobId: null }, title: role, url, body, via: 'careers-html' };
      }
    } catch { /* nothing left to try */ }
  }
  return { unsupported: a0?.atsType || 'unknown', host: a0?.host };
}

// Only act as a CLI when executed directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  // ── collect board-worthy jobs ───────────────────────────────────────────────
  const rows = [];
  for (const [file, cols] of [['data/qualifiers.tsv', { co: 1, role: 2, score: 3, url: 5 }],
                              ['data/scored-jobs.tsv', { co: 1, role: 2, score: 3, url: 6 }]]) {
    const p = `${ROOT}${file}`;
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const f = line.split('\t');
      if (f.length <= cols.url) continue;
      const score = parseFloat(f[cols.score]);
      const url = (f[cols.url] || '').trim();
      if (!Number.isFinite(score) || score < MIN || !/^https?:/.test(url)) continue;
      rows.push({ company: f[cols.co].trim(), role: f[cols.role].trim(), score, url });
    }
  }
  // Dedup on the URL — the same req appears in both files.
  const seen = new Set();
  const jobs = rows.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)));

  if (!existsSync(JD_DIR)) mkdirSync(JD_DIR, { recursive: true });
  const have = existsSync(JD_DIR) ? readdirSync(JD_DIR).filter(f => f.endsWith('.md')) : [];

  let wrote = 0, skipped = 0, failed = [];
  for (const j of jobs) {
    // SKIP ON REQUISITION ID, not company+role. Keying the skip on the company-and-title prefix
    // meant a SECOND distinct req at the same employer and title never got its own snapshot —
    // Anthropic runs "Forward Deployed Engineer, Applied AI" (4985877008) and "Forward Deployed
    // Engineer" (5302966008) simultaneously, and only the first was ever captured. Snapshots are
    // per-requisition, exactly as reports are; the harm is asymmetric, so bias to capturing.
    const idHint = parseAtsUrl(j.url)?.jobId;
    const prefix = `${slug(j.company)}-${slug(j.role).split('-').slice(0, 3).join('-')}`;
    if (idHint) {
      if (have.some(f => f.endsWith(`-${idHint}.md`))) { skipped++; continue; }
    } else if (have.some(f => f.startsWith(prefix))) {
      // No parseable req id (LinkedIn URL, careers page). Fall back to the loose check rather than
      // re-fetching the same posting every run.
      skipped++; continue;
    }

    const p = await fetchPosting(j.url, j.role);
    if (p?.throttled) { failed.push(`${j.company}: LinkedIn pushed back — stopping`); break; }
    if (p?.closed) { failed.push(`${j.company}: ${p.detail}`); continue; }
    if (p?.unsupported) { failed.push(`${j.company}: ${p.unsupported} board not queryable${p.host ? ` (${p.host})` : ''}`); continue; }
    if (!p || p.error || !p.body) { failed.push(`${j.company}: ${p?.error || 'no JD recoverable from any tier'}`); continue; }

    const name = `${slug(j.company)}-${slug(p.title || j.role)}-${p.a.jobId || 'na'}.md`;
    const md = `# ${j.company} — ${p.title || j.role}\n\n`
      + `**Req ID:** ${p.a.jobId || 'n/a'}  \n**URL:** ${p.url || j.url}  \n`
      + `**Location:** ${p.loc || 'n/a'}${p.remote === true ? '  ⚠ ATS isRemote=true' : ''}  \n`
      + `**Published:** ${p.pub || 'n/a'}  \n${p.upd ? `**Updated:** ${p.upd}  \n` : ''}`
      + `**Score at snapshot:** ${j.score}  \n**Snapshot taken:** ${new Date().toISOString()}  \n`
      + `**Source:** ${p.a.atsType}${p.via ? ` via ${p.via}` : ' posting API'}${p.a.slug ? ` (board \`${p.a.slug}\`)` : ''}\n\n---\n\n${p.body}\n`;
    if (!DRY) writeFileSync(`${JD_DIR}/${name}`, md);
    have.push(name);
    wrote++;
    console.log(`  + ${name}`);
  }

  console.log(`\nsnapshot-jd: ${wrote} written, ${skipped} already had one, ${failed.length} could not be fetched${DRY ? ' (dry run)' : ''}`);
  for (const f of failed) console.log(`  ! ${f}`);
}
