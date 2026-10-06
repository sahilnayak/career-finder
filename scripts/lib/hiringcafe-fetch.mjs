/**
 * hiringcafe-fetch.mjs — the pure decisions behind the HiringCafe lane (no network, no profile).
 * Lives apart from hiringcafe-scan.mjs because that script runs its sweep at import time, so
 * nothing in it can be unit-tested.
 *
 *   chooseTransport()   browser-first: the dedicated Chrome (:9222) when it is alive, else plain GET
 *   parseNextData()     read __NEXT_DATA__ out of a page, or say why it is missing
 *   collectPages()      page one query; a MISSING __NEXT_DATA__ on a later page is logged and that
 *                       page skipped, never a failed query
 *   skipReason()        the one-line reason printed when Cloudflare blocks and no Chrome is there
 *
 * Why browser-first: as of 2026-10-06 the plain GET is a Cloudflare 403 on every request, so the
 * "try plain, then browser" order only added one wasted round trip per page. The cheap path still
 * runs when no Chrome is up, and resumes working for free the day Cloudflare relaxes.
 */

export const NO_CHROME_REASON =
  'hiringcafe: Cloudflare 403 and no Chrome; run npm run linkedin:login to start the browser profile';
export const NO_BROWSER_FLAG_REASON =
  'hiringcafe: Cloudflare 403 and the browser is disabled (--no-browser / CAREER_FINDER_NO_BROWSER=1)';
/** Exit code for "lane skipped with a reason" (not a failure of a query, not a success either). */
export const EXIT_SKIPPED = 4;

/**
 * @param {{noBrowser?: boolean, alive?: () => Promise<boolean>|boolean}} o
 * @returns {Promise<{first: 'browser'|'plain', browser: boolean, why: string}>}
 */
export async function chooseTransport({ noBrowser = false, alive } = {}) {
  if (noBrowser) return { first: 'plain', browser: false, why: 'browser disabled by flag' };
  let up = false;
  try { up = !!(await alive?.()); } catch { up = false; }
  return up
    ? { first: 'browser', browser: true, why: 'debug Chrome alive on the CDP port' }
    : { first: 'plain', browser: false, why: 'no debug Chrome on the CDP port' };
}

/** The reason line for a Cloudflare block that no transport can get past. */
export function skipReason({ noBrowser = false } = {}) {
  return noBrowser ? NO_BROWSER_FLAG_REASON : NO_CHROME_REASON;
}

/** @returns {{ok: true, pageProps: object} | {ok: false, reason: 'no-next-data'|'bad-json'}} */
export function parseNextData(html) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, reason: 'no-next-data' };
  try { return { ok: true, pageProps: JSON.parse(m[1]).props.pageProps }; }
  catch { return { ok: false, reason: 'bad-json' }; }
}

/**
 * Page one query. `fetchPage(page)` resolves to {hits, last, total} or throws. An error flagged
 * `noNextData` on a page after the first is logged and that page skipped (the query keeps the hits
 * it already has and moves to the next page); on page 0 it propagates, because a first page with
 * no SSR payload means the contract changed, and a silent zero is how lanes die unnoticed.
 *
 * @returns {Promise<{hits: any[], total: number|null, truncated: boolean, skippedPages: number[]}>}
 */
export async function collectPages(fetchPage, { maxPages = 5, sleep = async () => {}, jitter = () => 0, log = () => {} } = {}) {
  const hits = [];
  const skippedPages = [];
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(jitter());
    let r;
    try { r = await fetchPage(page); }
    catch (e) {
      if (page > 0 && e?.noNextData) {
        skippedPages.push(page);
        log(`page ${page} has no __NEXT_DATA__; skipping that page, keeping ${hits.length} hit(s) so far`);
        if (page === maxPages - 1) truncated = true;
        continue;
      }
      throw e;
    }
    hits.push(...r.hits);
    if (r.last || r.hits.length === 0) return { hits, total: r.total, truncated: false, skippedPages };
    if (page === maxPages - 1) truncated = true;
  }
  return { hits, total: null, truncated, skippedPages };
}
