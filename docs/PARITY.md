# Pipeline parity: career-ops cron scripts -> `morning.mjs`

career-finder replaces three shell crons (`pipeline-cron.sh`, `speed-cron.sh`, `hot-cron.sh`) with one
script, `scripts/morning.mjs --mode daily|speed|hot`, scheduled by `scripts/schedule.mjs`.
Daily is on by default. Speed (`--with-speed`, 2-4 runs a day) and hot (`--with-hot`, every 30-60 min,
default 60) are opt-in.

Each row maps a career-ops step to the `morning.mjs` lane that replaces it and the mode file
(`modes/*.md`) that lane follows. Steps with no replacement say why they were dropped.
`scripts/test-pipeline-wiring.mjs` checks the wiring statically. The router table in
`.claude/skills/career-finder/SKILL.md` is where modes map to lanes.

## Daily (`pipeline-cron.sh` -> `--mode daily`)

| career-ops step | morning step (lane) | mode | notes |
|---|---|---|---|
| MASTER PAUSE (`PIPELINE_OFF`) | kill switch before the lock | — | Writes a SKIPPED line plus "since:" to the pipeline log. `npm run pipeline:on/off/status` |
| dated skip list | `data/_pipeline-skip-dates.txt`, before the lock | — | Uses the local date, not UTC |
| deferred backlog recovery (`quota-guard status/clear`) | `quota-replay:score`, `quota-replay:clear` | offer | Calls claude only when quota-guard reports a backlog |
| dashboard binary rebuild | `dashboard:build` | dashboard | Runs only when Go is installed and `dashboard/go.mod` exists |
| 0. discovery agent (`claude -p`, 08:00) | `discover` | discover (§Headless) | `onceToday`. The prompt no longer hard-codes the Bay Area; it reads the area from the profile |
| LinkedIn crawl (`linkedin-crawl.mjs`) | `linkedin:login`, then `linkedin:crawl:<role>` | scan-web | Logged in, **daily only**, serial. On by default (`integrations.linkedin`). Skipped with a reason if Chrome is missing or `LINKEDIN_OFF` is set |
| LinkedIn guest comb (`speed-linkedin.mjs`) | `linkedin:guest` | speed | Logged out. Runs in daily and speed |
| logged-in job search (`linkedin-jobsearch.mjs`) | `linkedin:faceted:<role>`, `linkedin:semantic:<role>` | scan-web | Daily only. Stops the remaining LinkedIn lanes on a checkpoint (exit 2) |
| LinkedIn email alerts | `linkedin:email-alerts` | scan-web | Needs Gmail |
| 1a. `repair-index --apply` (weekly) | `ats:repair-index` | scan-index | Mondays only |
| `run-pipeline.mjs --hours 48` | `ats:index` (calls `scan-index` directly) | scan-index | run-pipeline is retired. Its discover-companies step moved to the fan-in below. The window comes from `pipeline.scan_window_days` |
| 1b. protected SE sweep (`--se-only` on `se-watchlist`) | `ats:primary-watchlist` | scan-index | Covers the profile's primary role, not "SE" |
| 1c. `build-se-watchlist.mjs` | **dropped** | — | Built from the previous owner's SE ledger. The wiring test asserts it stays absent |
| 1d. hiringcafe | `hiringcafe` | scan | |
| workable search | `workable` | scan | |
| LANE C web search (`claude -p`) | `websearch` | scan-web (§Headless) | WebSearch/WebFetch only, no browser |
| browser-boards | `browser-boards` | scan | |
| fan-in: `probe-ats --unresolved`, `discover-companies --from` | `probe-ats`, `discover-companies` (`--yc` by default), `ats:new-boards` | discover / scan-index | The queue-non-empty gate was removed, so YC runs anyway. Turn it off with `discovery.yc: false` |
| — (only a comment in career-ops) | `portals-scan` (`scan.mjs`) | scan | New: zero-LLM portals.yml lane. Scoring dedups it against scan-index |
| `web-roles --clean/--archive` | `web-roles:clean`, `web-roles:archive` | scan-web | |
| `resolve-nominations` | `resolve-nominations` | scan | |
| 2. scoring (`claude -p`, cap 25) | `score` | offer + pipeline | Skipped with no claude call when there are no signals. Capped by `SCORE_CAP` |
| `snapshot-jd`, `gen-jd-pdfs`, `backfill-reports --min 4.3` | `snapshot-jd`, `jd-pdfs`, `backfill-reports --min Q` | pipeline | The threshold comes from the profile |
| full A-G reports (`claude -p`) | `reports` | offer (blocks A-G) | Capped by `REPORT_CAP` |
| `quota-guard check` | `claude()` helper (exit 3 + marker) | — | Usage-wall detection is part of every call |
| `prune-qualifiers`, `prune-board`, `reconcile-qualifiers` | same names | tracker | |
| `feedback-outcomes --learn` | `feedback-outcomes` | feedback | Runs once, after outcomes |
| `web-roles-learn` | `web-roles-learn` | scan-web | |
| `drain-outreach --bullets-only` | `outreach-bullets` (`--limit 5`) | outreach | Writes bullets only, never full drafts (`UNATTENDED=1`) |
| `pipeline-owed` | `pipeline-owed` | pipeline | Read-only view. Qualifiers are eligible for outreach, not owed it |
| verify-stage outreach | `verify-outreach` | outreach (verify) | Drafts from the last 24h only, capped at 5. A FAIL logs "Do NOT send" |
| merge tracker | `merge-tracker` | tracker | |
| `daily-quota` | `quota` | speed | |
| keep-search round 0: near-miss re-score | `near-miss:pool`, `near-miss:score` | offer | Runs only when the quota is short, once a day |
| keep-search web round (`claude -p`) | `keep-search:web:<n>` | scan-web (§Headless) | `pipeline.keep_search.max_rounds`, **default 0**. Measured yield was about one row per 140M tokens |
| SE backstop (`scan-index --se-only --hours 72`) | `keep-search:primary`, `keep-search:score` | scan-index / offer | Uses the primary role. Claude runs only when the backstop file has rows |
| outcomes (`detect-outcomes.sh`) | `outcomes` | feedback (§Outcomes (headless)) | Read-only Gmail. No claude call when `applied-watchlist` is `[]`. Skipped with a reason if the Gmail MCP is missing. detect-outcomes.sh is deleted |
| `rotate-logs` | `rotate-logs` | — | |
| `pipeline-digest` | `digest` | — | Adds two counts: outreach awaiting a pick, follow-ups overdue |
| — | `hot-list:build` | scan-index | New: rebuilds the hot list when it is empty or older than 7 days, so opt-in hot mode has a list to work from |

## Speed (`speed-cron.sh` -> `--mode speed`, opt-in)

| career-ops step | morning step (lane) | mode | notes |
|---|---|---|---|
| `scan-index --hours 12 --browser-queue` | `ats:index` (12h) | scan-index | **`--browser-queue` dropped**: browser-boards never drains `_browser-queue.tsv` (#19) |
| `speed-linkedin.mjs` | `linkedin:guest` | speed | Logged out only. No logged-in LinkedIn in speed |
| SE gap sweep (`--se-only --hours 24`) | `speed:primary-gap` | scan-index | Runs when `daily-quota --json` reports `primaryOk === false` |
| scoring (`claude -p`) | `score` | offer | Skipped with no claude call when there are no signals |
| `prune-qualifiers`, `reconcile-qualifiers` | `prune-qualifiers`, `reconcile`, `merge-tracker` | tracker | |
| `drain-outreach --bullets-only` | **dropped from speed** | — | Runs once a day in daily. Speed's job is speed-to-lead scoring |

## Hot (`hot-cron.sh` -> `--mode hot`, opt-in)

| career-ops step | morning step (lane) | mode | notes |
|---|---|---|---|
| no hot list -> exit 0 | same, before any lane | — | Hot mode never calls claude without a list. `data/HOT_OFF` pauses it |
| quota backoff | `data/_hot-quota-backoff` (30 min) | — | |
| `scan-index --only hot --hours 12` | `hot:sweep` | scan-index | |
| hot scoring (`claude -p`) | `hot:score` | offer | Gated on `_hot-candidates.tsv` rows > 0 |
| `reconcile-qualifiers`, `daily-quota`, `rotate-logs` | `reconcile`, `quota`, `rotate-logs` | — | |

## Removed from the career-ops crons and kept out

- `build-se-watchlist.mjs`: built from the previous owner's SE ledger.
- `discovery-coach` and `se-interview-prep`: personal agent and skill, never ported.
- Full outreach drafting, contact discovery and profile visits: interactive only. `UNATTENDED=1` blocks them in scheduled runs.
- Auto-PDF: interactive only (`pdf` mode).
