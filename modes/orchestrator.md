# Mode: orchestrator — Discovery Orchestrator + Real-Time Job Search

> Interactive only: no scheduled lane runs this mode.

The scaled version of `discover`: launch a swarm of WebSearch discovery agents to find companies in the configured area, grow
the index, sweep their career pages (zero-token ATS APIs + a browser tail), score ≥ qualify_score, and iterate until a fresh
qualifier is found.

## Constraint (by design — not a limitation to fight)
Subagents can NOT drive the browser MCP. So: discovery agents crawl via **WebSearch/WebFetch** (not Chrome); the
**zero-token ATS sweep** does the career-page job search for the bulk; **real Chrome (main session only)** handles
the tail — LinkedIn (login) + non-ATS custom career pages.

## Per orchestrated pass
1. **Assign slices** (no overlap) from §Slice catalog. Default 6–8; rotate slices each pass so new ground is covered.
2. **Fan out** N background `Agent`s (a cheaper worker model). Each: find NEW companies in the configured area in its slice with a public
   ATS board (greenhouse/ashby/lever), VERIFY the slug resolves (≥1 open job via the board API), dedup vs
   `data/company-index.tsv` (column 3), write `company<TAB>careers_url` to its OWN `data/_orch-{n}.tsv`.
3. **Merge:** `cat data/_orch-*.tsv >> data/_discovered-companies.tsv` →
   `node scripts/discover-companies.mjs --from data/_discovered-companies.tsv`; then remove `data/_orch-*.tsv`.
4. **Sweep:** `node scripts/scan-index.mjs --days 1 --out data/_candidates.tsv --browser-queue data/_browser-queue.tsv`.
5. **Browser tail (main session):** drain `_browser-queue.tsv` (non-ATS pages) + LinkedIn past-24h via
   chrome-devtools / playwright-stealth for fresh roles the APIs miss.
6. **Score** candidates with the `offer` rubric (verify ≤24h, keep ≥ qualify_score) → `qualifiers.tsv` AND
   `scored-jobs.tsv` with a precise `found_at` via `record-scored.mjs` (dashboard reads scored-jobs, not
   qualifiers — finding 2026-06-16) → `node scripts/prune-qualifiers.mjs` → `node scripts/reconcile-qualifiers.mjs`
   (sync the two ledgers: drop snippet false positives < qualify_score canonically, backfill orphan `found_at`) →
   `node scripts/feedback-outcomes.mjs --learn`.
7. **Iterate** (cap 3 passes): if 0 new qualifiers, rotate to fresh slices + widen titles → window; bank a learning
   to `modes/scan-web.md`.

## Slice catalog (rotate)
- **Industry:** the industries that hire `targets.roles` (list them in `modes/_profile.md` → Scoring Notes); split into 4-6 non-overlapping slices
- **Geo:** `location.city` / `location.cities[]` / sub-regions of `location.metro`, one slice each
- **VC portfolio:** a16z · Sequoia · Greylock · Accel · Index · Khosla · Founders Fund · Lightspeed
- **YC:** by batch (W/S × 2021–2026)
- **ATS host:** `site:` greenhouse | ashby | lever | smartrecruiters | workable
- **Directory:** Built In (your metro) · Levels.fyi · Wellfound · workatastartup

## Cadence (real-time ≈ frequent passes)
Autonomous zero-token core in the scheduled daily run (`morning.mjs`, once each morning, local time). Browser tail via an in-session
`/loop`. A newly-found company's board is swept immediately on merge.

## Cost (honest)
Each agent is a full Claude session (WebSearch-heavy). Default cap **8 agents × 3 passes** per run; stop at target
or cap and report. The ATS sweep + zero-token core are free.

## Outreach on qualify (eligible, not owed)
A job at or above `pipeline.qualify_score` is **eligible** for outreach, not owed. Do not draft outreach
from this mode, interactive or headless. The user picks jobs with `w` on the dashboard or
`node scripts/outreach-queue.mjs add`; drafting stays draft-only and sending is always the user's call.
`node scripts/outreach-owed.mjs` is a read-only "awaiting" view. Policy: `modes/_profile.md` -> "Outreach on qualify".
