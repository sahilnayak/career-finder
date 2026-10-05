# Mode: speed — Speed-to-Lead Freshness Monitor (just-posted, ≥ qualify_score only)

> Runs automatically in: speed mode, opt-in (`--with-speed`, 2-4/day). The `/loop` tier and browser supplement are interactive only.

Catches the **most recently posted** matching roles and surfaces only the ≥ qualify_score fits, so you apply first. Runs
in-session via `/loop`, and on a schedule only when opted in (`--with-speed`). ATS-first (exact post times) + browser supplement.

## Per cycle
1. **ATS sweep (exact post times):**
   `node scripts/scan-index.mjs --hours 12 --out data/_candidates.tsv`
   over all indexed companies. Rolling **≤12h** window (tighten to `--hours 6`, loosen to `--hours 24`).
2. **Browser supplement (in-session, attached Chrome):** LinkedIn guest `…&f_TPR=r43200` (12h) across high-signal
   titles (`targets.roles` from config/profile.yml) + Google
   Jobs "past 24h" → fresh roles the ATS APIs miss (LinkedIn-only / non-ATS). Append to candidates.
3. **Dedup** vs `scan-history` / `pipeline` / `applications` / `qualifiers`. The LinkedIn dedup is a
   substring match on company name vs `scored-jobs.tsv`, so **log LinkedIn-sourced companies exactly as
   LinkedIn displays them** (the full legal-style display name, not a shortened one) or the role re-flags
   every cycle. Also verify freshness against the company ATS (`publishedAt`/`updated_at`) — LinkedIn
   "posted today" is routinely a repost of a months-old opening; log those as `stale`, don't score them.
   **LinkedIn's Remote/Hybrid/On-site chip is equally unreliable in BOTH directions.** Never SKIP a
   locally-labeled role on the LinkedIn chip alone: check the official ATS/careers posting (JSON-LD
   `jobLocation` / `jobLocationType`, or remote/hybrid language in the JD body) before rejecting.
   (A chip saying Remote on a posting that is onsite in the ATS is common.)
4. **Score** each fresh candidate with the `offer` rubric; keep only **≥ qualify_score**. Verify exact post age
   (ATS `publishedAt` / LinkedIn `datePosted`).
   **Canonical-JD rule (mandatory, added 2026-06-10):** never qualify from LinkedIn page text. LinkedIn is
   a discovery surface; its rendered description is often truncated and its Apply button links the real ATS
   posting — resolve that URL (Greenhouse/Ashby/Lever/Workday) and score from the canonical JD. (Typical
   failure: a snapshot truncated before the requirements list hides a hard gate such as language
   fluency, and resume + outreach get generated for a non-fit.)
   **Hard-gate checklist (run against the canonical JD before logging any ≥ qualify_score):** language fluency
   requirements; security clearance / citizenship; territory or regional coverage implying language/travel;
   years-of-experience gates; named mandatory technologies ("X experience is mandatory"); certifications;
   visa sponsorship restrictions. Any unmet item = the score caps below qualify_score regardless of archetype fit.
   **Near-miss re-read (mandatory):** any candidate landing **3.8–4.2 on snippet-only evidence** gets a
   full-JD fetch + rescore in the same cycle before being logged as `near`. Snippet scoring systematically
   under-scores roles whose fit is in the requirements list rather than the summary.
5. **Surface + act:** append ≥ qualify_score to `qualifiers.tsv` (with exact ISO `posted`) AND record it in
   `scored-jobs.tsv` with a precise `found_at` via `node scripts/record-scored.mjs <date> <company> <role>
   <score> <verdict> <why> <url>` (found_at defaults to now). **WHY (timestamp finding, 2026-06-16):** the
   dashboard's Found panel reads `scored-jobs.tsv`, NOT `qualifiers.tsv` — a qualifier without a timestamped
   scored-jobs row is invisible on the dashboard. Then `prune-qualifiers.mjs` → `reconcile-qualifiers.mjs`
   (drops snippet false positives the canonical re-score put < qualify_score, backfills `found_at` for any orphan, keeps
   the two ledgers in sync) → `feedback-outcomes.mjs` → show via `qualifiers-view` (newest first). A new ≥ qualify_score is
   **eligible** for outreach, not owed: do not draft from this mode. The user picks with `w` on the dashboard or
   `node scripts/outreach-queue.mjs add`; `node scripts/outreach-owed.mjs` is a read-only "awaiting" view.
   Policy: `config/narrative.md` → "Outreach on qualify".

## Cadence (opt-in)
- **Scheduled speed runs are OFF by default.** Opt in with `node scripts/schedule.mjs install --with-speed N`
  (recommended 2-4 runs/day). Each run is `node scripts/morning.mjs --mode speed`: zero-token scan-index over
  the last 12h plus capped headless scoring. LinkedIn lanes never run in speed or hot mode (daily only).
  Qualifiers land in `qualifiers.tsv` / `scored-jobs.tsv`; reports and resumes for them come from the daily
  run or an interactive session. Outreach is never drafted by a scheduled run.
- **Hot tier (opt-in):** `--with-hot` (every 30-60 min, default 60) polls `data/hot-companies.tsv` only.
- **In-session `/loop` (interactive only, browser-capable):** the same cycle plus the browser supplement and,
  for each new qualifier, report + tracker TSV + merge-tracker + resume PDF. Dedup against
  `scored-jobs.tsv`/`qualifiers.tsv` makes overlap with scheduled runs harmless.
- **Morning quota:** the daily run enforces `pipeline.daily_quota` (see `config/narrative.md` → "Morning quota").

On every new ≥ qualify_score in an interactive cycle: **full evaluation report (Blocks A–G per
`.claude/skills/career-finder/modes/offer.md`, numbered, in `reports/`) + tracker TSV + merge-tracker + resume PDF**. The one-line `why` in
`scored-jobs.tsv` is triage, not the evaluation — **the report IS the evaluation**; a qualifier without a report
is incomplete (dashboard `⏎` drill-in opens the report via `applications.md`).

## Improvement loop
Every cycle: append **each scored role (any score)** to `data/scored-jobs.tsv` **with a precise ISO `found_at`**
(use `record-scored.mjs`, not a hand-built row — the dashboard's rolling-24h Found panel and `scored` view both
read this file and key off `found_at`), then run `reconcile-qualifiers.mjs` so `qualifiers.tsv` never drifts from
the canonical scored ledger, and
log the cycle — `node scripts/speed-metrics.mjs <ats_found> <browser_found> <scored> <qualified> <note>`.
Periodically `node scripts/speed-metrics.mjs --analyze` learns WHICH hours (local time) actually produce fresh ≥ qualify_score
posts and banks a learning to `.claude/skills/career-finder/modes/scan-web.md`, so the loop tightens cadence in productive windows and idles
otherwise. Also reuse the scan-web pre-filter learnings (drop Director/Head, Java/ML, hardware/intern) before scoring.

## Config
- **Freshness:** `--hours 12` default. **Gate:** only ≥ qualify_score shown. **Source:** ATS-first + browser supplement.

## Reality (honest)
The ≤12h qualifying supply is usually **0 at any given instant** (thin niche). The value is the
loop: when a fit posts, you see it within the hour and apply before the flood.
