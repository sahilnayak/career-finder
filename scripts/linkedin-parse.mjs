#!/usr/bin/env node

/**
 * linkedin-parse.mjs — turn the LinkedIn job-search results pane's innerText into cards.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. This logic used to live inside a `page.evaluate()`
 * closure in linkedin-crawl.mjs, which meant it could only ever run inside a live browser
 * against a logged-in LinkedIn session. It was therefore untestable, and a parser bug sat
 * there undetected for months: the slice ANCHOR ("How promoted jobs are ranked") survived
 * the slice and became the FIRST card's title, shifting the real title into the company
 * field and destroying one card on every page. Under `sortBy=DD` that is the freshest
 * listing on the page — the single most valuable row in a speed-to-lead pipeline.
 *
 * Now the page does only what a page must (scroll, hand back innerText) and all parsing
 * happens in Node, where scripts/test-linkedin-parse.mjs can assert against fixtures with
 * no browser, no network and no LinkedIn budget.
 *
 * DOM NOTE. LinkedIn ships obfuscated hashed class names and almost no `/jobs/view/`
 * anchors in the results list, so class/anchor selectors return zero. Text is all there is.
 */

export const ANCHOR = 'How promoted jobs are ranked';

// Card chrome that must never be mistaken for a title, company or location.
const NOISE = /^(Verified job|Easy Apply|·|Viewed|Promoted|Be an early applicant|You.d be a top applicant|Actively reviewing applicants|\d+ (connection|benefit|applicant))/i;
// Chrome that is only noise when it is the WHOLE line. Anchored at both ends on purpose:
// an unanchored /^Apply/ would eat the real title "Applied AI Engineer".
//
// The bare "Apply" line is the one that mattered (found 2026-08-20 via the new per-card
// reject log). A PROMOTED card carries no "Posted N ago" line, so its trailing "Apply"
// survived into the NEXT card's buffer and became that card's title — shifting company into
// title and title into company. Several real local reqs were logged as
// "title-not-on-archetype" with the literal title "Apply".
// Same class of bug as BARE_AGE below, different chrome line.
const NOISE_EXACT = /^(Apply|Saved|Save|Responses managed off LinkedIn|Medical benefit|Medical|401\(k\)|\d+ school alumni|Hybrid|On-site|Remote)$/i;
// Each card ends with TWO age lines ("Posted 8 hours ago", then a bare "8 hours ago"). The
// bare one falls into the NEXT card's buffer and became its title, shifting every field by
// one and zeroing the prefilter.
const BARE_AGE = /^(now|\d+\s*(minute|hour|day|week|month)s?\s*ago)$/i;
const POSTED = /^Posted .+ ago$|^Posted now$/;

/**
 * @param {string} innerText  document.body.innerText of a results page
 * @returns {{title:string, company:string, loc:string, age:string}[]}
 */
export function parseCards(innerText) {
  const txt = String(innerText || '');
  const at = txt.indexOf(ANCHOR);
  const lines = txt.slice(at > -1 ? at : 0).split('\n').map(s => s.trim()).filter(Boolean);

  const out = [];
  let buf = [];
  for (const l of lines) {
    if (POSTED.test(l)) {
      const clean = buf.filter(s =>
        s !== ANCHOR &&              // the fix: the anchor is not a job title
        !NOISE.test(s) &&
        !NOISE_EXACT.test(s) &&
        !BARE_AGE.test(s) &&
        !/^\$/.test(s));
      if (clean.length >= 2) {
        const title = clean[0].replace(/\s*\(Verified job\)$/, '').trim();
        const rest = clean.slice(1).filter(s => s !== title);
        const loc = rest.find(s => /,\s*[A-Z]{2}\b|Metropolitan Area|\bArea$|United States|\b(Remote|Hybrid|On-site)\b/.test(s)) || '';
        const company = rest.find(s => s !== loc && !/\$/.test(s)) || '';
        if (title && company) out.push({ title, company, loc, age: l.replace(/^Posted /, '') });
      }
      buf = [];
      continue;
    }
    buf.push(l);
    if (buf.length > 12) buf.shift();
  }
  return out;
}

/**
 * The browser-side half: scroll to force lazy-load, then hand back the text. Deliberately
 * contains NO parsing — everything it returns is testable in Node.
 * Serialised into the page by cdp.mjs `evaluate`, so it must be self-contained.
 */
export const SCROLL_AND_READ = async () => {
  for (let i = 0; i < 6; i++) {
    window.scrollBy(0, 900);
    const pane = document.querySelector('.jobs-search-results-list, .scaffold-layout__list');
    if (pane) pane.scrollTop += 900;
    await new Promise(r => setTimeout(r, 700));
  }
  return document.body.innerText;
};

/**
 * Offline fixture support: turn a saved results page (HTML, or a plain innerText dump) into the
 * same newline-per-block text the browser's innerText returns. Block-level tags become line
 * breaks, everything else is stripped, entities are decoded. A file with no `<` is returned as-is.
 */
export function htmlToText(src) {
  const s = String(src || '');
  if (!/<[a-z!/]/i.test(s)) return s;
  return s
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(div|p|li|ul|ol|h[1-6]|section|article|header|footer|main|tr|td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&middot;/g, '·')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ── Cross-process dedup helpers (linkedin-jobsearch.mjs) ─────────────────────────────────────
// morning.mjs runs the faceted and semantic forms as SEPARATE processes, so an in-memory Set
// cannot stop the second one re-appending what the first already wrote. Dedup reads the file.

/** Normalised title for matching: case, punctuation and the "(Verified job)" suffix dropped. */
export function normTitle(t) {
  return String(t || '').toLowerCase().replace(/\(verified job\)/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** company + normalised title — the identity a nomination is deduped on. */
export const roleKey = (company, title) => `${String(company || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${normTitle(title)}`;
/** LinkedIn job id from any /jobs/view/<id> or currentJobId=<id> URL, else ''. */
export function jobIdFromUrl(url) {
  const m = String(url || '').match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})|[?&]currentJobId=(\d{6,})/);
  return m ? (m[1] || m[2]) : '';
}
/** The canonical nomination URL for a card: /jobs/view/<id> when the card carries an id. */
export const jobViewUrl = (id) => `https://www.linkedin.com/jobs/view/${id}/`;

/**
 * Keys already present in data/_web-roles.tsv (7 cols: date, company, role, location, posted,
 * url, source). Returns { keys: Set<roleKey>, ids: Set<jobId> }.
 */
export function existingWebRoleKeys(tsvText) {
  const keys = new Set(); const ids = new Set();
  for (const line of String(tsvText || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f[1] === 'company' && f[2] === 'role') continue;   // header
    if (f[1] && f[2]) keys.add(roleKey(f[1], f[2]));
    const id = jobIdFromUrl(f[5]);
    if (id) ids.add(id);
  }
  return { keys, ids };
}

/** Job links in saved HTML: [{id, text}] from <a href=".../jobs/view/<id>...">text</a>. */
export function extractJobLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']*(?:\/jobs\/view\/|currentJobId=)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const id = jobIdFromUrl(m[1]);
    if (id) out.push({ id, text: m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** Give each card the id of the job link whose text matches its title (first match wins). */
export function attachJobIds(cards, links) {
  const ls = (links || []).map((l) => ({ id: String(l.id), t: normTitle(l.text) })).filter((l) => l.id && l.t);
  const used = new Set();
  return cards.map((c) => {
    if (c.id) return c;
    const t = normTitle(c.title);
    const hit = t && ls.find((l) => !used.has(l.id) && (l.t === t || l.t.startsWith(t) || l.t.includes(t)));
    if (!hit) return c;
    used.add(hit.id);
    return { ...c, id: hit.id };
  });
}
