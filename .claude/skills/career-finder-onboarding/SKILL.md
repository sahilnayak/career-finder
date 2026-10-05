---
name: career-finder-onboarding
description: First-run setup for career-finder. Takes the user's resume (PDF, DOCX or pasted text), converts it to cv.md, infers their function, seniority and 2-4 target roles, confirms them with the user, then writes config/profile.yml, config/narrative.md and portals.yml, seeds the company index for their role and metro, and finishes with a dry run of the morning pipeline. Use when cv.md, config/profile.yml, config/narrative.md or portals.yml is missing, when `targets.roles` is empty, when any script prints "run onboarding first", or when the user says "set me up", "here is my resume" or "change my target roles".
user_invocable: true
---

# career-finder onboarding

career-finder is role-agnostic. Nothing in the pipeline knows what job the user wants until this
skill writes it into `config/profile.yml`. Every scanner, filter, scorer, quota and outreach
template reads from that file (through `scripts/targets.mjs`). A sloppy onboarding produces a
pipeline that confidently searches for the wrong job, so take the time here.

## 0. Check state first (silently)

```bash
mkdir -p data config output reports
ls cv.md config/profile.yml config/narrative.md portals.yml 2>&1; [ -f modes/_profile.md ] && echo legacy-narrative-present; node scripts/targets.mjs 2>&1 | head -30
```

- All four exist and `targets.mjs` prints resolved blocks: setup is done. Only re-run the steps the
  user asked to change (for example "change my target roles" means steps 2-4 and 7).
- Anything missing, or `targets.mjs` says "run onboarding first": run the whole flow below, in order.
  Do NOT run evaluations, scans or any other mode until step 9 passes.

Never overwrite an existing `cv.md`, `config/profile.yml`, `config/narrative.md` or `portals.yml`
without showing the user what changes and getting a yes.

## 1. Ingest the resume -> `cv.md`

Ask for the resume if you do not have it: a file path (PDF, DOCX, TXT, MD), pasted text, or as a
last resort a description of their experience you draft from.

Convert by format:
- **PDF**: `pdftotext -layout <file> -` if available; otherwise read the PDF with the Read tool.
- **DOCX**: `pandoc <file> -t gfm` if available; otherwise `textutil -convert txt -stdout <file>`
  (macOS) or unzip `word/document.xml` and strip tags.
- **Text / Markdown / pasted**: use as-is.

Write `cv.md` as clean markdown: `# Full Name`, a contact line, then `## Summary`, `## Experience`
(one `### Title, Company (Mon YYYY - Mon YYYY)` per role with bullets), `## Projects` if any,
`## Education`, `## Skills`, plus certifications/publications if present.

Rules: keep every fact, metric and date exactly as written. Do not improve, round, merge or invent
anything. Fix only formatting. If dates or titles are ambiguous, ask.

## 2. Infer the profile (your analysis, before asking anything)

Read `cv.md` and work out, with the evidence line for each:

1. **Current function**: the job family they actually do today (e.g. data engineering, nursing,
   accounting, mechanical design, marketing operations, teaching). Judge by what the bullets
   describe, not just the title.
2. **Seniority**: entry / mid / senior / staff-lead / manager / director+. Note whether they manage
   people (direct reports named) or lead technically.
3. **Years of experience**: total, and in the current function. Note gaps neutrally; never comment on them.
4. **2-4 candidate target roles**, as the exact titles employers post. Include:
   - the natural next step in the current function (same family, same or next level up),
   - one or two adjacent roles the CV credibly supports (state the evidence),
   - optionally a stretch role, labelled as such.
5. For each role, **title_keywords** (other posted titles meaning the same job, e.g. for
   "Data Engineer": "analytics engineer", "data platform engineer", "etl developer") and
   **title_negatives** (titles that share words but are a different job or level, e.g. "intern",
   "director", "sales"). Add the **inverted forms** employers also post ("Engineer, Data",
   "Manager, Product", "Nurse, Registered (RN)") to title_keywords so a comma-first title still
   matches. Use a leading `!` for a hard negative that must ALWAYS drop the title even
   when a positive matches (e.g. `!intern`, `!vp`). A plain negative is cancelled when a positive is
   also present.

   **Generate real-world variants for EVERY role.** Titles match as token sets (any word order
   inside one comma segment, plus the comma-inverted form with up to two qualifier words between),
   but a keyword whose words land in different segments does NOT match. So
   "Senior Software Engineer, Data Platform" only counts as a data role if title_keywords include
   "data platform". For each role, list the forms employers actually post:
   - inverted forms: "Engineer, Data", "Software Engineer, Data", "Manager, Nursing";
   - qualifier forms: "RN, Assistant Manager", "Clinical Manager", "Assistant Nurse Manager";
   - specialty suffixes that should count: "data platform", "analytics platform";
   - licence/abbreviation forms: "RN", "CPA", "PE".
   Prefer short distinctive phrases over full titles.

   **Validate the keywords against a real sample before moving on.** After portals.yml and the
   index exist (steps 7-8), run:

   ```bash
   node scripts/scan-index.mjs --dry-run --explain
   node scripts/targets.mjs --test "<a real posted title>" "<location>"   # exit 1 = no match or dealbreaker
   ```

   Read the "Title-drop sample" (10 titles the filter rejected). If a dropped title is the user's
   job, add the missing variant to title_keywords; if matches are 0, iterate (add variants, re-run)
   until NEW candidates > 0 or the drop sample holds only genuinely-wrong jobs.
6. **Archetypes**: 2-4 named flavors of the target work (e.g. for a nurse: "ICU / critical care",
   "outpatient clinic", "clinical educator"), each with the CV evidence that supports it. These
   become `target_roles` in the profile and drive the archetype detection in `.claude/skills/career-finder/modes/_shared.md`.
7. **Proof points**: the 5-8 strongest achievements, each with its metric exactly as the CV states
   it. Flag the ones with no number; those are weaker in scoring and outreach.
8. **Skills and certifications** that employers in this field gate on (licences, clearances,
   languages, tools).

## 3. Present and confirm (the user decides)

Show the inference compactly: function, seniority, years, then a table of the candidate roles
(title | why the CV supports it | stretch?). Then use **AskUserQuestion**:

- Which roles to target (multi-select over your 2-4, plus "Other" for their own titles).
- Which one is PRIMARY (`targets.primary_role`; the daily quota requires at least
  `pipeline.primary_quota` of these).
- Seniority to target (same level / one up / open to a step down).

Then show the keyword and negative lists you derived for the chosen roles and ask them to add or
strike anything. Their edits win over your inference. If they name a role the CV does not support
well, say so plainly once with the reason, then respect their choice.

## 4. Location, policy and preferences

Ask (AskUserQuestion where the answer is a choice, free text otherwise):

- **Home base**: city, state/region, country. Then derive `metro`, `lat`, `lng` (look them up;
  state the values you used), and a `cities[]` list of nearby cities/suburbs that postings commonly
  name for that metro.
- **Commute radius** in miles (`radius_mi`, default 50).
- **Remote policy** (`remote_policy`): `onsite` (local only), `hybrid` (local onsite or hybrid,
  no fully remote), `remote-country` (local plus remote within their country), `any`.
- **LinkedIn geo ID** (optional): the `geoId=` value from a LinkedIn job-search URL for their metro.
  Tell them how to copy it; leave empty if they skip. Without it the LinkedIn lane cannot hard-filter
  by geography.
- **Compensation floor and target**, currency. Recorded for reports; comp is not a scoring factor
  unless the user says it should be (then write that rule into `config/narrative.md`).
- **Work authorization / sponsorship** need.
- **Timezone**: IANA name for their home base (e.g. `America/Chicago`) -> `location.timezone`.
  Used for the morning-run clock and posting-age math.
- **Years of experience** -> `candidate.years` (number, from step 2). Postings that require more
  than `candidate.years + pipeline.max_yoe_over` (default 2) are flagged as a stretch.
- **People management**: are they open to manager/lead/director titles? -> `targets.include_management`
  (default true only when a target role itself contains manager/director/lead/head).
- **Dealbreakers**: industries or company words they will not work in (e.g. "defense", "gambling",
  "tobacco") -> `targets.dealbreakers` (list; case-insensitive substring match on company + title).
  Non-keyword dealbreakers (on-call, travel, company size) go in `config/narrative.md`.
- **Never-apply list**: employers they will not apply to (current employer, past employers, others).
  Write one per line to `data/_never-apply.txt`, starting with this header:
  ```
  # Never-apply list. One employer per line, case-insensitive.
  # Entries come ONLY from an explicit user instruction. Never add one by inference.
  ```
- **Daily quota**: how many qualifying roles a morning should surface (`pipeline.daily_quota`,
  default 3) and the qualifying score (`pipeline.qualify_score`, default 4.3). Explain that a higher
  bar means fewer, better matches.

## 5. Write `config/profile.yml`

Start from `config/profile.example.yml` (it documents every field). The contract the scripts read:

```yaml
candidate: {full_name, email, phone, location, linkedin, portfolio_url, github, years}
targets:
  roles: []            # the confirmed role titles; also the search keywords
  title_keywords: []   # other titles meaning the same job
  title_negatives: []  # plain negatives; prefix "!" for hard negatives
  primary_role: ""     # one of roles; defaults to roles[0]
  seniority: ""
  include_management: false  # true if they will take manager/lead/director titles
  dealbreakers: []     # industry/company words; substring match on company + title
target_roles: ...      # archetypes, as in the example file
location:
  metro: ""
  city: ""
  state: ""
  country: ""
  lat: null
  lng: null
  radius_mi: 50
  linkedin_geo_id: ""
  remote_policy: onsite   # onsite | hybrid | remote-country | any
  timezone: ""            # IANA, e.g. America/Chicago
  cities: []
pipeline: {qualify_score: 4.3, daily_quota: 3, primary_quota: 1, window_hours: 24,
           scan_window_days: 7, hiringcafe_days: 7, max_yoe_over: 2}
integrations: {linkedin: true, linkedin_pages: 2, gmail: false}   # linkedin ON by default (step 9a); gmail opt-in
outreach:
  bridge: ""           # ONE sentence: who they are + tenure. No tool names or metrics the bullets carry
  default_bullets: []  # three proof bullets, each with a real number from cv.md
  sender_name: ""      # defaults to candidate.full_name
  sender_email: ""     # defaults to candidate.email
narrative: ...
compensation: ...
```

For `outreach.default_bullets`, pick three proof points that each map to a different core
requirement of the primary role (e.g. build, scale, collaborate), every one carrying a metric from
`cv.md`. The bridge must NOT repeat any tool, metric or employer a bullet already carries (the
generator fails a draft whose opener echoes a bullet); it carries only the arc and the tenure.
Show the bridge and bullets to the user and get approval; they are reused on every draft.

Validate:

```bash
node scripts/targets.mjs
node scripts/targets.mjs --test "<a real title for their primary role>" "<their city, state>"; echo "exit=$?"
node scripts/targets.mjs --test "<a title that should be rejected, e.g. Director of X>" "<their city>"; echo "exit=$?"
node scripts/targets.mjs --test "<their primary role>" "Remote"; echo "exit=$?"
```

Judge by the exit code, not the printed text: the first must exit 0, the second must exit 1
(exit 2 means the profile is not set up), and the remote case must exit 0 only if their
`remote_policy` allows remote. If anything is off, fix the keywords/negatives/cities and re-run.

## 6. Write `config/narrative.md`

If an older install left the narrative at `modes/_profile.md`, run `node scripts/doctor.mjs` to
move it here instead of rewriting it. Otherwise copy
`.claude/skills/career-finder/modes/_profile.template.md` to `config/narrative.md` if it does not exist, then fill it with: the archetypes and how
to recognise each in a JD, the framing/narrative per archetype, proof points (with metrics), the
location policy in words, dealbreakers, any scoring adjustments the user asked for, and the
"never say" list (things they do not want claimed). Everything user-specific goes here or in
`config/profile.yml`, never in `.claude/skills/career-finder/modes/_shared.md`.

## 7. Write `portals.yml` with role-appropriate seed companies

Copy `templates/portals.example.yml` -> `portals.yml`, then delete its header comment block
(everything above `title_filter:`, including the "EXAMPLE VALUES" note) and every `# EXAMPLE`
value, so the written file holds only the user's data. Then:

1. Set `title_filter.positive` to the roles + title_keywords and `title_filter.negative` to the
   negatives (without the `!` prefix).
2. Propose 20-40 employers that hire this role in their metro (or remotely in their country if
   policy allows). Think about who actually employs this function: hospitals for nurses, banks and
   audit firms for accountants, manufacturers for mechanical engineers, software companies for
   engineers. Do not default to tech startups unless the role is a tech role. Show the list; let the
   user add/remove.
3. Resolve each employer's ATS board without guessing slugs:

```bash
node scripts/probe-ats.mjs --names "Employer A,Employer B,Employer C"
```

   Only keep employers that resolve to a real board (the probe confirms it by counting postings).
   For the rest, find the careers page in a browser (see the `browser-automation` skill if
   installed) and record the URL; a careers page that is not a supported ATS is still useful for
   manual checks, but it will not be swept automatically. Never assume an HTTP 200 proves a board
   exists: SPA hosts return 200 for any slug.

   **Big employers that do not resolve** (hospital systems, banks, retailers, government, most
   Fortune 500) usually run Workday, Oracle (Taleo/ORC) or iCIMS, which the name probe cannot
   guess. For each one, ask the user for the careers URL or web-search "<employer> careers jobs",
   open the result, and copy the job-search URL (e.g. `https://<co>.wd5.myworkdayjobs.com/<site>`,
   `https://<host>.fa.<region>.oraclecloud.com/hcmUI/CandidateExperience/...`,
   `https://careers-<co>.icims.com/jobs`). Store it as `{company, careers_url}` in
   `discovery.seed_companies` (a plain `- Employer Name` string is accepted too, but needs a URL
   before it can be indexed), then probe from the URL rather than the name:

   ```bash
   node scripts/discover-companies.mjs --dry-run   # shows the detected ATS family per URL
   ```
4. Write resolved employers to `tracked_companies` (`name`, `careers_url`) and to
   `discovery.seed_companies` in `config/profile.yml`.
5. **Count the resolved boards. If fewer than 20 resolved, warn the user plainly**: the ATS sweep
   will be thin and most mornings will surface nothing from it. Offer to propose more employers.
   For non-tech careers (nursing, teaching, trades, finance, public sector...) most employers are
   not on Greenhouse/Ashby/Lever: tell them that **HiringCafe is their main lane** (and LinkedIn,
   which is on by default, step 9a), and the ATS sweep is a supplement.

## 8. Seed the company index

```bash
node scripts/build-company-index.mjs
node scripts/discover-companies.mjs            # add --yc only for startup-heavy tech roles
node scripts/probe-ats.mjs --from-ledger --append   # later, once some jobs are scored
```

Report how many boards the index holds and by ATS family. Under ~50 boards the morning run will be
thin; say so and offer to add more employers (step 7.2) or run the `discover` mode.

## 9. Optional integrations (ask, one at a time; each can be skipped)

- **LinkedIn job lanes (ON by default; see step 9a).** Skip only if the user explicitly declines;
  then set `integrations.linkedin: false` and say the ATS lanes still run.
- **Gmail job alerts**: the email-alert lane reads LinkedIn job-alert emails read-only. Requires
  the Gmail MCP. Set `integrations.gmail: true` ONLY if they opt in and the MCP is configured.
- **Scheduler**: the daily run on a timer (macOS launchd, Linux crontab; Windows is manual, see
  `docs/SCHEDULING.md`). Install only with explicit consent. First show the exact job definition with
  `npm run schedule -- --print`, ask what time the daily run should fire (write it to
  `schedule.daily_time` in `config/profile.yml`, default `07:00`), and say plainly that unattended
  runs use `--dangerously-skip-permissions` unless `pipeline.claude_flags` is set, and that
  `pipeline.daily_claude_cap` (default 40) bounds the calls per day. Then run
  `npm run schedule -- install`. Daily only by default; offer `--with-speed N` (2-4/day) and
  `--with-hot` (every 60 min; needs `node scripts/hot-list.mjs --build` first) only if they ask for
  faster pickup. Finish with `npm run schedule -- status`.

## 9a. LinkedIn job lanes (default ON)

What it does, said plainly to the user: every morning the pipeline reads LinkedIn **job search
results** posted in the **last 24 hours** for each of the first 4 `targets.roles` (primary first),
three ways per role:

1. **crawl** (`linkedin-crawl.mjs`): `/jobs/search-results/?keywords=K&f_TPR=r86400&geoId=G&sortBy=DD`,
   paged up to `integrations.linkedin_pages`.
2. **faceted** (`linkedin-jobsearch.mjs --form faceted`): `?keywords=K&geoId=G&f_TPR=r86400`.
3. **semantic** (`linkedin-jobsearch.mjs --form semantic`):
   `?keywords="K posted in the past 24 hours"&origin=SEMANTIC_SEARCH_LANDING_PAGE`.

At most 4 roles x 3 = 12 searches a day. Every card is filtered (noise blocklist, title, location,
dealbreakers) and resolved to the employer's ATS before scoring; LinkedIn's dates are claims.

Steps, in order, one at a time:

1. `npm run linkedin:login` opens the dedicated debug Chrome (separate profile, port 9222). Ask
   the user to log into LinkedIn once in that window and say "done". Never type their password.
2. Verify the login: the same command (or `npm run doctor`) must report LinkedIn `ok`. If it shows
   an authwall or checkpoint, have them finish the login in that window and re-check. Do not move on
   while it says `not logged in`.
3. Resolve the geo: run `node scripts/li-geo.mjs resolve` (looks the metro geoId up and caches it), then `node scripts/li-geo.mjs show` (prints the resolved `geoId=` or the
   `location=` text fallback the lanes will use), or read the `geoId=` from a LinkedIn jobs URL the
   user searched for their metro) and write it to `location.linkedin_geo_id`. If it cannot be
   resolved, leave it blank: the lanes fall back to `location=City, ST, Country` text. Say so.
4. `npm run linkedin:test` runs ONE faceted 24h search for the primary role and prints the URL and
   card count. Require **> 0 cards**. If 0: check the logged URL carries `f_TPR=r86400` and the
   right geo, try the second role, and if a broad role in a real metro still returns 0, report
   the lane as not working, with the reason. Never mark it working on 0 cards.
5. Leave `integrations.linkedin: true` and `integrations.linkedin_pages: 2` unless they ask.

Safety rules to tell the user (and to follow):
- Jobs pages only. No profile visits, people search, connects or messages from any lane.
- Every action goes through `scripts/li-budget.mjs` (daily caps, jittered pacing). A checkpoint or
  CAPTCHA aborts the run for the day.
- Kill switch: `npm run linkedin:off` creates `data/LINKEDIN_OFF` and every LinkedIn lane refuses to
  run; `npm run linkedin:on` removes it.
- If the user logs out or Chrome cannot start, the morning summary lists `linkedin` under FAILED
  LANES with the fix (`npm run linkedin:login`). It is never skipped silently.
- macOS: Chrome needs a logged-in GUI session, so the scheduled run must fire while the user is
  logged in (see `docs/SCHEDULING.md`).

## 10. Prove it works

```bash
mkdir -p data && [ -f data/applications.md ] || printf '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n' > data/applications.md
npm run doctor
npm run morning:dry
```

`morning:dry` runs every lane without writing to the ledgers or spending LLM tokens. Read its
summary and report the ACTUAL numbers it printed, never estimates: boards swept, postings
fetched, postings that matched their titles and location, per-lane counts, and any lane that failed (a failed lane is not a quiet market). If zero
titles matched, the keywords are wrong: go back to step 3 rather than declaring success.

Then finish with:

> Setup is done. Paste a job URL to evaluate it, run `/career-finder scan` to search now, or
> `/career-finder` to see every command. Everything here is editable; tell me to change your
> roles, cities or quota at any time.

## After onboarding: keep learning

When the user corrects a score ("I would never take this", "you missed that I know X"), write the
lesson into `config/narrative.md` or `config/profile.yml` (targets, negatives, dealbreakers). A
workflow change the user asks for is a standing rule: persist it, do not apply it once.

## Ethics (always)

Never submit an application or send a message. Draft, fill and prepare; the user clicks Submit.
Never invent experience, metrics or credentials in any artifact. Recommend against applying below
the qualifying score.
