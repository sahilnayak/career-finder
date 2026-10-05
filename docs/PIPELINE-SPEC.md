# Career-Finder Pipeline — Canonical Spec (as-built)

> **The single source of truth for how the job-search funnel runs end to end:**
> discover → index → scan → score → qualify → reconcile → owed-drain → report + resume + outreach → apply → outcome-feedback → learn.
>
> This documents the **live system** (forked from career-finder and generalized), consolidates every accumulated learning into one registry, and flags where the older docs have drifted from the code. It is an *as-built* spec, not a proposal — the pipeline is already running (`morning.mjs`, scheduled by `schedule.mjs`).
>
> **Scope / non-duplication.** This is the **flow + thresholds + learnings** doc. It deliberately does NOT repeat:
> install/config (→ [`docs/SETUP.md`](SETUP.md)) · the user/system file split (→ [`DATA_CONTRACT.md`](../DATA_CONTRACT.md)) · per-script flags & exit codes (→ [`docs/SCRIPTS.md`](SCRIPTS.md)) · customization knobs (→ [`docs/CUSTOMIZATION.md`](CUSTOMIZATION.md)) · the component diagram (→ [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)). It links to those and focuses on how the pieces run as one funnel.

---

## 1. Purpose & North Star

**What the pipeline is for.** Continuously surface the freshest in-territory roles that genuinely fit the candidate, and — the moment one qualifies — produce the full application kit (evaluation report, tailored résumé, outreach drafts) so the only human step left is *review and send*.

**Who it targets:** whatever `targets.roles` in `config/profile.yml` says -- set during onboarding from the candidate's resume and confirmed by them. Archetypes and framing live in `config/narrative.md`. Nothing in the pipeline assumes a career.

**What it optimizes:**
- **Time-to-lead within `pipeline.window_hours`** — a fresh role is found, scored and kitted within a day of posting.
- **Quality over quantity** — only roles scoring **≥ `pipeline.qualify_score`** enter the pipeline; below 4.0 is actively discouraged.
- **Daily quota** — `pipeline.daily_quota` qualifiers, `pipeline.primary_quota` of them in the primary role (§4a).
- **Territory discipline** — `location` + `location.remote_policy` via `scripts/targets.mjs`.
- **Draft-never-send** — nothing is ever auto-sent or auto-submitted (Ethical Use).
- **Self-improvement** — verdicts feed back into search targeting and scoring.

**Non-goals:** mass applications; a durable backlog (finds older than the window drop out of the active pipeline by design); auto-sending anything; using posted base-salary bands as a scoring factor.

---

## 2. Pipeline at a glance

```
                         ┌──────────────────────── self-improvement loops ───────────────────────┐
                         │                                                                        │
  ┌─────────────┐   ┌────┴─────┐   ┌──────────────────────────────┐   ┌─────────┐   ┌──────────┐  │
  │ 0 DISCOVER  │──▶│ company- │──▶│ 1  SCAN (zero-token)         │──▶│ 2 SCORE │──▶│ 3 RECON- │  │
  │ grow index  │   │ index.tsv│   │  1  ATS sweep (rolling 48h)  │   │  A–G    │   │  CILE +  │  │
  └─────────────┘   └──────────┘   │  1b LinkedIn guest comb      │   │ rubric  │   │  PRUNE + │  │
        ▲                          │  1c open-web feed + learn ───┼─┐ └────┬────┘   │  QUOTA   │  │
        │ net-new ATS slugs        └──────────────────────────────┘ │      │        └────┬─────┘  │
        └──────────────────────────────────────────────────────────┘      ▼             │        │
                                                            scored-jobs.tsv (ledger)     │        │
                                                            qualifiers.tsv (≥ qualify_score, 24h)   │        │
                                                                                         ▼        │
  ┌────────────────────────────────────────────────────────────────────────────────────────┐    │
  │ 4 OWED RECONCILIATION (unskippable)  — every ≥ qualify_score found in last 24h owes 3 artifacts      │    │
  └───────────────┬──────────────────────────┬───────────────────────────┬───────────────────┘    │
                  ▼                          ▼                           ▼                         │
        ┌──────────────────┐      ┌────────────────────┐      ┌────────────────────┐               │
        │ 5 OUTREACH drain │      │ 6 RÉSUMÉ PDF        │      │  report (Blocks A–G)│              │
        │ bullets→roster→  │      │ tailored per        │      │  reports/NNN-*.md   │              │
        │ email→draft→judge│      │ archetype           │      └────────────────────┘               │
        └────────┬─────────┘      └────────────────────┘                                            │
                 ▼                                                                                   │
        ┌──────────────────┐      ┌────────────────────┐      ┌────────────────────────┐            │
        │ 7 APPLY & TRACK  │─────▶│ 8 OUTCOME DETECT    │─────▶│ FEEDBACK LEARNING ─────┼────────────┘
        │ applications.md  │      │ (read-only Gmail)   │      │ scan-web.md re-targets │
        └──────────────────┘      └────────────────────┘      └────────────────────────┘
```

Everything left of stage 4 runs **headless/autonomously** (`morning.mjs` + `claude -p`). Stages 5–7's browser work (LinkedIn contacts) is drained at the next browser-capable interactive session.

---

## 3. Cadence & orchestration

**One entry point, three modes.** Every scheduled run is `node scripts/morning.mjs --mode <daily|speed|hot>`.
`scripts/schedule.mjs install` writes the jobs (launchd `com.career-finder.<mode>` on macOS, a
`# career-finder BEGIN/END` crontab block on Linux; Windows is manual, see [`SCHEDULING.md`](SCHEDULING.md)).

| Mode | Default | Trigger | Logs | Purpose |
|---|---|---|---|---|
| `daily` | **ON** | once a day at `schedule.daily_time` (default 07:00 local) | `data/_pipeline.log` | The discovery→score→quota spine, including the LinkedIn logged-in lanes. |
| `speed` | opt-in (`--with-speed N`, 2-4/day) | spread 09:00-18:00 | `data/_speed-cron.log` | 12h ATS sweep + primary-role gap. No LinkedIn. |
| `hot` | opt-in (`--with-hot [MIN]`, 30-60 min, default 60) | interval | `data/_hot.log` | Sweep + score `data/hot-companies.tsv` only. No LinkedIn. |

> **Cost ceiling.** Every `claude -p` call runs on Sonnet by default and is counted in
> `data/_claude-calls.log`; at `pipeline.daily_claude_cap` (default 40) calls per local day across
> all modes the run exits 3. The scheduled runs use `claude -p --dangerously-skip-permissions`
> (headless runs cannot answer prompts) — `npm run schedule:status` discloses this.
>
> **What a single daily run implies.** A job posted after the morning run is not seen until the next
> morning (time-to-lead up to ~24h) unless speed or hot is opted in. The rolling sweep window covers
> the gap, so nothing is missed, it is surfaced later.

**`scripts/morning.mjs`** internals:
- **Mutual exclusion:** an atomic lock directory per mode; a stale lock is reclaimed; overlapping launches exit immediately.
- **Kill switches** (checked before the lock, each logs a SKIPPED line): `data/PIPELINE_OFF`, `data/HOT_OFF`, `data/LINKEDIN_OFF`, `data/_pipeline-skip-dates.txt`, the 30-min usage-wall backoff `data/_hot-quota-backoff`.
- **Once-a-day lanes** (discover, Gmail outcomes) carry a per-day sentinel so a second daily run does not repeat their spend.
- **Session entry** also runs the owed check (stage 4) via the SessionStart hook in `.claude/settings.json`.

---

## 4. Stage-by-stage spec

Each stage: **Purpose · Runs it · Inputs · Outputs · Rules.**

### Stage 0 — Index growth / company discovery
- **Purpose:** continuously grow the universe of companies in the configured area with a public ATS board, so the zero-token sweep has more to cover. Coverage compounds.
- **Runs it:** `morning.mjs` daily `discover` lane (once/day) `claude -p` on Sonnet · `scripts/discover-companies.mjs` (every cycle, zero-token) · `scripts/build-company-index.mjs` (on-demand seeder). Modes: `discover.md`, `orchestrator.md`, `scan-index.md`.
- **Inputs:** `data/_discovered-companies.tsv` (`company⇥careers_url`), a built-in CURATED list (~35 boards), `data/scan-history.tsv` (build-index derives boards from past job URLs), optional YC Algolia (`YC_ALGOLIA_KEY`).
- **Outputs:** `data/company-index.tsv`.
- **Rules:** idempotent append-new / skip-existing; dedup on `careers_url` (lowercased, trailing-slash-stripped) **and** company name; `detectApi()` records `ats_type` + the zero-token `ats_api_url` (greenhouse, ashby, lever, workday, bamboohr, teamtailor, smartrecruiters, workable, recruitee). **Subagents cannot drive the browser MCP** — each discovery agent writes its own `_swarm-*.tsv`/`_orch-*.tsv` then `cat >> _discovered-companies.tsv` (no parallel-write races). Verify each slug resolves to a real board with ≥1 job before adding.

### Stage 1 — Zero-token ATS sweep of the index
- **Purpose:** hit every indexed company's ATS JSON directly (no LLM, no browser) and emit the fresh, in-territory, on-archetype roles. The coverage backbone and the no-remote gate of record.
- **Runs it:** `morning.mjs` `ats:index` lane → `scripts/scan-index.mjs` (plus `ats:primary-watchlist`: `--only data/primary-watchlist.tsv --primary-only --hours 72`) (engine: `scripts/scan-core.mjs`). Mode: `scan-index.md`.
- **Inputs:** `data/company-index.tsv` (only rows with a non-empty `ats_api_url`); dedup sources `data/scan-history.tsv`, `data/pipeline.md`, `data/applications.md`, `data/scored-jobs.tsv`; `portals.yml` (`title_filter`).
- **Outputs:** `data/_candidates.tsv`; stamps `last_scanned`/`last_status` back onto `company-index.tsv`; optional `data/_browser-queue.tsv` (non-ATS companies).
- **Rules:**
  - **Rolling `--hours 48`, NOT calendar `--days 1`** (`makeHoursPredicate`). Rationale in code: a role posted yesterday evening (~13h old) is within 24h but a calendar-day filter drops it; 48h + hourly sweeps + dedup guarantees every fresh role is seen across its whole first 24h even if a sweep is missed.
  - **Title filter** `buildTitleFilter(..., {dropSeniorityNegatives:true})`: ≥1 positive must match; a negative that is a substring of a matched positive is **neutralized** (positive "technical account manager" absorbs the "account manager" negative); seniority negatives (junior/intern/entry/associate) are dropped → "any seniority."
  - **No-remote in the TITLE too:** reject `remote|wfh|distributed|anywhere` in the title unless it says `hybrid`.
  - **Location filter** `buildLocationFilter()`: delegates to `targets.classifyLocation()`/`locationMatches()`; remote accepted only per `remote_policy`.
  - **Dedup** vs scan-history / pipeline.md / applications.md / **scored-jobs.tsv (col 7 = url)**; plus `company::title` vs applications.md.
  - **Parallelism** `parallelFetch(tasks, 10)`, 8s fetch timeout, **zero Claude tokens.**

### Stage 1b — LinkedIn guest comb
- **Purpose:** a secondary fresh-role feed from LinkedIn's public guest job API.
- **Runs it:** `morning.mjs` daily `linkedin:guest` lane → `node scripts/speed-linkedin.mjs --hours 24 --json`.
- **Inputs:** LinkedIn guest API (`…f_TPR=r86400`), `data/_speed-noise.txt`, `data/scored-jobs.tsv` (dedup).
- **Outputs:** `data/_speed-li.json`.
- **Rules:** uses the shared `scripts/role-filters.mjs` (`REMOTE`, `LOCAL`, `TITLE_DROP`, `loadNoise`) so it can't drift from the web feed. **LinkedIn card locations are unverified** (can show a local city for a Remote role) — ATS truth wins at scoring. Subject to the **LinkedIn kill-switch** (`data/LINKEDIN_OFF`).

### Stage 1c — Open-web role feed + web-search learning loop
- **Purpose:** find **net-new** employers/roles the indexed sweep can't see yet (open web), and get smarter at it every run.
- **Runs it:** `morning.mjs` daily `websearch` lane, `claude -p` on Sonnet (WebSearch/WebFetch only — no browser) → `scripts/web-roles.mjs --clean`/`--archive` → `scripts/web-roles-learn.mjs`. Mode: `scan-web.md`.
- **Inputs:** **the newest learning in `data/web-search-learnings.md`** (read first, re-targets the run), live web; dedup vs `scored-jobs.tsv` + `_candidates.tsv` + `_speed-noise.txt`.
- **Outputs:** `data/_web-roles.tsv`, `data/_web-roles-history.tsv`, appends net-new employers to `data/_discovered-companies.tsv` (feeds stage 0), and the learner appends to `data/web-search-learnings.md`.
- **Rules:**
  - **Protected primary lane:** every cycle runs ≥1 dedicated query for `targets.primary_role` in addition to the other roles. Learnings may reorder sources but must never drop the primary lane.
  - **Freshness rule:** snippet/aggregator dates lag — verify via the employer's ATS posting-API (Ashby `publishedAt`, Greenhouse `first_published`, Lever `createdAt`); keep only if confirmed within 24–48h; if unverifiable from a primary source, don't write the row.
  - **Coverage rule:** companies already indexed are swept by stage 1 — prioritize **net-new** employers + AI-native/dev-tools shapes.
  - **Agent pre-filter + deterministic guardrail (`web-roles.mjs --clean` re-applies `role-filters.mjs`):** drop remote/non-local/leadership/off-archetype/staffing/anonymized-shell; dedup vs ledger + this cycle's candidates.
  - **Learning loop (`web-roles-learn.mjs`):** joins `_web-roles-history.tsv` → `scored-jobs.tsv` by normalized URL, buckets by source and title-family, counts qualifiers (≥ qualify_score); gates ≥12 attributed finds to bank, ≥10-in-a-bucket-with-0-qualifiers to "drop"; **one learning/day**; writes a dated bullet under `## Learnings (newest first)`.

#### Crawl source tiers
1. **Index ATS sweep (`scan-index`, zero-token)** -- the freshness backbone.
2. **ATS-host web search** (`jobs.ashbyhq.com`, `job-boards.greenhouse.io`, `jobs.lever.co`) -- best for discovering *which* companies hire the target roles.
3. **Browser job boards** (Wellfound, Built In for the user's metro, YC, and role-specific boards for the target career) -- interactive Chrome session only; the headless cron cannot reach them.
4. **LinkedIn / HiringCafe nomination lanes** -- nominate roles; the employer ATS confirms existence, JD, location and comp.

Thin supply for a narrow role is normal. A short day is reported, never inflated.

### Stage 2 — LLM scoring (A–G rubric, ≥ qualify_score bar)
- **Purpose:** score every fresh candidate against the candidate's CV + targeting, write the canonical ledger, and flag qualifiers.
- **Runs it:** `morning.mjs` `score` lane, `claude -p` on `pipeline.scoring_model` (Sonnet), capped at `pipeline.score_cap` per run. Helper: `scripts/record-scored.mjs`. Rubric: `.claude/skills/career-finder/modes/offer.md` + `.claude/skills/career-finder/modes/_shared.md` vs `cv.md` + `config/narrative.md`.
- **Guard:** only runs if there are new signals (ATS+LinkedIn+web > 0) → empty cycles cost zero tokens.
- **Inputs:** `data/_candidates.tsv`, `data/_speed-li.json`, `data/_web-roles.tsv`; dedup vs `scored-jobs.tsv`; rubric files.
- **Outputs:** appends every triaged candidate → **`data/scored-jobs.tsv`** (the canonical ledger); ≥ qualify_score → `data/qualifiers.tsv`; logs the cycle via `scripts/speed-metrics.mjs`.
- **Rules:**
  - **CANONICAL-JD rule:** never score from a LinkedIn/snippet card — resolve to the real ATS posting and verify freshness; a genuine repost >48h → verdict `stale`, not scored.
  - **EXACT-POSTING rule:** `_candidates.tsv` rows already carry the canonical URL + exact posted timestamp — trust them; fetch that exact posting by job-id; **do not re-match by title** (same-titled siblings of different ages — base vs Enterprise/Staff/Manager — make a fresh role look stale). Only LinkedIn + web candidates need ATS resolution.
  - **Hard-gate checklist before any ≥ qualify_score:** language fluency · clearance/citizenship · territory · years gates · named mandatory tech · certifications · visa — any unmet gate caps below 4.3.
  - **Location/remote** per `remote_policy`; **base-salary band is NOT a scoring factor** — comp dimension scored neutral 4.0 unless verified total comp known.
  - Scoring dimensions: CV match · North-Star archetype fit · comp vs `compensation` in the profile · cultural signals · red flags. The card/snippet score is **provisional** — stage 3 reconcile is the canonical re-score authority.

### §4a — Loop until the daily quota (bounded)

When short, `morning.mjs` (daily only) runs keep-search: a near-miss re-score, then `keep_search.max_rounds` web rounds (default 0), then an index backstop, stopping once `daily-quota.mjs` reports the
board holds `pipeline.daily_quota` qualifiers (score >= `pipeline.qualify_score`, found within
`pipeline.window_hours`) including at least `pipeline.primary_quota` matching
`targets.primary_role`, or a round cap is hit. Each round varies its queries; primary-role-first
sub-passes run when the primary slot is short.

When the cap is hit it logs the shortfall, surfaces the best near-misses flagged below-bar (never
on the board), and ends. **Never inflate a score, relabel a role as primary, or widen the window to
manufacture the number.**

### Stage 3 — Reconcile · prune · daily archetype quota
- **Purpose:** keep the qualifier views honest against the canonical ledger, hold the board to 24h, and enforce daily archetype coverage.
- **Runs it:** `morning.mjs` lanes, in order (`prune-qualifiers.mjs` → `reconcile-qualifiers.mjs` → `feedback-outcomes.mjs --learn` → `web-roles-learn.mjs` → `drain-outreach.mjs --bullets-only` → `pipeline-owed.mjs` → `daily-quota.mjs`).
- **`prune-qualifiers.mjs`:** drop any `qualifiers.tsv` row whose `posted`/`date` is >24h old (`MAX_MS=24h`).
- **`reconcile-qualifiers.mjs`:** match each qualifier to its canonical `scored-jobs.tsv` row by **job-id in the URL** (gh_jid / Ashby UUID / Lever / Workday / LinkedIn numeric), fallback normalized company+role (latest canonical wins), then classify: **CONFIRMED** (keep, backfill `found_at`) · **DEMOTED** (canonical < qualify_score → drop, false positive) · **RESCORE** (canonical older than card → keep, re-score) · **ORPHAN** (no canonical row → keep + backfill a `scored-jobs.tsv` row so the dashboard can surface it). Logs `data/_qualifiers-reconcile.log`. *Why it exists: the dashboard Found panel reads `scored-jobs.tsv`, not `qualifiers.tsv`, so a qualifier with no timestamped ledger row is invisible (finding 2026-06-16).*
- **`daily-quota.mjs`** (reads `scored-jobs.tsv` only; **exit 0 = met, 1 = short**): the board (within `pipeline.window_hours`, ≥ `pipeline.qualify_score`) must hold `pipeline.daily_quota` qualifiers AND `pipeline.primary_quota` matching `isPrimaryRole()`. `QUOTA: SHORT` names which gate failed. If no primary-role qualifier exists, it surfaces the best primary near-miss (4.0 to just below the bar, last 7d) flagged below-bar, never on the board. Dismissal semantics: the pool excludes only **user** dismissals; `prune-board.mjs` writes `aged` in col 11 for window expiry, which the fallback treats as a live lead to re-verify. On SHORT, the cron runs one extra targeted pass. **Never inflate a score to hit the quota.**

### Stage 4 — Owed reconciliation (the unskippable guarantee)
- **Purpose:** guarantee that every job that qualified gets the full kit — nothing silently dropped across sessions.
- **Runs it:** `scripts/pipeline-owed.mjs` (superset: report + résumé + outreach) · `scripts/outreach-owed.mjs` (outreach only). Wired into the **SessionStart hook** (`.claude/settings.json`) and the `morning.mjs` `pipeline-owed` lane.
- **Inputs:** `scored-jobs.tsv`, `qualifiers.tsv`, `applications.md`, `outreach-log.tsv`, on-disk `output/cv-*.pdf` + `reports/*.md`.
- **Outputs:** prints `OWED: N (report:a resume:b outreach:c)` + per-job missing list (or `--json`).
- **Rules:** **THRESHOLD = 4.3.** **`WINDOW_MS = 24h` — NOT a durable backlog**: a find older than 24h leaves the active/owed view; do **not** resurface or backfill (older rows stay in `scored-jobs.tsv` only as history). Terminal tracker states (Applied / Discarded / SKIP / Rejected / Offer) leave the pipeline by decision. Biases to "not covered" when unsure so nothing is skipped; always exits 0.

### Stage 4b — Outreach selection gate (user decision point)
- **Purpose:** put the decision of *which* qualifiers get outreach in the user's hands, because the outreach drain spends a hard-capped, risk-bearing budget (the LinkedIn profile-visit caps in `li-budget.mjs`, plus the Hunter email quota). **Supersedes the old "outreach is unskippable on ≥ qualify_score" auto-fire rule** (`feedback_outreach_on_qualify`): ≥ qualify_score now makes a job *eligible*, not *owed*.
- **Runs it:** the user — `w` on the dashboard Found panel (`data.MarkOutreachSelected`), or `scripts/outreach-queue.mjs add`. Surfaced by `scripts/outreach-queue.mjs awaiting` (SessionStart hook).
- **Inputs:** `scored-jobs.tsv` / `qualifiers.tsv` (eligible set, 24h board window), `outreach-log.tsv` (already drafted).
- **Outputs:** `data/outreach-queue.tsv` — `selected_at, company, role, score, url, li_mode, status, drafted_at`.
- **Rules:**
  - **What still auto-runs:** `gen-bullets.mjs` for **every** eligible ≥ qualify_score job (`drain-outreach --bullets-only` passes `--all`). Bullets are headless and cost no LinkedIn budget, so a job the user later picks drafts instantly.
  - **What waits for a pick:** roster/persona search, email finding, HTML, judge — i.e. everything that spends budget.
  - **Once picked, the old guarantee is unchanged:** the job stays owed and resurfaces every run until actually drafted. `outreach-owed.mjs` owed = eligible **AND** picked **AND** undrafted; `--all` bypasses the gate for diagnostics only.
  - **Nothing is silently dropped:** un-picked qualifiers are listed by `awaiting` and printed at every session start. They age off the 24h board like any other lead — designed, not a leak.
  - **Draft-only still absolute:** picking authorises drafting, never sending.
  - **LinkedIn depth matched to company size:** auto-mode is now the **default** — `scan-roster.mjs` reads the employee count off the company page and uses **< 60 employees → one un-scrolled `/people/` page** (at that size the roster genuinely is the company and beats search); **≥ 60 → targeted persona search only**, no sweep. Per-job override via the queue's `li_mode` (`auto`|`roster`|`targeted`) or `--search-only` / `--no-auto-mode` / `--large-threshold N`.

### Stage 5 — Outreach drain
- **Purpose:** turn each **picked** owed qualifier into JD-anchored, contact-resolved, QA'd outreach drafts. **Draft-only — never sends.** Gated by stage 4b: the drain processes only what the user selected.
- **Runs it:** `scripts/drain-outreach.mjs` orchestrates, per owed job: `gen-bullets.mjs` → resolve LinkedIn slug → `scan-roster.mjs` → `find-email.mjs` → `gen-outreach.mjs` → `render-outreach.mjs` → `outreach-judge.mjs`. Modes: `outreach.md`, `contact.md`.
- **Inputs:** `outreach-owed --json`; `cv.md` + `config/narrative.md`; the JD; roster cache `data/rosters/*.json`; report `reports/NNN-*.md` (Block F STAR points).
- **Outputs:** `data/bullets/{slug}.json`, `data/rosters/{slug}.json`, `output/outreach/*.html` + `*.drafts.json` + `*.scorecard.json`, and **`data/outreach-log.tsv`** rows (`pending`/`pending`).
- **Rules:**
  - **Spend profile visits on every draft contact.** A visit's value is
    `recentPost`, not the headline — the headline is byte-identical to the free card 98.4% of
    the time, but the post is the only person-specific hook available, since naming someone's
    job title back to them is banned. Without it the opener degrades to a generic company line.
    `scan-roster.mjs` runs a **provisional persona assignment on card data** and visits those
    finalists **before** raw card rank, with `--max-visits` defaulting
    to **6** to cover the full persona set. Fewer companies per day is the accepted trade.
  - **JD-mapped gold/silver/bronze** (`gen-bullets.mjs`): identify the 3 most important JD requirements in priority order; bullet 0 = req #1; each bullet ≤28 words, grounded in real `cv.md` or a defensible inference — **invent no fake metrics/employers/tools.** Strips em dashes. `li` ≤140 chars, `liLeader` ≤95.
  - **JD-tie style = SUBTLE ECHO, no announcer:** each bullet **weaves the JD's own verb/phrase** naturally (not a `Requirement: proof` label); the email opens with an **employer-specific JD-mission line** (name the company + its distinctive vertical/motion) and goes **straight into the bullets** — the `and here are three reasons I'd be a good fit:` announcer is **dropped**. Anchored to the JD's product/mission/work and what was BUILT, never the recipient's role. Enforced in `gen-bullets.mjs` (prompt) + `gen-outreach.mjs` (no-announcer template); rule lives in `.claude/skills/career-finder/modes/outreach.md`.
  - **Contact discovery — match the method to company size:** small co → roster + persona-search; **large/multi-team → targeted LinkedIn `"{Company} {Team} {Role}"` search, NOT the roster**; Head of {Team} = gold HM; verify every contact is on the hiring team.
  - **`scan-roster.mjs` rules:** hard-stops on the **LinkedIn kill-switch** (`data/LINKEDIN_OFF`) **and on `data/LI_COOLDOWN`**; excludes CxO/founder (`EXCLUDE_RE`, now incl. CRO/CPO/CIO/CISO/president); **Leader = VP/Head/Director of the engineering or GTM org the req sits in**, never CEO; authority contacts must name a current employer or are flagged out of auto-pick; **sequential, 1 lane, no `--concurrency` flag**, 6–12s spacing.
    - **Ranking is `roster-score.mjs`, which parses (level, function) as TWO axes.** The old flat score conflated them and could tag a "Head of {Team}" as a **Peer** — peers are dropped from drafts — so the real hiring manager was found and discarded while the run reported full coverage. Past-employer clauses (`ex: …`) are stripped before the level parse; employer match is word-boundary equality, not substring.
    - **Persona allocation scales with company size** (`ladderFor`): < 60 → HM 1 / no Leader (collapses into the founder, who is excluded); 200–800 → HM 2 / Leader 1 / Recruiter 1 / Peer 1; **≥ 2000 → Leader persona dropped** (a VP three levels above the req will not read cold mail). This replaces the old fixed `Leader 2 / HM 1`, which was backwards at every size.
    - **No top-up.** Unfilled slots are reported in `missingPersonas`, never padded with off-team contacts.
    - **Volume caps: 2 profile visits/run, 12/day** via the shared `li-budget.mjs` counter (not `_roster-budget.json`, which is gone). Measured: the visited headline is byte-identical to the free card title **98.4%** of the time (816 visits), and 13/17 companies select an identical set with zero visits.
    - **Searches and company-page loads are CHARGED** (`claim('search')` / `claim('pageview')`). Until 2026-07-25 they cost nothing, so a large-company run was entirely free against a cap nothing enforced.
    - **A roster is only usable if `partial !== true` and `selection` is non-empty.** Incremental mid-run saves are marked partial; consumers rescan instead of drafting with zero contacts.
  - **Email finding (`find-email.mjs`), stop at first hit ≥ 80:** real mail domain → **MX gate** → Hunter finder → site scrape → GitHub commit metadata → **GitHub-org pattern mining** (when Hunter quota exhausted) → **pattern + Hunter verifier** (trust only `valid`+`deliverable`+`accept_all:false`; **confidence capped at 88**). Sub-80 never shown as confirmed; LinkedIn is the safe first touch.
  - **Draft rules (`gen-outreach.mjs`):** three ranked **angles** per channel (gold/silver/bronze each anchored on a different JD requirement); default HM+Recruiter+Leader (**no Peer** unless `include_peers`); HM/Recruiter LinkedIn end with an approved CTA (set in `outreach-judge.mjs`), **Leader uses a pointer ask** (never the chat CTA); **no em dashes**; **money/backing ban** (never cite the company's raise/valuation/investors); **LinkedIn ≤300 hard cap.** *Logging caveat: running `gen-outreach.mjs` directly does NOT write `outreach-log.tsv` — that's `drain-outreach.mjs`'s job; otherwise the job stays OWED.*
  - **`outreach-judge.mjs` gates (exit non-zero on any HARD violation):** em dashes · over-cap · wrong CTA by persona · **every $/% claim must appear in `cv.md`** (truth gate). Gold/silver/bronze are angles, not quality tiers — the judge gates compliance; "which angle lands" is left to an opt-in Opus reviewer fan-out.

### Stage 6 — Tailored résumé PDFs
- **Purpose:** a per-role résumé that leads with what the JD prioritizes — real content only.
- **Runs it:** `scripts/generate-pdf.mjs` (HTML → PDF). Style: `templates/resume-style-guide.md`.
- **Outputs:** `output/cv-{candidate-slug}-{key}-{date}.pdf`.
- **Rules:** archetype reorders highlights/experience-bullets/skills to lead with JD priorities using **only real `cv.md` content (select/reorder/lightly reword, never invent, nothing dropped)**; `assertCvContract()` throws on `cv.md` drift; styles per `templates/resume-style-guide.md`. Auto-triggered for every ≥ qualify_score qualifier.

### Stage 7 — Apply & track
- **Purpose:** record the application and its status in the canonical tracker.
- **Runs it:** `auto-pipeline.md` (steps 4–5), `scripts/merge-tracker.mjs`, `templates/states.yml`.
- **Inputs/Outputs:** TSV additions in `batch/tracker-additions/` → merged into **`data/applications.md`**.
- **Rules:** **never edit `applications.md` to ADD rows** — write a TSV and let `merge-tracker.mjs` fold it in (status-before-score column order handled automatically); **never create a duplicate** company+role row — update the existing one; canonical states only (`templates/states.yml`); **never click Submit/Send** — the user makes the final call.

### Stage 8 — Outcome detection + feedback learning
- **Purpose:** learn from real-world responses so scoring and targeting improve.
- **Runs it:** `morning.mjs` daily `outcomes` lane (once/day, only when there are in-flight applications; `claude -p`, **read-only Gmail**, mode `feedback.md` → Outcomes (headless)) → `scripts/record-outcome.mjs` → `scripts/feedback-outcomes.mjs --learn`. Downstream: `patterns.md`/`analyze-patterns.mjs`, `followup.md`/`followup-cadence.mjs`.
- **Inputs:** `scripts/applied-watchlist.mjs` (in-flight applied jobs), Gmail (MCP), `qualifiers.tsv`, `applications.md`.
- **Outputs:** edits the Status cell of existing `applications.md` rows (appends a dated `(auto-detected from Gmail)` note); `data/qualifier-outcomes.tsv`; and `--learn` prepends a dated, data-driven learning to **`.claude/skills/career-finder/modes/scan-web.md`** (which the scorer reads).
- **Rules:** **READ-ONLY Gmail** — never send/reply/draft/delete/archive/label/modify; classify rejected/interview/offer/responded/NONE; an auto-acknowledgement is **not** "responded"; never regress a status. `--learn` fires once ≥5 decided outcomes exist (e.g. "FDE 67% vs SA 0% → prioritize FDE"). `followup` bans "just checking in"/"circling back"; cadence Applied 7d (max 2 then cold), Responded/Interview 1d.

---

## 5. Data contract (every file the funnel touches)

`scripts/scan-core.mjs` is the **zero-token engine** for stages 0–1 (`detectApi`, per-provider `PARSERS`, `fetchProvider`/`fetchWorkday`, `buildTitleFilter`, `buildLocationFilter`, `makeHoursPredicate`, `loadSeenUrls`, `parallelFetch`). `scripts/role-filters.mjs` is the shared pre-scoring regex set (`REMOTE`, `LOCAL`, `TITLE_DROP`, `loadNoise`) used identically by stages 1b and 1c so they can't drift.

| File | Columns (shape) | Written by | Read by |
|---|---|---|---|
| `data/company-index.tsv` | `company, hq, careers_url, ats_type, ats_api_url, source, date_added, last_scanned, last_status` (9) | discover-companies, build-company-index, scan-index (stamps last_scanned/last_status) | scan-index, discovery dedup |
| `data/_discovered-companies.tsv` | `company⇥careers_url` (2, no header) | 08:00 agent, 1c agent, keep-search agent, swarm merges | discover-companies `--from` |
| `data/_candidates.tsv` | `date, company, role, location, posted, url, ats` (7) | scan-index `--out` | stage-2 scorer, web-roles dedup |
| `data/_speed-li.json` | LinkedIn card JSON array | speed-linkedin | stage-2 scorer |
| `data/_web-roles.tsv` | `date, company, role, location, posted, url, source` (7) | 1c agent (append), web-roles `--clean` (rewrite) | stage-2 scorer, web-roles `--archive` |
| `data/_web-roles-history.tsv` | same 7 cols | web-roles `--archive` | web-roles-learn |
| `data/web-search-learnings.md` | dated bullets under `## Learnings (newest first)` | web-roles-learn | 1c web-search agent (newest learning) |
| **`data/scored-jobs.tsv`** *(canonical ledger)* | `date, company, role, score, verdict, why, url, found_at, applied_at` (9; opt. `dismissed_at`=10, opt. `dismiss_reason`=11 — `aged` = auto-pruned past the 24h board window, empty = user dismissed). `found_at` = UTC ISO ending `Z`. `verdict` ∈ QUALIFIED/near/pass/stale/SKIP | stage-2 scorer, record-scored, reconcile (orphans/backfill) | reconcile, daily-quota, web-roles-learn, all dedup, **dashboard Found panel** |
| `data/qualifiers.tsv` | `date, company, role, score, why, url, source, posted` (8) | stage-2 scorer, reconcile (rewrite) | prune, reconcile, qualifiers-view |
| `data/outreach-log.tsv` | per-persona/channel rows, status `pending`/`pending` | **drain-outreach** (not gen-outreach) | outreach-owed |
| **`data/outreach-queue.tsv`** *(selection gate)* | `selected_at, company, role, score, url, li_mode, status, drafted_at` (8). `status` ∈ selected/drafted; `li_mode` ∈ auto/roster/targeted | dashboard `w` (`MarkOutreachSelected`), outreach-queue.mjs | outreach-owed (the gate), drain-outreach (li_mode), dashboard (`✉` marker) |
| `data/applications.md` | tracker table (canonical states) | merge-tracker, detect-outcomes (status only) | owed checks, dedup, patterns, followup |
| `data/scan-history.tsv` | `url, first_seen, portal, title, company, status, posted_at, updated_at` (8) | scan.mjs (legacy) | build-company-index, scan-core dedup |
| `data/_speed-noise.txt` | one noise substring/line | curated | role-filters, web-roles dedup, scorer |
| `data/LINKEDIN_OFF` | presence = kill-switch ON | `linkedin.mjs off` | scan-roster, speed-linkedin, gen-outreach roster |
| logs | `data/_pipeline.log`, `data/_qualifiers-reconcile.log` | cron / reconcile | audit |

---

## 6. Thresholds & gates (consolidated)

| Gate | Value | Where enforced |
|---|---|---|
| **Qualify bar** | **score ≥ qualify_score** | `pipeline-owed.mjs`/`outreach-owed.mjs` (`THRESHOLD=4.3`), `daily-quota.mjs` (`MIN=4.3`) |
| **Draft-answers gate** | score ≥ 4.5 | `auto-pipeline.md` |
| **Recommend-against** | score < 4.0 | Ethical Use (`CLAUDE.md`) |
| **Active-pipeline window** | last **24h** (not a backlog) | `pipeline-owed.mjs` (`WINDOW_MS=24h`), `daily-quota.mjs` (`HOURS=24`), `prune-qualifiers.mjs` (`MAX_MS=24h`) |
| **Sweep window** | rolling **48h** | `scan-core.mjs` `makeHoursPredicate`, `morning.mjs` `ats:index` |
| **Daily qualifier quota** | **`daily_quota` qualifiers AND `primary_quota` primary-role** — both gate the exit code | `daily-quota.mjs` (reads `pipeline.*`) |
| **Qualifiers per run** | **loop until the quota, capped rounds; may end short, never inflate** (§4a) | `morning.mjs` keep-search caps |
| **Territory** | `location` + `remote_policy` | `scan-core.mjs` location/title filters, `role-filters.mjs`, `config/narrative.md` |
| **Browser concurrency** | **1, not configurable** (no `--concurrency` flag) | `scan-roster.mjs`; debug Chrome :9222 |
| **Roster volume** | **2 profile visits/run, 12/day** | `scan-roster.mjs` + `li-budget.mjs` (shared counter) |
| **Email confidence** | accept ≥ 80, cap 88 | `find-email.mjs` |
| **LinkedIn ≤ 300 chars + exact CTA** | hard cap | `gen-outreach.mjs`, `outreach-judge.mjs` |
| **Truth gate** | every $/% claim must appear in `cv.md` | `outreach-judge.mjs`, résumé `assertCvContract()` |
| **Base-salary band** | NOT a scoring factor | `config/narrative.md` |
| **Outreach selection** | user must pick; ≥ qualify_score = eligible, not owed | `outreach-queue.tsv` gate in `outreach-owed.mjs`; dashboard `w` |
| **LinkedIn depth** | **< 60 employees → one-page roster; ≥ 60 → targeted search** (auto-mode is the DEFAULT) | `scan-roster.mjs` (`--no-auto-mode` to force a sweep, `--large-threshold`) |
| **Profile visits / company** | **6** — every contact reaching a draft is visited, finalists queued first | `scan-roster.mjs` `PER_RUN_CAP` + provisional-finalist sort |
| **LinkedIn budget** | `search` 12/day · 50/7d · 250/mo · `profile` 12/day · 45/7d · `connect` 6/day · 25/7d · burst 12/rolling-hour | `li-budget.mjs` `HORIZONS`; day caps in `linkedin-stealth/pace.mjs` |
| **LinkedIn circuit breaker** | 999/429/checkpoint/authwall/CUL banner → abort + persist `data/LI_COOLDOWN`, never retry | `scan-roster.mjs` `guard()`, `li-budget.mjs` `cooldown()` |
| **Send/submit** | never automatic | every stage (Ethical Use) |

---

## 7. Verification & Judging

How the pipeline checks its own output. **Two tiers, by design:** deterministic gates and the auto Sonnet per-stage verifier **run automatically every cycle**; the heavyweight 6-agent review team is **opt-in** (manual trigger). Cost is minimized by spending LLM tokens only where judgment is genuinely needed — deterministic gates do the mechanical work for free, Sonnet does the semantic judgment, Opus is reserved for the opt-in team.

**Model policy** (`config/narrative.md`, 2026-06-28): verification/judging agents use **Sonnet** by default (~40% cheaper than Opus, reliable enough to judge); **never Opus for routine verification**; Haiku opt-in for mechanical checks only; never Fable (pricier than Opus). This intentionally overrides the global "always Opus" preference **for verification agents only**.

| Stage | Verifier | Type | Model | Judges | Run |
|---|---|---|---|---|---|
| 2 Score | scorer hard-gate checklist (in-scoring) | deterministic | — | language/clearance/tenure/tech gates | auto |
| 2 Score | `verify-stage.mjs --stage score` | **agent** | **Sonnet** | score-inflation vs cv.md + hard gates | auto |
| 3 Reconcile | `reconcile-qualifiers.mjs` | deterministic | — | card score vs canonical ledger (demote false positives) | auto |
| 3 Quota | `daily-quota.mjs` | deterministic | — | quota from `pipeline.*` | auto |
| 4 Owed | `pipeline-owed.mjs` / `outreach-owed.mjs` | deterministic | — | completeness (report+résumé+outreach exist) | auto |
| 5 Outreach | `outreach-judge.mjs` | deterministic | — | em-dash / ≤300 / CTA / $-claims-in-cv.md | auto |
| 5 Outreach | `verify-stage.mjs --stage outreach` | **agent** | **Sonnet** | JD-fit of gold/silver/bronze, truth, voice, contacts | auto |
| 6 Résumé | `cv-sync-check.mjs` | deterministic | — | cv.md drift (throws) | auto |
| 6 Résumé | `verify-stage.mjs --stage resume` | **agent** | **Sonnet** | every line traces to cv.md, archetype order, tenure | auto |
| (report) | `verify-stage.mjs --stage report` | **agent** | **Sonnet** | Blocks A–G completeness + truth vs cv.md | auto |
| all | `verify-pipeline.mjs` | deterministic | — | ledger/tracker data integrity | on-demand |
| all | **6-phase review team** (Find/Score/Report/Résumé/Outreach/Data) | **agent** | **Opus** | deep adversarial re-check of ONE job | **opt-in** |

**The auto per-stage verifier — `scripts/verify-stage.mjs`:** runs a Sonnet judge at score/outreach/résumé/report, writes a scorecard to `output/verify/*.verify.json`, and **exits 1 only on a HARD fail** (fabrication, unmet hard gate, score inflation, wrong CTA) so it can gate. It runs *after* the free deterministic gates and adds the semantic checks they can't do. **Kill-switch:** `touch data/VERIFY_OFF`. **Skip-safe:** if the `claude` CLI is unavailable (headless), it exits 0 rather than breaking the run. Wired into `morning.mjs` as the daily `verify-outreach` lane (up to 5 drafts, counts toward `daily_claude_cap`).

**The opt-in 6-agent team** stays the *only* Opus verification — triggered manually ("review {company} before I apply"), never auto-spawned, to control token cost.

---

## 8. Learnings

Learnings are banked per user: search-targeting learnings in `data/scan-web-learnings.md`, scoring and narrative overrides in `config/narrative.md`. A new install starts with none.

## 10. Cross-references

- **Setup & first run:** [`docs/SETUP.md`](SETUP.md)
- **Component map / single-offer eval flow:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- **Per-script reference (flags, exit codes):** [`docs/SCRIPTS.md`](SCRIPTS.md)
- **Customization (profile, archetypes, templates):** [`docs/CUSTOMIZATION.md`](CUSTOMIZATION.md)
- **User vs system file layers:** [`DATA_CONTRACT.md`](../DATA_CONTRACT.md)
- **Canonical states:** `templates/states.yml`
- **The two learning streams:** `data/web-search-learnings.md` (search) · the dated learnings prepended to `data/scan-web-learnings.md` (outcomes)

*This spec reflects the system as built and verified on 2026-06-28. When a stage's behavior changes, update the relevant stage block here and the matching mode/script — this file is the funnel's source of truth.*
