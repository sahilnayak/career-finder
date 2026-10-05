# Mode: scan-index — Zero-Token Company-Index Sweep

Sweeps the growing company index (`data/company-index.tsv`) via ATS APIs (zero token), filters to
the `targets.roles` title family + the configured `location` / `remote_policy` + recency, dedups against history, and emits
fresh candidates for the `offer` scoring loop. Pairs with `scan-web` (browser comb + discovery).

## Commands
- **Grow the index:** `node scripts/build-company-index.mjs [--dry-run]` — seeds/grows `company-index.tsv` from
  `scan-history.tsv` ATS boards + a curated list; idempotent (append new, skip existing).
- **Sweep:** `node scripts/scan-index.mjs [--days N] [--dry-run]` — default `--days 1` (today, local time); use 2–3
  for a 48–72h window. Parallel, zero-token.
- Both reuse `scripts/scan-core.mjs` (`detectApi`, `PARSERS`, `buildTitleFilter`, `buildLocationFilter`,
  `loadSeenUrls`, recency). `scan.mjs` is unchanged.

## Workflow
1. `build-company-index.mjs` → grow `company-index.tsv` (`company, careers_url, ats_type, ats_api_url, last_scanned, last_status`).
2. `scan-index.mjs --days N` → ranked fresh candidates (company | title | location | posted | url).
3. Pre-filter (scan-web learnings) → score with `offer` (≥ qualify_score) → keep qualifiers → target N.
4. When short: grow the index (add sources) and re-sweep — coverage compounds each run.

**Timestamp + ledger rule (finding 2026-06-16):** for every candidate you score, record it in
`data/scored-jobs.tsv` with a precise `found_at` via `node scripts/record-scored.mjs <date> <company> <role>
<score> <verdict> <why> <url>` — not just `qualifiers.tsv`. The dashboard's Found panel reads `scored-jobs.tsv`,
so a qualifier with no timestamped scored-jobs row is invisible there. This snippet/index scan scores from the
ATS card; treat that score as provisional — `reconcile-qualifiers.mjs` (in the pipeline) drops any qualifier the
later canonical-JD re-score put < qualify_score and backfills `found_at` for orphans, keeping the two ledgers in sync.

## Optimization (the point of this mode)
- ATS API (zero token, exact post dates) for the indexed bulk; reserve the browser (`scan-web`) for non-ATS
  career pages and for discovering new companies to index.
- Dedups vs `scan-history.tsv` / `pipeline.md` / `applications.md` so seen roles are never rescored.
- "any seniority": title filter drops Junior/Intern/Entry/Associate negatives, keeps wrong-role/stack negatives.

## Growing the index ("keep adding to it")
`scan-index.mjs` stamps `last_scanned`/`last_status` per company each run. Expand coverage by adding sources to
`build-company-index.mjs` (YC directory, Built In (your metro), Levels.fyi, VC portfolios) and by appending companies
discovered during `scan-web` browser combs.

## Auto-outreach on qualify (UNSKIPPABLE)
After this run updates `qualifiers.tsv`, run `node scripts/outreach-owed.mjs`. For every ≥ qualify_score job it lists,
run the `outreach` flow (JD-anchored gold/silver/bronze, draft-only, log `pending`). Never skip. If the
logged-in browser isn't available for contact discovery, the job stays "owed" and is drained next browser
session. Policy: `modes/_profile.md` → "Auto-outreach on qualify". Sending stays gated on user review.
