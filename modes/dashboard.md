# career-finder — dashboard mode

Launch the career-finder TUI dashboard in a new Terminal window (macOS).

The dashboard is a bubbletea Go binary at `dashboard/career-dashboard`. It's a TUI and needs a real terminal, so it can't run inside this session — it has to launch in a separate Terminal window.

## HARD RULE — the dashboard shows ONLY the configured window

**The Found panel shows only qualifiers (score >= `pipeline.qualify_score`) found in the last
`pipeline.window_hours` (default 24).** No unbounded list, no "persist until applied" list, no
older "Live Leads" fallback. If nothing qualifies in the window, Found stays EMPTY -- that is the
honest state, not a bug. Do not widen the window unless the user changes `pipeline.window_hours`.

Enforcement points that must agree with the profile: `dashboard/internal/ui/screens/jobs.go`,
`dashboard/main.go` (`-dump`), `scripts/daily-quota.mjs`, `scripts/outreach-queue.mjs`,
`scripts/prune-qualifiers.mjs`, `scripts/pipeline-owed.mjs`.

**Also enforced in the data:** `scripts/prune-board.mjs` (run by the morning pipeline after
`prune-qualifiers.mjs`) stamps `dismissed_at` (col 10 of `scored-jobs.tsv`) on any undecided
qualifier older than the window. It never touches applied rows and never deletes anything. If the
board ever shows something older than the window, suspect a stale binary first and rebuild:
`cd dashboard && go build -o career-dashboard . && cp career-dashboard ../`.

**The scan window is a different number.** `run-pipeline.mjs --hours N` controls how far back the
ATS scan looks; the board window controls what is displayed.

**The Applied panel is persistent history**, not windowed. An empty Found with a populated Applied
is normal.

## Daily quota

The morning run aims for `pipeline.daily_quota` qualifiers, at least `pipeline.primary_quota` of
them matching `targets.primary_role` (`isPrimaryRole()`). The TUI has no quota logic; it is
enforced by `node scripts/daily-quota.mjs`, which prints coverage and exits 1 with
`QUOTA: SHORT` naming the failed gate. **Never lower the qualify score or promote a sub-threshold
role to fake coverage** -- a short day is reported, not faked.

## Execute

1. **Check binary exists / is current**. Rebuild if the binary is missing or ANY `.go` file under `dashboard/` (including `dashboard/internal/**`) is newer than it:
   ```bash
   if [ ! -f dashboard/career-dashboard ] || [ -n "$(find dashboard -name '*.go' -newer dashboard/career-dashboard 2>/dev/null)" ]; then
     cd dashboard && go build -o career-dashboard && cd ..
   fi
   ```

2. **Launch in new Terminal window** (use the project's absolute path):
   ```bash
   osascript -e 'tell app "Terminal" to do script "cd '"$PWD"' && ./dashboard/career-dashboard"'
   ```

3. **Report to user** briefly:
   > "Dashboard launched in a new Terminal window. Home is a two-panel **Jobs** view — **Found** (qualifiers found within the configured window) on the left, **Applied** on the right. Keys: `↑↓` move · `tab` switch panel · `⏎`/`r` open report · `w` pick for outreach · `a` mark applied · `x` dismiss · `o` open posting · `p` progress funnel · `R` refresh · `q` quit. Enter opens the report (drill-in); `a` is the only key that marks applied, so a stray Enter never files an application. `a` writes `scored-jobs.tsv` + syncs the tracker; `x` dismisses a job from the board (stamps `dismissed_at`) before it ages out; `w` queues it for outreach drafting (draft-only, never sends)."

## Fallback / non-macOS

If `osascript` fails or the user isn't on darwin, print the manual command instead:
```
Open a new terminal tab in the career-finder project root and run:
  ./dashboard/career-dashboard -path .
```

## HARD RULE — `w` is the outreach selection gate (user-set 2026-07-25)

**Outreach is no longer automatic on ≥ qualify_score.** Scoring ≥ qualify_score makes a job eligible; the user decides which ones are worth pursuing by pressing **`w`** on the Found panel. Only picked jobs get the LinkedIn roster scan, email finding, and draft HTML — because that half of the flow spends a hard-capped **40 LinkedIn profile visits/day** (one roster sweep ≈ 20) plus the Hunter email quota.

- `w` appends the job to `data/outreach-queue.tsv` (`status: selected`) via `data.MarkOutreachSelected`. Idempotent; pressing `w` on an already-drafted job re-opens it for a redraft.
- Picked jobs render a green **`✉`** next to the score in the Found list.
- **Nothing is sent from the dashboard.** `w` authorises *drafting* only.
- JD-mapped bullets still auto-generate for every eligible qualifier (headless, no LinkedIn cost), so a picked job drafts immediately.
- Un-picked qualifiers are surfaced by `node scripts/outreach-queue.mjs awaiting` and by the SessionStart hook; they age off the board at 24h like any other lead.

Full rule and the company-size LinkedIn depth switch live in `modes/outreach.md`.

## Screens

- **Jobs (home)** — two panels. **Found** = qualifiers (score ≥ qualify_score, verdict not pass/skip) found in the **last 24h only** (HARD RULE above), newest first (ties broken by score), excluding applied + dismissed. A qualifier older than 24h drops off automatically. **Applied** = jobs you've marked applied, newest-applied first. `tab` switches focus; `a` on a Found job marks it applied (moves to Applied); `x` dismisses it (stamps `dismissed_at`, drops off the board, not applied); `⏎`/`r` opens the report (drill-in, both panels).
- **Viewer** (`⏎`/`r`) — opens the matched evaluation report for the selected job (linked by company + role from `applications.md`).
- **Progress** (`p`) — funnel + score distribution + response/interview/offer rates + weekly activity.

## Notes

- **Data sources:** `data/scored-jobs.tsv` (the speed-loop output: 9-col `date, company, role, score, verdict, why, url, found_at, applied_at`, plus an optional 10th `dismissed_at`) drives the Jobs home; `data/applications.md` provides the tracker for report drill-in + the "mark applied" sync.
- **Found = last 24h (hard rule):** only ≥ qualify_score qualifiers with `found_at` within the last 24h appear; older ones drop off automatically. `found_at` is parsed tolerantly (UTC `Z`, `±hh:mm`, and colon-less `±hhmm`); rows with no `found_at` fall back to their date at local noon. The search should write `found_at` as UTC ISO ending in `Z` (`record-scored.mjs` does; the cron scorer is instructed to).
- **Mark applied** (`a`) writes `applied_at` in `scored-jobs.tsv` AND, if the job already exists in `applications.md`, flips that row's status to `Applied`. If it's not in the tracker yet, a `batch/tracker-additions/dash-*.tsv` is queued — run `node scripts/merge-tracker.mjs` to fold it in.
- **Dismiss** (`x`) stamps `dismissed_at` (col 10) in `scored-jobs.tsv` and drops the job from the Found board without filing an application — use it to clear a fresh role you're skipping before it ages out of the 24h window.
- Rebuild after editing any `dashboard/**/*.go`: `cd dashboard && go build -o career-dashboard . && cd ..`
- Headless check (no TUI): `./dashboard/career-dashboard -path . -dump` prints the Found/Applied lists.
- To quit the dashboard: `q`, `esc`, or `Ctrl-C` inside the TUI.
