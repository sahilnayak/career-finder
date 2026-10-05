# Scheduling the morning run

The daily pipeline is one Node script, `scripts/morning.mjs`. It changes into the repo root on its own,
so a scheduler only has to call `node /path/to/career-finder/scripts/morning.mjs`.

```bash
npm run morning:dry     # preview: which lanes will run, which are skipped and why
npm run morning         # full daily run
node scripts/morning.mjs --mode speed   # optional top-up, 2-4 times a day (ATS sweep + scoring)
node scripts/morning.mjs --mode hot     # optional sweep of data/hot-companies.tsv, every 30-60 min
node scripts/morning.mjs --skip linkedin,websearch
```

Before scheduling anything, run `npm run doctor`. It must not say "needs onboarding".

## What each lane needs

| Lane | Needs | When missing |
|---|---|---|
| ATS index, HiringCafe, Workable, LinkedIn guest search | Node only | always runs |
| Scoring, full reports, web search, company discovery | `claude` CLI on PATH | skipped, logged |
| LinkedIn crawl + faceted + semantic search (3 per role, max 4 roles, past 24h) | debug Chrome on :9222 logged into LinkedIn. `morning` starts Chrome itself (`chrome-debug.mjs start`) and checks the login | **FAILED lane** with the fix command (`npm run linkedin:login`), never a silent skip |
| Browser-rendered boards | debug Chrome on :9222 | skipped, logged |
| LinkedIn job-alert emails, outcome detection | Gmail OAuth files in `~/.gmail-mcp/` | skipped, logged |
| Dashboard rebuild | `go` | skipped, logged |

HiringCafe also needs `location.lat` / `location.lng` in `config/profile.yml` unless `remote_policy` is `any`.

Unattended `claude -p` calls cannot answer permission prompts, so `morning.mjs` passes
`--dangerously-skip-permissions` by default. To change that, set `pipeline.claude_flags` in
`config/profile.yml` (for example `["--allowedTools", "Bash,Read,Write,Edit,WebSearch,WebFetch"]`).
Models: `pipeline.scoring_model` and `pipeline.report_model` (both default `sonnet`). Every call counts
toward `pipeline.daily_claude_cap` (default 40, all modes together, logged in `data/_claude-calls.log`).

Logs: `data/_pipeline.log` (daily), `data/_speed-cron.log` (speed), `data/_hot.log` (hot).
Pause everything: `npm run pipeline:off` (`data/PIPELINE_OFF`); resume with `npm run pipeline:on`.
Other switches: `data/HOT_OFF` (hot only), `data/LINKEDIN_OFF`, `data/VERIFY_OFF`, dates listed in
`data/_pipeline-skip-dates.txt`. After a usage wall, speed and hot back off for 30 min (`data/_hot-quota-backoff`).

Exit codes: `0` ok, `1` the daily quota is short, `2` setup problem, `3` scoring was deferred because
Claude hit a usage limit (the queue rolls to the next run).

Pick a time when the computer is awake. A sleeping laptop skips the run (launchd runs it on wake).

## LinkedIn (on by default)

`integrations.linkedin` defaults to on; set it to `false` in `config/profile.yml` to drop the lane.
Each daily run, for each of the first 4 `targets.roles`, serially with 20-60s jittered pauses:

1. `linkedin-crawl.mjs` — `/jobs/search-results/?keywords=K&f_TPR=r86400&geoId=G&sortBy=DD`, `pipeline.linkedin_pages` pages (default 2), plus the Apply-href ATS resolution tier
2. `linkedin-jobsearch.mjs --form faceted` — `?keywords=K&geoId=G&f_TPR=r86400`
3. `linkedin-jobsearch.mjs --form semantic` — "K posted in the past 24 hours", `origin=SEMANTIC_SEARCH_LANDING_PAGE`

then the logged-out guest API as a supplement. A checkpoint/CAPTCHA aborts the remaining LinkedIn lanes.

```bash
npm run linkedin:login   # start the debug Chrome, open linkedin.com/login, wait until you are logged in (once)
npm run linkedin:test    # one faceted 24h search for the primary role; prints the URL and card count
npm run linkedin:off     # kill switch (data/LINKEDIN_OFF); npm run linkedin:on to resume
npm run doctor           # LinkedIn: logged in / not logged in / Chrome down / geo missing
```

**The scheduler must run while you are logged into your Mac** (a GUI session): Chrome is a GUI app,
so a LaunchAgent (not a LaunchDaemon) is required, and the debug profile
(`~/.career-finder-chrome`, override with `CAREER_FINDER_CHROME_PROFILE`) keeps the LinkedIn session between runs. `morning.mjs` starts Chrome
when port 9222 is down. LinkedIn lanes run in **daily mode only**, never in speed or hot. With no
Chrome installed they log `linkedin: SKIPPED (no Chrome)` and the rest of the run continues. On Linux
cron, the job needs a `DISPLAY` for Chrome or the LinkedIn lane fails with "Chrome down".

## Install the schedule (one command)

```bash
npm run schedule -- install                      # daily run, ON, at schedule.daily_time (default 07:00)
npm run schedule -- install --with-speed 3       # + speed mode 3x/day, spread 09:00-18:00 (1-6; 2-4 recommended)
npm run schedule -- install --with-hot           # + hot mode every 60 min (--with-hot 30 for 30; minimum 30)
npm run schedule -- status                       # jobs, last run, calls today, worst case, kill switches
npm run schedule -- run-now [daily|speed|hot]    # run one mode now, in this terminal
npm run schedule -- --print [--with-speed N]     # show the exact job definitions, change nothing
npm run schedule -- uninstall                    # remove every career-finder job
```

Set the daily time in `config/profile.yml`:

```yaml
schedule:
  daily_time: "07:00"   # local time, HH:MM
```

`install` checks first and refuses if any of these fail (`--skip-preflight` bypasses them):
`npm run doctor`, `npm run morning:dry`, and a one-line headless `claude -p` call that proves the CLI
is logged in. `--with-hot` is refused until `data/hot-companies.tsv` has rows
(`node scripts/hot-list.mjs --build`; the daily run also rebuilds it weekly).

Re-running `install` is safe: it rewrites the jobs to match the flags you pass, so
`install` without `--with-speed` removes a speed job installed earlier.

Every job runs `node <repo>/scripts/morning.mjs --mode <mode>` with absolute paths to node, a `PATH`
that includes node and `claude`, the repo as working directory, and its output in
`data/_schedule-<mode>.out`. The run log itself stays in `data/_pipeline.log` (daily),
`data/_speed-cron.log` (speed) and `data/_hot.log` (hot).

**Permissions disclosure.** No one is present to answer a permission prompt, so unattended
`claude -p` calls run with `--dangerously-skip-permissions` unless you set `pipeline.claude_flags`.
`status` and `install` both print which applies.

**Cost.** `status` prints a rough worst case per day from the installed jobs, and the hard ceiling,
which is `pipeline.daily_claude_cap` (default 40) no matter how many jobs are installed. Once the cap
is hit, the remaining LLM lanes are skipped and the run exits 3.

### macOS (launchd)

Jobs are LaunchAgents in `~/Library/LaunchAgents/com.career-finder.<mode>.plist`
(`LimitLoadToSessionType Aqua`, `RunAtLoad false`), so they run inside your logged-in session,
which Chrome needs. A sleeping Mac runs a missed calendar job when it wakes. `schedule.mjs` only
touches labels that start with `com.career-finder`. Plists written by hand from older versions of this
doc (`com.careerfinder.*`) are reported and must be removed by hand before `install` will run, so the
pipeline never runs twice.

```bash
launchctl list | grep career-finder     # second column = last exit code
```

### Linux (crontab)

`install` writes a block between `# career-finder BEGIN` and `# career-finder END` in your crontab and
rewrites only that block, so your other lines are left alone. If a line outside the block already
runs `morning.mjs` (an older hand-written entry), `install` refuses and prints it. cron uses a minimal
environment; the generated lines set `PATH` themselves. Hot intervals that do not divide 60 restart
at the top of each hour.

Exit codes: `0` ok, `1` quota short or a lane failed, `2` setup problem, `3` deferred (usage wall or
daily cap).

## Windows (Task Scheduler, manual)

`schedule.mjs` does not automate Windows. PowerShell, run once:

```powershell
$repo   = "C:\path\to\career-finder"
$node   = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "scripts\morning.mjs --mode daily" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun
Register-ScheduledTask -TaskName "career-finder daily" -Action $action -Trigger $trigger -Settings $settings
```

Test with `Start-ScheduledTask -TaskName "career-finder daily"`, remove with
`Unregister-ScheduledTask -TaskName "career-finder daily"`. `-StartWhenAvailable` runs a missed
task when the machine wakes. Make sure `claude` is on the PATH of the user the task runs as.
