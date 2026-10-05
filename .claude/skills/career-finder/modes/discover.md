# Mode: discover — Company Discovery Agent + Recurring Pipeline

> Runs automatically in: daily (`discover` lane, §Headless only, plus the `discover-companies --yc` fan-in). Swarm and browser top-up are interactive only.

Grows `data/company-index.tsv` with companies in the configured area (the "company discovery agent"), then the recurring
pipeline scans + scores them. **Hybrid:** zero-token core (autonomous) + browser top-ups (local sessions).

## Pieces
- `scripts/discover-companies.mjs` — zero-token discovery: built-in curated ATS boards + `--from <file>`
  (merges an external `company\tcareers_url` list) + optional YC (`YC_ALGOLIA_KEY`). Runs `detectApi`, appends new
  rows to `company-index.tsv` (dedup). Reuses `scan-core.mjs`.
- `scripts/morning.mjs --mode daily` lanes `discover-companies` (merges `data/_discovered-companies.tsv`
  if present) and `ats:index` (`scan-index --hours N --out data/_candidates.tsv`).
- **Background company-finder agent** (`Agent` tool, a worker model): crawls the live web (YC, Built In (your metro),
  Levels.fyi, VC portfolios, general search) → appends `company\tcareers_url` to `data/_discovered-companies.tsv`.
- **Browser top-up** (this mode, local): drive playwright-stealth / chrome-devtools over LinkedIn company search,
  hiring.cafe, VC portfolio pages → append `company\tcareers_url` to `data/_discovered-companies.tsv`.
- **Scoring** (LLM): read `data/_candidates.tsv`, score each with the `offer` rubric (≥ qualify_score) using
  `cv.md`+`config/narrative.md`, append qualifiers to `data/qualifiers.tsv`, regenerate `data/qualifiers.md`.

## Recurring + escalation loop (strict 24h)
Two layers:
1. **Autonomous core (scheduled daily run):** `node scripts/morning.mjs` (installed by `scripts/schedule.mjs`,
   launchd on macOS, crontab on Linux) runs the `discover` lane (see §Headless), the ATS sweeps and headless scoring.
2. **In-session escalation `/loop` (browser):** when a run is **short of `pipeline.daily_quota` qualifiers**, escalate — open
   the browser and keep discovering NEW companies that posted in the **last 24h**, index them, re-sweep, score.
   **Never widen the window; expand companies instead.**

### Crawl swarm + iterate-until-found (ALWAYS grows the index)
Every `/career-finder discover` run launches the swarm — it always grows the index and hunts for ≥1 fresh qualifier.

Per pass:
1. **Launch 4 background `Agent`s in parallel** (cheaper worker model), each crawling a non-overlapping slice via
   WebSearch/WebFetch and appending verified `company<TAB>careers_url` to its OWN file `data/_swarm-{1..4}.tsv`
   (dedup vs `company-index.tsv`; verify each ATS slug resolves to a real board with ≥1 job):
   - swarm-1 **YC** (ycombinator.com/companies, workatastartup)
   - swarm-2 **VC portfolios** (a16z/Sequoia/Greylock/Accel) + Built In (your metro) + Levels.fyi
   - swarm-3 **ATS mining** (`site:` greenhouse/ashby/lever + hiring.cafe)
   - swarm-4 **fresh-24h roles** (Google Jobs / LinkedIn past-24h → company → board)
   - **Titles all slices hunt by name:** every entry in `targets.roles` (config/profile.yml). The wider
     `targets.title_keywords` allowlist still governs what is kept.
2. **Merge:** `cat data/_swarm-*.tsv >> data/_discovered-companies.tsv` then
   `node scripts/discover-companies.mjs --from data/_discovered-companies.tsv` (detectApi + index growth).
3. **Sweep + score:** `node scripts/scan-index.mjs --days 1 --out data/_candidates.tsv` → score with the `offer`
   rubric (verify each posted ≤24h) → append ≥ qualify_score to `data/qualifiers.tsv` AND record it in `data/scored-jobs.tsv`
   with a precise `found_at` via `node scripts/record-scored.mjs ...` (the dashboard Found panel reads scored-jobs,
   not qualifiers — finding 2026-06-16) → `prune-qualifiers.mjs` → `reconcile-qualifiers.mjs` (drop snippet false
   positives < qualify_score canonically, backfill orphan `found_at`) → `feedback-outcomes.mjs --learn`.
4. **If 0 NEW qualifiers → UPDATE THE PROCESS and re-launch** (this is "keep adding to the process till jobs found"):
   - bank a learning to `.claude/skills/career-finder/modes/scan-web.md` (what each slice yielded vs noise),
   - change the next pass's approach: **pass 2** widen titles (`targets.title_keywords` adjacent to the roles) + more VC lists; **pass 3** adjacent ATS (SmartRecruiters/Workable) + niche boards
     (role-specific boards for the target career, hiring.cafe deep); **pass 4–5** only-if-still-empty widen window 48→72h (those finds reported
     separately, NOT written to the strict-24h `qualifiers.tsv`).
   Repeat until **≥1 new qualifier** or **5 passes** (raise the cap on request); if still 0, report closest
   near-misses + learnings.

### Start the loop
`/loop /career-finder discover` (self-paced) or `/loop 6h /career-finder discover`. Runs the escalation in-session a few
times/day (browser available); the scheduled daily run (`morning.mjs`) covers strict-24h zero-token when no session is open.

## Results file (ask Claude for contents)
`data/qualifiers.tsv` — `date, company, role, score, why, url, source`. The user asks "what are my new
qualifiers?" → read it and summarize. `data/qualifiers.md` is the human-readable view.

## Filters carry over
`location` + `remote_policy` from the profile, `targets.*` title family, any seniority, dedup vs
scan-history/pipeline/applications, ≥ qualify_score `offer` bar. Discovery yield depends on each source's reachability;
the index grows every run ("keep adding to it").

## Outreach on qualify (eligible, not owed)
A job at or above `pipeline.qualify_score` is **eligible** for outreach, not owed. Do not draft outreach
from this mode, interactive or headless. The user picks jobs with `w` on the dashboard or
`node scripts/outreach-queue.mjs add`; drafting stays draft-only and sending is always the user's call.
`node scripts/outreach-owed.mjs` is a read-only "awaiting" view. Policy: `config/narrative.md` -> "Outreach on qualify".

## Headless

Loaded by the `discover` lane of `scripts/morning.mjs` (daily only, once a day). Only this section applies
there; the prompt supplies roles, area, the cap (25) and the output columns inline, and those override
anything above.

- WebSearch + WebFetch only. No browser MCP, no LinkedIn, no subagents, no swarm.
- Find NEW companies with a public ATS board (Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Workday)
  hiring the target roles. Skip boards already in `data/company-index.tsv` (column 3) or
  `data/_discovered-companies.tsv`, and anything in `data/_speed-noise.txt` or `data/_never-apply.txt`.
- Verify identity: an ATS can return 200 for a nonsense slug, so confirm the company name on the page.
- Append verified finds to `data/_discovered-companies.tsv` only (company, board URL). The fan-in
  (`discover-companies.mjs --yc`, `probe-ats`) indexes and sweeps them; this lane does not score.
- Never draft outreach. End with the one summary line the prompt asks for.
