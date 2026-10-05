/**
 * tracker-core.mjs — shared parsing helpers for data/applications.md.
 *
 * applications.md column order (per CLAUDE.md, score BEFORE status):
 *   | # | date | company | role | score | status | pdf | report | notes |
 *
 * After `line.split('|').map(s => s.trim())`, index 0 is the empty cell from the
 * leading pipe, so the named fields live at indices 1..9. These helpers reproduce
 * the EXACT semantics the consumer scripts relied on inline (same trimming, same
 * `parts.length < 9` guard, same `parseInt` num gate). They do NOT transform the
 * score/status cells — callers that need normalization apply their own.
 *
 * Note: this is the applications.md row shape only. The TSV tracker-additions
 * (status BEFORE score) and build-catalog's TSV-or-pipe variant are intentionally
 * NOT handled here.
 */

/**
 * Parse one markdown table line from applications.md into a row object, or null
 * if the line is not a data row (header/separator/short row/non-numeric num).
 * Set opts.raw to also attach the original line as `.raw`.
 */
export function parseAppLine(line, opts = {}) {
  if (!line.startsWith('|')) return null;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  const row = {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
  };
  if (opts.raw) row.raw = line;
  return row;
}

/**
 * Parse the full applications.md text into an array of row objects.
 * Pass opts.raw to attach `.raw` to each row.
 */
export function parseApplications(mdText, opts = {}) {
  const rows = [];
  for (const line of String(mdText || '').split('\n')) {
    const row = parseAppLine(line, opts);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Normalize a score cell to a number: strip markdown bold, take the first
 * numeric run. Returns 0 when no number is present.
 * Matches the identical `parseScore` used by dedup-tracker and merge-tracker.
 */
export function parseScore(cell) {
  const m = String(cell ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Extract the link target from a markdown link cell like `[12](reports/...)`.
 * Returns the path string, or null when the cell has no `](...)` link.
 * Matches the `/\]\(([^)]+)\)/` extraction used by analyze-patterns,
 * followup-cadence, and verify-pipeline.
 */
export function extractReportLink(cell) {
  const m = String(cell ?? '').match(/\]\(([^)]+)\)/);
  return m ? m[1] : null;
}
