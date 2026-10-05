# Career-Finder -- AI Job Search Pipeline

Career-Finder is a role-agnostic job-search pipeline built on Claude Code. A user hands Claude their
resume; onboarding infers the target roles and location (the user confirms them); from then on the
whole pipeline -- ATS scans, aggregator lanes, scoring and reports, tracker, outreach drafts,
interview prep, dashboard and the morning run -- works for THAT career.

Nothing in the system layer assumes a particular role, industry or city. Every role, keyword,
location, threshold and quota is read from `config/profile.yml` through `scripts/targets.mjs`.

## Language

Everything you generate is written in English unless the user targets a non-English posting and
has set `language.modes_dir` in `config/profile.yml` (then use `modes/{de,fr,ja,pt,ru}/`), or asks
for another language explicitly. Do not translate user-layer files unless asked.

## First Run -- Onboarding (CRITICAL)

If `cv.md`, `config/profile.yml`, `modes/_profile.md` or `portals.yml` is missing, or
`targets.roles` in the profile is empty, the system is not set up: **stop and run the
`career-finder-onboarding` skill before any evaluation, scan or other mode.**

Onboarding, in order:

1. Ingest the resume (paste, file, or PDF) into `cv.md`.
2. Infer 2-5 target role titles, title keywords, negatives, seniority and a primary role from the
   resume. **Propose them and have the user confirm or edit**; never assume the career is the one
   any example in this repo shows.
3. Ask for location: metro/city/state/country, radius, remote policy
   (`onsite | hybrid | remote-country | any`). Fill `lat`/`lng` and `linkedin_geo_id` when known.
4. Write `config/profile.yml` (copy from `config/profile.example.yml`), `modes/_profile.md` (from
   `modes/_profile.template.md`) and `portals.yml` (from `templates/portals.example.yml`, with
   companies relevant to the confirmed roles and location).
5. Verify with `node scripts/targets.mjs` and `node scripts/targets.mjs --test "<title>" "<loc>"`.

Scripts that need the profile fail with a "run onboarding first" message when it is missing; that
message means go back to step 1, not that a script is broken.

### Config contract (`config/profile.yml`)

```yaml
targets:  {roles: [], title_keywords: [], title_negatives: [], primary_role: "", seniority: ""}
location: {metro: "", city: "", state: "", country: "", lat: null, lng: null, radius_mi: 50,
           linkedin_geo_id: "", remote_policy: "onsite|hybrid|remote-country|any", cities: []}
pipeline: {qualify_score: 4.3, daily_quota: 3, primary_quota: 1, window_hours: 24}
outreach: {bridge: "", default_bullets: [], sender_name: "", sender_email: ""}
```

Hard negatives in `title_negatives` carry a leading `!` and always drop a title; plain negatives
are cancelled by a matching positive keyword.

## Data Contract (CRITICAL)

Two layers. See `DATA_CONTRACT.md` for the full list.

**User layer (never auto-updated, personalization goes HERE):** `cv.md`, `config/profile.yml`,
`modes/_profile.md`, `article-digest.md`, `portals.yml`, `data/*`, `reports/*`, `output/*`,
`interview-prep/*`.

**System layer (auto-updatable, no user data):** `modes/_shared.md` and all other modes,
`CLAUDE.md`, `scripts/*.mjs`, `dashboard/*`, `templates/*`, `batch/*`.

**When the user asks to customize anything (archetypes, narrative, scripts, proof points, location
policy, comp targets), write to `modes/_profile.md` or `config/profile.yml`. Never put user-specific
content in `modes/_shared.md` or a script.**

## Workflow Rules

When asked to make a workflow change, treat it as a standing rule: apply it to the artifact at hand
AND persist it where future runs will read it (`modes/_profile.md`, `config/profile.yml`, or the
relevant mode file). Say where you put it.

## Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate an offer | `offer` |
| Asks to compare offers | `offers` |
| Wants LinkedIn outreach | `contact` |
| Pastes JD + contact URLs (HM/Recruiter/Peer/Leader) | `outreach` |
| Asks for company research | `deep` |
| Preps for an interview | `interview-prep` |
| Wants a CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates a portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out an application form | `apply` |
| Searches for new offers | `scan` |
| Wants a browser web comb for fresh roles (last 24h, list only) | `scan-web` |
| Wants a zero-token sweep of the company index (ATS APIs) | `scan-index` |
| Wants to grow the company index or run scan -> score | `discover` |
| Wants to orchestrate parallel discovery | `orchestrator` |
| Wants speed-to-lead on the freshest qualifying roles | `speed` |
| Wants qualified jobs (score >= `pipeline.qualify_score`) | `qualifiers` |
| Wants all scored jobs | `scored` |
| Wants one catalog of every job | `catalog` |
| Wants to track outcomes | `feedback` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns | `patterns` |
| Asks about follow-ups | `followup` |
| Wants the dashboard / TUI | `dashboard` |

OpenCode commands live in `.opencode/commands/career-finder-<mode>.md`; each maps to
`/career-finder <mode>`. All of them invoke `.claude/skills/career-finder/SKILL.md`.

**Dashboard rule:** the dashboard shows only jobs found in the last `pipeline.window_hours`. An
empty board stays empty; never backfill older finds to fill it.

### Archetypes

Role archetypes, proof points and narrative are user data and live in `modes/_profile.md`. Modes
must read archetypes from there; they never hard-code a career.

### CV Source of Truth

`cv.md` is the canonical CV; `article-digest.md` holds optional detailed proof points. **Never
hardcode metrics** -- read them from these files at evaluation time.

## Main Files -- the non-obvious contracts

| File | Contract |
|------|----------|
| `reports/` | `{###}-{company-slug}-{YYYY-MM-DD}.md`. Blocks A-F **+ G (Posting Legitimacy)**; the header carries `**URL:**` and `**Legitimacy:** {tier}`. Numbering is sequential, 3-digit zero-padded, max existing + 1. |
| `scripts/targets.mjs` | The only source of roles, keywords, location and pipeline thresholds. Every CLI entry point calls `requireTargets()` first. |
| `scripts/role-filters.mjs` | Title/location filters derived from `targets.mjs`; `loadNoise()` blocklist. |
| `scripts/liveness-core.mjs` | An expired signal beats generic "Apply" text; do not invert that precedence. |
| `scripts/scan.mjs` | Hits Greenhouse/Ashby/Lever APIs directly. **Zero LLM cost** -- never replace it with an agent pass. |
| `scripts/hiringcafe-scan.mjs` | Plain GET of server-rendered results centred on `location.lat/lng/radius_mi`, keyed by `targets.roles`. Dates are aggregator claims and are ATS-verified downstream. |
| `scripts/linkedin-crawl.mjs` | Lane 1 of 3: paged `/jobs/search-results/?keywords=K&f_TPR=r86400&geoId=G&sortBy=DD`, up to `integrations.linkedin_pages` pages. Job listings only. |
| `scripts/linkedin-jobsearch.mjs` | Lanes 2-3: `faceted` (`geoId` + `f_TPR=r86400`) and `semantic` (`"K posted in the past 24 hours"`, `origin=SEMANTIC_SEARCH_LANDING_PAGE`); `--form` runs one. Max 4 roles x 3 searches = 12/day. Job listings only. |
| `scripts/li-budget.mjs` | The one LinkedIn action counter (daily caps + jittered delays). Works standalone; an external `pace.mjs` is opt-in via `CAREER_FINDER_PACE`. Never add a second counter. |
| `scripts/scan-core.mjs` | ATS families swept: Greenhouse, Ashby, Lever, Workday (paginated past 40), SmartRecruiters, Workable, Rippling, Recruitee, BambooHR, Teamtailor, plus iCIMS and Oracle HCM/Taleo. A detected-but-unparsed family is logged as `unsupported family`, never dropped silently. Big employers the name probe cannot guess (Workday/Oracle/iCIMS) need a `careers_url` in `discovery.seed_companies`. |
| `data/_speed-noise.txt` | Shared staffing/aggregator blocklist. **Any lane that names an employer must filter through `loadNoise()`.** |
| `data/pipeline.md` | Inbox of pending URLs; JDs referenced as `local:data/jds/{file}`. |
| `article-digest.md` | Optional. Absent is normal. |

## Browser Automation

For bot-walled or JS-rendered pages use a real browser, not WebFetch/WebSearch. Launch a separate
Chrome profile (`--user-data-dir`, `--remote-debugging-port=9222`; see `scripts/chrome-debug.mjs`)
-- Chrome 136+ blocks the debug port on the default profile. Verify the profile is logged into
LinkedIn before using any logged-in lane.

**Scripts drive the browser over raw CDP, not Playwright.** Use `scripts/cdp.mjs` (`cdpAlive`,
`newPage` -> `navigate`/`evaluate`/`close`) for anything that runs from cron: it uses only
Page/Runtime/Network plus Node's global `WebSocket`, has no dependencies, and cannot drift with a
Chrome release. Chrome DevTools MCP is fine for interactive agent work, but MCP tools do not exist
in `claude -p` headless mode.

### LinkedIn job lanes (default ON)

`integrations.linkedin: true` is the default. Each morning run starts the debug Chrome if :9222 is
down, checks the login over `cdp.mjs`, then runs crawl, faceted and semantic (past 24h,
`f_TPR=r86400`) for the first 4 `targets.roles`, serially. Rules:

- **Jobs pages only.** No profile visits, people search, connects or DMs from any lane or agent.
- **Logged out or Chrome down = FAILED lane**, named in the morning summary with the fix
  `npm run linkedin:login`. Never a silent skip; a dead lane and a quiet market look identical.
- **Budget:** every action is charged through `li-budget.mjs`; checkpoint/CAPTCHA aborts the run.
- **Kill switch:** `npm run linkedin:off` / `on` toggles `data/LINKEDIN_OFF`, honored by every lane.
- **Rows** go to `data/_web-roles.tsv` / `data/_speed-li.json` through `loadNoise()`, the title,
  location and dealbreaker filters, then resolve to the ATS (Apply href) before scoring.
- Commands: `npm run linkedin:login` (open Chrome, log in once, verify), `npm run linkedin:test`
  (one faceted 24h search, prints URL + card count; must be > 0).
- Never fan LinkedIn work out to parallel agents.

## Offer Verification -- MANDATORY

Never trust WebSearch/WebFetch to say an offer is still active. Load it in a real browser
(navigate, snapshot; only footer/navbar without JD = closed; title + description + Apply = active).
**Interactive sessions with no browser available** (no Chrome DevTools MCP, no debug Chrome):
check liveness against the ATS's own JSON API with `node scripts/check-liveness.mjs <url>`
(Greenhouse/Ashby/Lever postings resolve to a live/expired verdict; exit 0 = active), and mark the
report `**Verification:** api-confirmed`. A posting not on a supported ATS stays
`**Verification:** unconfirmed` until a browser or the user confirms it.
**Batch workers (`claude -p`)** have no browser: use WebFetch and mark the report
`**Verification:** unconfirmed (batch mode)`.

## Posting Age -- the ATS date is NOT a freshness gate on nomination lanes

A role surfaced by LinkedIn or HiringCafe is one the employer is actively re-promoting; the ATS
`publishedAt` records when the requisition was created, not whether they want applicants today.

**Applies to:** `linkedin-crawl.mjs`, `linkedin-jobsearch.mjs`, `linkedin-email-alerts.mjs`,
`hiringcafe-scan.mjs`. **Does not apply to `scan-index.mjs`**, where the ATS date is the primary
source and the window is what makes it a speed lane.

The ATS is still resolved every time. It is the only source for: (1) the req exists and is open --
404 or expired is a hard reject; (2) the canonical JD to score against (never score a snippet);
(3) the real location; (4) comp and any tenure gate. `stale` means one thing: the posting is gone.
Record the real age in the report (it moves the legitimacy tier); it is not a scoring penalty.

## Outreach

Outreach is **draft-only**. Nothing is ever sent, connected or submitted without the user. Email
and LinkedIn templates read `outreach.bridge`, `outreach.default_bullets`, `outreach.sender_name`
and `outreach.sender_email` from the profile. Keep emails short (two short paragraphs before
bullets), LinkedIn notes under 300 characters, and every claim traceable to `cv.md`.

## Ethical Use -- CRITICAL

- **Never submit an application without the user reviewing it.** Fill forms, draft answers,
  generate PDFs, then STOP before Submit/Send/Apply.
- **Discourage low-fit applications.** Below 4.0/5, recommend against applying unless the user has
  a specific reason.
- Quality over volume; respect recruiters' time.

## Token Discipline

Turn count drives cost: every turn re-processes the whole context.

- Batch related shell checks into one call; pipe long output through `| tail -20`.
- Never re-read a file you just edited. Use `Read` with `offset`/`limit` on large files.
- Use `--quiet` / `CAREER_FINDER_QUIET=1` on noisy scripts unless debugging them.
- Compact at 60-70% context, not at the wall.
- A subagent's real cost is invisible from what it returns; do not justify a swarm by context
  percentage. Use cheaper models for fan-out work and keep judgment in the main agent.

## Update Check

`node scripts/update-system.mjs check` reports `update-available | up-to-date | dismissed |
offline`. Only speak up on `update-available`, and only apply after the user agrees. User data is
never touched by an update.

## Conventions

- After each batch of evaluations run `node scripts/merge-tracker.mjs`.
- Never create a new `data/applications.md` entry if company+role already exists; update it.
- `output/` and `batch/` are gitignored (except batch scripts + prompt).
- Scripts read data paths relative to the repo root; run them from there.

### TSV Format for Tracker Additions

One file per evaluation: `batch/tracker-additions/{num}-{company-slug}.tsv`, single line,
9 tab-separated columns, **status before score**:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

In `applications.md` score comes before status; `merge-tracker.mjs` swaps them.

### Pipeline Integrity

1. Never edit `applications.md` to ADD entries -- write a TSV and merge.
2. You may edit `applications.md` to UPDATE status/notes.
3. Every report includes `**URL:**` (between Score and PDF) and `**Legitimacy:** {tier}`.
4. Statuses must be canonical (`templates/states.yml`).
5. Health: `node scripts/verify-pipeline.mjs`; normalize: `node scripts/normalize-statuses.mjs`;
   dedup: `node scripts/dedup-tracker.mjs`.

### Canonical States

| State | When |
|-------|------|
| `Evaluated` | Report done, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

No bold, dates or extra text in the status field.

## Credits

Forked from [career-ops](https://github.com/santifer/career-ops) by santifer (MIT). See `LICENSE`.
