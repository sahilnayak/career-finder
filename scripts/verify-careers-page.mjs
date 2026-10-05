#!/usr/bin/env node

/**
 * verify-careers-page.mjs — read a job posting from the EMPLOYER'S OWN page, in a real browser.
 *
 * WHY THIS EXISTS (2026-08-20). Tier-3 (linkedin-applyurl.mjs) resolves the canonical apply
 * URL for employers whose board cannot be guessed — but for families we cannot query as an
 * API (Google, Jacobs, NetApp's Phenom redirect, …) the crawl then threw that URL away and
 * logged "family not queryable". That was giving up one step from the answer: we were holding
 * the exact link and never opening it.
 *
 * These are ordinary employer career sites, NOT linkedin.com — no LinkedIn budget, no stealth
 * rules, no account risk. They do often bot-wall plain fetch (careers.jacobs.com answers curl
 * with HTTP 202 and zero bytes) which is precisely why this drives the real browser over CDP.
 *
 * TWO EXTRACTION PATHS, best first:
 *  1. schema.org JobPosting JSON-LD. Machine-readable and exact: `datePosted`, `jobLocation`,
 *     `jobLocationType` ("TELECOMMUTE" = remote), `title`. Workday emits it; it can prove a
 *     req LinkedIn labelled with one city is actually in another office, and how old it is.
 *  2. Rendered-text heuristics, for pages with no JSON-LD (careers.jacobs.com has none). Reads
 *     the labelled fields these templates use — "Location", "Office Setup", "Posted".
 *
 * Freshness is only ever reported when the page actually states it. A page that proves no date
 * returns datePosted:null and the caller must treat that as unverified, never as fresh.
 *
 * Usage:
 *   node scripts/verify-careers-page.mjs --url "https://careers.jacobs.com/..."
 *   node scripts/verify-careers-page.mjs --url "..." --json
 */

import { cdpAlive, newPage } from './cdp.mjs';

/** Workday apply URLs carry the tenant + site, which is all its public JSON API needs. */
export function workdayApiFromUrl(url) {
  // https://{tenant}.wdN.myworkdayjobs.com/{site}/job/{loc}/{slug}_{JR}
  const m = String(url || '').match(/^https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (!m) return null;
  const [, tenant, wd, site] = m;
  return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
}

const IN_PAGE = () => {
  const out = { source: null, title: null, datePosted: null, location: null, remoteFlag: null, employmentType: null, textLen: 0 };

  // ── 1. schema.org JobPosting ──
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
  for (const b of blocks) {
    let j; try { j = JSON.parse(b.textContent); } catch { continue; }
    const arr = Array.isArray(j) ? j : (j['@graph'] || [j]);
    for (const o of arr) {
      if (!o || !/JobPosting/i.test(String(o['@type'] || ''))) continue;
      out.source = 'json-ld';
      out.title = o.title || out.title;
      out.datePosted = o.datePosted || null;
      out.employmentType = o.employmentType || null;
      out.remoteFlag = o.jobLocationType || null;
      const locs = [].concat(o.jobLocation || []);
      const names = locs.map(L => {
        const a = L && L.address || {};
        return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
      }).filter(Boolean);
      if (names.length) out.location = names.join(' | ');
    }
  }

  // ── 2. rendered-text fallback ──
  const text = document.body ? document.body.innerText : '';
  out.textLen = text.length;
  const line = (label) => {
    // "Location\nChicago, IL ..." or "Location: Chicago, IL ..."
    const re = new RegExp(`^\\s*${label}\\s*:?\\s*$\\n\\s*(.+)$|^\\s*${label}\\s*:\\s*(.+)$`, 'im');
    const m = text.match(re);
    return m ? (m[1] || m[2] || '').trim() : null;
  };
  if (!out.title) {
    // The first <h1> is often the site brand, not the req (careers.jacobs.com's h1 is
    // literally "Jacobs"). Prefer the <title>'s leading segment, which these templates set to
    // the job title ("Project Engineer - Chicago... - 43972 - Jacobs"), and fall back
    // to an h1 only when it is not just the brand echoed from the URL host.
    const host = location.hostname.replace(/^(www|careers|jobs|apply)\./, '').split('.')[0];
    // Strip site chrome these templates append: a trailing " — Google Careers", a requisition
    // number in parentheses, a leading "Job Detail". Left in, they reach the scorer as part of
    // the title ("… — Google Careers") and corrupt dedup against the same req from another lane.
    const clean = (s) => String(s || '')
      // Trailing site chrome: "… — Google Careers", "… | Careers", "… - Jobs at Acme".
      // The brand often sits BETWEEN the separator and the word, so match anywhere in the
      // final segment rather than immediately after the dash.
      .replace(/\s*[-–—|]\s*[^-–—|]*\b(careers?|jobs?|talent|hiring)\b[^-–—|]*$/i, '')
      .replace(/\s*\(\d{4,}\)\s*$/, '')
      .replace(/^\s*job detail\s*[:-]?\s*/i, '')
      .trim();
    const seg = clean((document.title || '').split(/\s+[-|–]\s+/)[0]);
    const h1s = [...document.querySelectorAll('h1')].map(h => clean(h.innerText)).filter(Boolean);
    const brandish = (t) => !t || t.length <= 3 || t.toLowerCase() === host.toLowerCase()
      || t.toLowerCase().includes(host.toLowerCase()) && t.split(/\s+/).length <= 2;
    const goodH1 = h1s.find(t => !brandish(t));
    out.title = !brandish(seg) ? seg : (goodH1 || null);
  }
  if (!out.location) out.location = line('Location') || line('Locations') || line('Job Location');
  const setup = line('Office Setup') || line('Work Setup') || line('Workplace Type') || line('Work Type');
  if (setup) out.remoteFlag = out.remoteFlag || setup;
  if (!out.datePosted) {
    const p = text.match(/\bPosted\s+(Today|Yesterday|\d+\+?\s*(?:Day|Days|Week|Weeks|Month|Months)\s+Ago)\b/i)
           || text.match(/\bPosted(?:\s+on)?\s*:?\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/);
    if (p) out.datePosted = p[1];
  }
  // Remote wording anywhere in the body is a strong signal even without a labelled field.
  if (!out.remoteFlag && /\bfully remote\b|\bremote (?:role|position)\b|\bremote in the united states\b/i.test(text)) {
    out.remoteFlag = 'remote (from body text)';
  }
  if (out.source !== 'json-ld') out.source = 'rendered-text';
  return out;
};

/**
 * Load one posting and read it. Returns null when the browser is unavailable or the page
 * cannot be loaded — never a fabricated result.
 */
export async function verifyCareersPage(url, { waitMs = 7000, page = null } = {}) {
  const own = !page;
  if (own && !(await cdpAlive())) return null;
  const p = page || await newPage();
  try {
    const nav = await p.navigate(url, { waitMs });
    const data = await p.evaluate(IN_PAGE);
    return { url, httpStatus: nav.status, finalUrl: nav.url, ...data };
  } catch (e) {
    return { url, error: e.message };
  } finally { if (own) await p.close(); }
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--url');
  const url = i > -1 ? process.argv[i + 1] : null;
  if (!url) { console.error('usage: verify-careers-page.mjs --url <posting url> [--json]'); process.exit(2); }
  const r = await verifyCareersPage(url);
  if (!r) { console.error('no debug Chrome on :9222 — run `node scripts/chrome-debug.mjs start`'); process.exit(1); }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
  console.log(`url        : ${r.finalUrl || r.url}`);
  console.log(`http       : ${r.httpStatus}`);
  console.log(`source     : ${r.source}`);
  console.log(`title      : ${r.title}`);
  console.log(`location   : ${r.location}`);
  console.log(`remote     : ${r.remoteFlag ?? '(not stated)'}`);
  console.log(`datePosted : ${r.datePosted ?? '(not stated — treat as UNVERIFIED, not fresh)'}`);
  const wd = workdayApiFromUrl(r.finalUrl || r.url);
  if (wd) console.log(`workday API: ${wd}   ← indexable, no browser needed next time`);
}
