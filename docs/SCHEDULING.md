# Scheduling the morning run

The daily pipeline is one Node script, `scripts/morning.mjs`. It changes into the repo root on its own,
so a scheduler only has to call `node /path/to/career-finder/scripts/morning.mjs`.

```bash
npm run morning:dry     # preview: which lanes will run, which are skipped and why
npm run morning         # full daily run
node scripts/morning.mjs --mode speed   # optional hourly top-up (12h ATS sweep + scoring)
node scripts/morning.mjs --mode hot     # optional 5-minute sweep of data/hot-companies.tsv
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
Models: `pipeline.scoring_model` (default `sonnet`) and `pipeline.report_model` (default `opus`).

Logs: `data/_pipeline.log` (daily), `data/_speed-cron.log` (speed), `data/_hot.log` (hot).
Pause everything: `touch data/PIPELINE_OFF`. Resume: delete that file.

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
when port 9222 is down; to start it earlier yourself, add `node scripts/chrome-debug.mjs start &&`
in front of the cron line below. On Linux cron, set `DISPLAY` or the LinkedIn lane fails with
"Chrome down".

## macOS (launchd)

Save as `~/Library/LaunchAgents/com.careerfinder.morning.plist`, replacing `/Users/YOU/...` and the
node path (`which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.careerfinder.morning</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/Projects/career-finder/scripts/morning.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Projects/career-finder</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd starts with a bare PATH; include where node, claude and go live -->
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/Users/YOU/.local/bin:/usr/bin:/bin</string>
  </dict>
  <!-- LaunchAgent = runs in your logged-in GUI session, which Chrome (LinkedIn lanes) needs -->
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/YOU/Projects/career-finder/data/_launchd.out</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Projects/career-finder/data/_launchd.err</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.careerfinder.morning.plist
launchctl start com.careerfinder.morning        # run once now to test
launchctl list | grep careerfinder              # second column = last exit code
launchctl unload -w ~/Library/LaunchAgents/com.careerfinder.morning.plist   # disable
```

For the optional hourly speed run, copy the plist with Label `com.careerfinder.speed`, add
`<string>--mode</string><string>speed</string>` to `ProgramArguments`, and replace
`StartCalendarInterval` with `<key>StartInterval</key><integer>3600</integer>`.

## Linux / macOS (cron)

`crontab -e`:

```cron
PATH=/usr/local/bin:/usr/bin:/bin:/home/YOU/.local/bin
# daily at 07:00
0 7 * * *  cd /home/YOU/career-finder && (node scripts/chrome-debug.mjs start; node scripts/morning.mjs) >> data/_cron.out 2>&1
# optional: hourly speed run, 09:00-18:00 on weekdays
0 9-18 * * 1-5  cd /home/YOU/career-finder && node scripts/morning.mjs --mode speed >> data/_cron.out 2>&1
```

cron uses a minimal environment, so set `PATH` as above (`which node claude`).

## Windows (Task Scheduler)

PowerShell, run once:

```powershell
$repo   = "C:\Users\YOU\career-finder"
$node   = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "scripts\morning.mjs" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun
Register-ScheduledTask -TaskName "career-finder morning" -Action $action -Trigger $trigger -Settings $settings
```

Test with `Start-ScheduledTask -TaskName "career-finder morning"`, remove with
`Unregister-ScheduledTask -TaskName "career-finder morning"`. `-StartWhenAvailable` runs a missed
task when the machine wakes. Make sure `claude` is on the PATH of the user the task runs as.

## Shell wrappers

`scripts/pipeline-cron.sh`, `scripts/speed-cron.sh` and `scripts/hot-cron.sh` are three-line
wrappers around `morning.mjs --mode daily|speed|hot`, for schedulers that prefer a shell entry point.
