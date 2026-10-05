# Mode: speed — Speed-to-Lead Freshness Monitor (just-posted, ≥ qualify_score only)

Catches the **most recently posted** matching roles and surfaces only the ≥ qualify_score fits, so you apply first. Runs
hourly in-session (via `/loop`) and hourly via launchd. ATS-first (exact post times) + browser supplement.

## Per cycle
1. **ATS sweep (exact post times):**
   `node scripts/scan-index.mjs --hours 12 --out data/_candidates.tsv --browser-queue data/_browser-queue.tsv`
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
   the two ledgers in sync) → `feedback-outcomes.mjs` → show via `qualifiers-view` (newest first). For speed-to-lead, draft outreach
   immediately on a new ≥ qualify_score (the `outreach` mode). This is UNSKIPPABLE: run `node scripts/outreach-owed.mjs`
   and draft (JD-anchored gold/silver/bronze, draft-only) for every job it lists; a job stays "owed" until
   drafted, so nothing is dropped if the browser is down. Policy: `modes/_profile.md` → "Auto-outreach on qualify".

## Cadence — two tiers, ALWAYS-ON guaranteed by launchd (user-set 2026-06-10)
- **Always-on backbone: `com.careerfinder.speed` launchd job, hourly** (`scripts/speed-cron.sh` +
  `~/Library/LaunchAgents/com.careerfinder.speed.plist`). Zero-token sweeps (scan-index + speed-linkedin
  guest comb, no browser needed) and, only when new signals exist, headless `claude -p` scoring with the
  canonical-JD rule + hard-gate checklist. ≥ qualify_score → qualifiers.tsv; the report/resume/outreach steps are
  deferred as OWED (contact discovery needs the logged-in browser) and MUST be drained at the start of the
  next interactive session via `node scripts/outreach-owed.mjs`.
  Disable: `launchctl unload -w ~/Library/LaunchAgents/com.careerfinder.speed.plist`.
- **In-session crons (richer, browser-capable): hourly** — same cycle but completes the full on-qualify
  pipeline (report + resume + outreach) in-cycle. Overlap with launchd is harmless: both dedup against
  `scored-jobs.tsv`/`qualifiers.tsv`.
- **Morning-quota cycle (early morning, in-session): enforce the `pipeline.daily_quota`
  policy** in `modes/_profile.md` → "Morning quota" (check trailing 24h, escalate if short).

The launchd job grows the index autonomously between sessions, so each speed cycle sweeps a bigger universe
over time. On every new ≥ qualify_score: **full evaluation report (Blocks A–G per `modes/offer.md`, numbered, in
`reports/`) + tracker TSV + merge-tracker + resume PDF + outreach drafts, all in the same cycle** (policies
in `_profile.md`), then `node scripts/outreach-owed.mjs` must report 0 owed before the cycle logs itself.
The one-line `why` in `scored-jobs.tsv` is triage, not the evaluation — **the report IS the evaluation**;
a qualifier without a report is incomplete (dashboard `⏎` drill-in opens the report via `applications.md`).

## Improvement loop
Every cycle: append **each scored role (any score)** to `data/scored-jobs.tsv` **with a precise ISO `found_at`**
(use `record-scored.mjs`, not a hand-built row — the dashboard's rolling-24h Found panel and `scored` view both
read this file and key off `found_at`), then run `reconcile-qualifiers.mjs` so `qualifiers.tsv` never drifts from
the canonical scored ledger, and
log the cycle — `node scripts/speed-metrics.mjs <ats_found> <browser_found> <scored> <qualified> <note>`.
Periodically `node scripts/speed-metrics.mjs --analyze` learns WHICH hours (local time) actually produce fresh ≥ qualify_score
posts and banks a learning to `modes/scan-web.md`, so the loop tightens cadence in productive windows and idles
otherwise. Also reuse the scan-web pre-filter learnings (drop Director/Head, Java/ML, hardware/intern) before scoring.

## Config
- **Freshness:** `--hours 12` default. **Gate:** only ≥ qualify_score shown. **Source:** ATS-first + browser supplement.

## Reality (honest)
The ≤12h qualifying supply is usually **0 at any given instant** (thin niche). The value is the
loop: when a fit posts, you see it within the hour and apply before the flood.
