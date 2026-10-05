#!/usr/bin/env node

/**
 * linkedin-applyurl.mjs — resolve a LinkedIn card to the employer's CANONICAL ATS req.
 *
 * WHY THIS EXISTS. The single biggest leak in the LinkedIn lane is "no public ATS board":
 * 15 of 55 rejects on 2026-08-20, and 85% of all rejects historically. linkedin-crawl.mjs
 * resolves a board by GUESSING slugs from the company's display name, so any employer whose
 * board name differs from its brand is unreachable by construction.
 *
 * The proof case, caught live 2026-08-20: LinkedIn card reads company "Fin". The crawl guessed
 * an Ashby board named `fin`, landed on an unrelated company's 8-job board, found no title
 * match and rejected the req. The real board is `job-boards.greenhouse.io/intercom` — Fin is
 * Intercom's product. No amount of slug-guessing from "Fin" reaches "intercom".
 *
 * LinkedIn already knows the answer. The Apply button on a job page is a plain anchor whose
 * href is the employer's own apply URL, wrapped in a /safety/go/ redirect:
 *
 *   aria-label="Apply on company website"
 *   href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjob-boards%2Egreenhouse%2Eio
 *         %2Fintercom%2Fjobs%2F8123007%3Fgh_src%3Dm3lq2e1&urlhash=LdL2"
 *
 * No click required — reading the href is enough.
 *
 * TWO MEASURED CONSTRAINTS shape the design (both verified 2026-08-20, do not re-litigate
 * without re-testing):
 *
 *  1. The RESULTS LIST exposes no per-card job IDs. On a 25-card page there was exactly ONE
 *     `/jobs/view/` anchor (the auto-selected card) and zero `data-occludable-job-id`,
 *     `data-job-id` or `data-entity-urn` attributes. You cannot address a card you cannot
 *     name, so "open every card" is impossible without synthesising real mouse events —
 *     precisely the behaviour LinkedIn's automation detection is tuned for. IDs come from the
 *     logged-out guest API instead, which hands them over freely.
 *
 *  2. The LOGGED-OUT job page does NOT carry the apply URL. It returns 200 with the full JD
 *     text but gates the button behind "Join or sign in to find your next job" — no
 *     `companyApplyUrl`, no `/safety/go/` anchor anywhere in 349KB of HTML. So the href read
 *     must happen in the warm logged-in profile, and it costs `jobsearch` budget per job.
 *
 * Therefore this module is deliberately NOT run over every card. The caller runs it only on
 * cards that already failed ATS resolution (~15-20/day against a 1000/day jobsearch cap).
 */

import { newPage } from './cdp.mjs';
import { liGeoParam } from './li-geo.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Pull job IDs from the LOGGED-OUT guest API. Free: no account action, no `jobsearch` spend,
 * no cookie. Returns 10 cards per request; `start` pages through.
 *
 * The guest feed is a strict SUBSET of the logged-in result set (that gap is exactly why
 * linkedin-crawl.mjs exists), so this is used only to ATTACH IDs to cards the logged-in crawl
 * already found — never as a discovery lane of its own.
 */
export async function guestJobIds({ keywords, geoId = '', hours = 24, pages = 4 } = {}) {
  const geo = liGeoParam(geoId);   // explicit geoId, else location.linkedin_geo_id, else free text
  const map = new Map();          // norm(company)|norm(title) -> jobId
  for (let pg = 0; pg < pages; pg++) {
    const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
      + `?keywords=${encodeURIComponent(keywords)}&f_TPR=r${hours * 3600}`
      + `${geo ? `&${geo}` : ''}&start=${pg * 10}`;
    let html;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) break;                     // 429 included: stop, never retry a throttle
      html = await r.text();
    } catch { break; }
    if (!html || html.length < 200) break;

    // Each card is a <li> carrying the urn plus visible title/company text.
    const chunks = html.split(/<li[\s>]/).slice(1);
    let added = 0;
    for (const c of chunks) {
      const idm = c.match(/urn:li:jobPosting:(\d+)/) || c.match(/jobs\/view\/[^"'\/]*-(\d{8,})/);
      if (!idm) continue;
      const tm = c.match(/<h3[^>]*job-search-card__title[^>]*>([\s\S]*?)<\/h3>/)
              || c.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      const cm = c.match(/<h4[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)
              || c.match(/<h4[^>]*>([\s\S]*?)<\/h4>/);
      const strip = (x) => String(x || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      const title = strip(tm && tm[1]), company = strip(cm && cm[1]);
      if (!title || !company) continue;
      const k = `${norm(company)}|${norm(title)}`;
      if (!map.has(k)) { map.set(k, { id: idm[1], title, company }); added++; }
    }
    if (!added) break;                       // exhausted
    await sleep(400 + Math.random() * 500);  // polite, even logged-out
  }
  return map;
}

/**
 * TARGETED guest lookup for ONE employer's req.
 *
 * WHY (2026-08-20). Tier-3 rescue rescued 0 of 15 unresolvable employers because it looked
 * every card up in a map built from BROAD keyword sweeps — and the logged-out guest index is
 * a documented subset of the logged-in one (measured: a handful of cards vs 99+). The
 * employers Tier-3 exists to rescue are exactly the ones a generic sweep is least likely to
 * surface, so the map almost never held them.
 *
 * Searching for the company and title directly is a far smaller haystack: one guest request
 * scoped to that employer instead of a scan of everything. Falls back to a company-only
 * search and fuzzy-matches the title, because LinkedIn's card title and the query rarely
 * match character-for-character.
 *
 * Costs one `guest` action (off-account, IP-bounded) per call — never a logged-in action.
 */
export async function guestJobIdFor(company, title, { geoId = '', hours = 24 } = {}) {
  const want = norm(title);
  const wantWords = want.split(/\s+/).filter(w => w.length > 3);
  for (const q of [`${company} ${title}`, company]) {
    let map;
    try { map = await guestJobIds({ keywords: q, geoId, hours, pages: 1 }); }
    catch { continue; }
    if (!map?.size) continue;
    const exact = map.get(`${norm(company)}|${want}`);
    if (exact) return exact;
    // Fuzzy: same employer, best title overlap. Symmetric Jaccard, same shape the ATS
    // matcher uses, so a sibling req cannot masquerade as the one we asked for.
    let best = null, bestScore = 0;
    for (const [k, v] of map) {
      if (!k.startsWith(`${norm(company)}|`)) continue;
      const tw = norm(v.title).split(/\s+/).filter(w => w.length > 3);
      const inter = wantWords.filter(w => tw.includes(w)).length;
      const union = new Set([...wantWords, ...tw]).size || 1;
      const s = inter / union;
      if (s > bestScore) { bestScore = s; best = v; }
    }
    if (best && bestScore >= 0.45) return best;
  }
  return null;
}

/**
 * Turn an employer apply URL into something the ATS layer can query directly.
 *
 * This is strictly better than board-wide fuzzy title matching: it names the EXACT req, so
 * the sibling-collision problem (the Paris vs local copy of one title) and
 * the wrong-board problem (Fin -> some other company's `fin` board) both disappear.
 */
export function parseAtsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase(), path = u.pathname;
  let m;

  if ((m = path.match(/^\/([^/]+)\/jobs\/(\d+)/)) && /greenhouse\.io$/.test(host))
    return { atsType: 'greenhouse', slug: m[1], jobId: m[2],
             apiUrl: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`, url: raw };
  // Embedded Greenhouse: my.greenhouse.io/embed/job_app?for=<slug>&token=<id>
  if (/greenhouse\.io$/.test(host) && u.searchParams.get('for') && u.searchParams.get('token'))
    return { atsType: 'greenhouse', slug: u.searchParams.get('for'), jobId: u.searchParams.get('token'),
             apiUrl: `https://boards-api.greenhouse.io/v1/boards/${u.searchParams.get('for')}/jobs/${u.searchParams.get('token')}`, url: raw };
  if ((m = path.match(/^\/([^/]+)\/([0-9a-f-]{20,})/i)) && /ashbyhq\.com$/.test(host))
    return { atsType: 'ashby', slug: m[1], jobId: m[2],
             apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, url: raw };
  if ((m = path.match(/^\/([^/]+)\/([0-9a-f-]{20,})/i)) && /lever\.co$/.test(host))
    return { atsType: 'lever', slug: m[1], jobId: m[2],
             apiUrl: `https://api.lever.co/v0/postings/${m[1]}/${m[2]}`, url: raw };
  if (/myworkdayjobs\.com$/.test(host))
    return { atsType: 'workday', slug: host.split('.')[0], jobId: null, apiUrl: null, url: raw };
  if (/smartrecruiters\.com$/.test(host))
    return { atsType: 'smartrecruiters', slug: path.split('/')[1] || null, jobId: null, apiUrl: null, url: raw };
  // Unknown family: the URL is still worth keeping — it names the employer's real careers host,
  // which is exactly what the company-index discovery queue needs.
  return { atsType: 'unknown', slug: null, jobId: null, apiUrl: null, url: raw, host };
}

/** Unwrap https://www.linkedin.com/safety/go/?url=<encoded> */
export function unwrapSafety(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    if (/linkedin\.com$/.test(u.hostname) && u.pathname.startsWith('/safety/go')) {
      const t = u.searchParams.get('url');
      return t ? decodeURIComponent(t) : null;
    }
    if (/linkedin\.com$/.test(u.hostname)) return null;   // internal link = Easy Apply
    return u.toString();
  } catch { return null; }
}

/**
 * Read the Apply anchor for ONE job id in the warm logged-in profile.
 * Returns null for Easy Apply (LinkedIn-hosted) and for anything that fails to render.
 *
 * The page is a heavy SPA: measured 2026-08-20, a 5s wait returned an EMPTY body and only a
 * ~14s total settle produced the button. Do not lower these without re-measuring — a short
 * wait fails silently and looks exactly like "no apply link exists".
 */
export async function applyUrlForJob(jobId, { settleMs = 6000 } = {}) {
  const page = await newPage();
  try {
    const nav = await page.navigate(`https://www.linkedin.com/jobs/view/${jobId}/`, { waitMs: 8000 });
    if (nav.status === 999 || nav.status === 429) return { throttled: true };
    if (/\/authwall|\/checkpoint\//.test(nav.url || '')) return { authwall: true };
    await sleep(settleMs);
    const got = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button')]
        .find(e => /^Apply$/i.test((e.innerText || '').trim())
                || /apply on company website/i.test(e.getAttribute('aria-label') || ''));
      const t = document.body.innerText || '';
      return {
        href: btn && btn.tagName === 'A' ? btn.href : null,
        easyApply: /Easy Apply/i.test(t),
        title: (document.querySelector('h1') || {}).innerText || '',
        empty: t.length < 500,
      };
    });
    if (got.empty) return { unrendered: true };
    const target = unwrapSafety(got.href);
    if (!target) return { easyApply: got.easyApply, title: got.title, ats: null };
    return { title: got.title, raw: target, ats: parseAtsUrl(target) };
  } catch (e) {
    return { error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

export const _norm = norm;
