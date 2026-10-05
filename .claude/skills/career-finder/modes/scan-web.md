# Mode: scan-web — Scored Browser Web Comb (self-improving)

> Runs automatically in: daily (`websearch` lane, §Headless only). The browser comb is interactive only.

Browses the open web with real browsers (in parallel), **scores every find with the `offer` A–F rubric**,
keeps only **score ≥ {THRESHOLD}** (default `pipeline.qualify_score`), and stops when **{TARGET}** (default `pipeline.daily_quota`) qualifiers
are found. If a pass yields fewer, it **banks a learning, refines itself, and re-combs** — getting leaner each
iteration. List-only output (no `pipeline.md` / `scan-history.tsv` writes unless asked).

## Parameters (override per run)
| Param | Default |
|-------|---------|
| TARGET | `pipeline.daily_quota` qualifiers |
| THRESHOLD | `pipeline.qualify_score` |
| MAX_ITERATIONS | 3 (then report finalists + learnings and ask how to proceed) |
| RECENCY | `pipeline.window_hours` |
| LOCATION | `location` block + `remote_policy` (via `locationMatches()`) |
| TITLES | `targets.roles` + `targets.title_keywords` |
| SENIORITY | `targets.seniority` (any if blank) |

## Subagent fan-out for web search

**In an interactive session, parallelize the comb with subagents — one per source-slice.** Spawn `general-purpose` subagents (a cheaper worker model) that each own a slice and run concurrently, then fan in their results:
- Slice A: Google Jobs / general web. Slice B: startup and niche boards relevant to the target career (Wellfound, YC work-at-a-startup, Built In, role-specific boards). Slice C: company career pages + ATS boards (`site:` Greenhouse/Ashby/Lever + the ATS JSON APIs). Slice D (optional): LinkedIn + Indeed.
- Each subagent uses WebSearch + WebFetch only (no browser MCP — keep browser work on the main agent), applies the §Learnings pre-filters (location/remote policy, off-archetype, no staffing/anonymized via `loadNoise()`), resolves to the canonical ATS posting, and **returns a fenced `tsv` block** (`company<TAB>role<TAB>location<TAB>posted<TAB>canonical_url<TAB>source`) — it does not write files (avoids parallel-write races).
- Main agent fans in: concatenate the tsv, dedup vs `scored-jobs.tsv`, then score + qualify as below.

The **headless `websearch` lane in `scripts/morning.mjs`** (see §Headless) cannot fan out subagents (`claude -p` pipe mode has no Agent tool), so it uses a single web-search agent there; the subagent fan-out above is the interactive-session accelerator.

## The loop
1. **Comb** (§Sources) — gather candidates with each site's native 24h filter, parallel tabs.
2. **Pre-filter (cheap, learnings-driven)** — apply title/location/dedup **plus the deprioritize rules in
   §Learnings BEFORE scoring**, so the expensive `offer` rubric runs only on plausible contenders. This is
   the main efficiency lever and it tightens every iteration.
3. **Score with the `offer` rubric** — for each survivor pull the JD (LinkedIn JSON-LD `description`, or open
   the posting), then score /5 per `.claude/skills/career-finder/modes/offer.md` + `.claude/skills/career-finder/modes/_shared.md` against `cv.md` + `config/narrative.md`:
   CV match · North Star (archetypes from `config/narrative.md`) · Comp vs `compensation` in the profile · Cultural signals · Red flags. Use the
   offer-mode **location override** (the comb already validated location — don't re-reject).
   Generate the full A–G report only for qualifiers (or on request) — in the loop, compute the score + a
   one-line why.
4. **Keep ≥ THRESHOLD.** Maintain a running qualifier count, deduped across iterations.
5. **If qualifiers < TARGET and iteration < MAX_ITERATIONS:** append ONE new dated learning to §Learnings
   that changes step 2 or §Sources (drop a low-yield query, add a high-yield one, tighten a negative,
   prioritize a company pattern), then **re-comb** with fresh queries / pagination / new sources. Repeat.
6. **Stop** at TARGET qualifiers or MAX_ITERATIONS. Output.

## Browser setup (two backends in parallel)
- **playwright-stealth MCP** — primary. LinkedIn **guest** job API needs no login (see §Sources), plus
  boards/aggregators. Open multiple tabs, navigate in parallel batches.
- **chrome-devtools MCP** attached to a logged-in Chrome — only to unlock LinkedIn's *logged-in* coverage
  (more results than guest). Needs a dedicated `--user-data-dir` Chrome on `--remote-debugging-port=9222`,
  logged into LinkedIn once (Chrome 136+ blocks the port on the default profile). If down, skip and flag.

## Sources (parallel; native recency filter) — priority order from §Learnings
For each title in `targets.roles`, with `{AREA}` = `location.metro` (or `city, state`) and
`{GEO}` = `location.linkedin_geo_id`:

1. **LinkedIn guest API** (job listings only, no login):
   `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=<title>&location=<AREA>&geoId=<GEO>&f_TPR=r86400&start=0`
   Extract per `<li>`: `.base-search-card__title`, `.base-search-card__subtitle`, `.job-search-card__location`,
   `a.base-card__full-link` href, `time[datetime]`. Paginate with `start=10,20,…`.
   JD + liveness: open `/jobs/view/{id}` and read the `application/ld+json` JobPosting.
2. **Google Jobs** — `<title> <AREA>` → Jobs → "Date posted: Today".
3. **Startup / niche boards** — Wellfound, Built In (your metro), YC work-at-a-startup, plus any
   boards specific to the target career listed in `config/narrative.md`.
4. **Indeed** — `q=<title>&l=<AREA>&fromage=1` (bot-walled; stealth browser).
5. ATS boards (Ashby/Greenhouse/Lever) via `site:` — overflow only.

If `remote_policy` allows remote, also run each title with the country as location.

## Output (list only)
Per iteration log: `combed N → pre-filtered M → scored M → kept K (≥THRESHOLD)`.
Final qualifiers table: `# | Company | Role | Location | Posted | Score | why (1 line) | Link`.
Then: learnings added this run + offer to generate full A–G reports / drop qualifiers into `pipeline.md`.

## Learnings
Learnings are user data and live in `data/scan-web-learnings.md` (append-only, newest first; created
on first write). Read it before step 2; each iteration prepends ONE dated line there, never here.

## LinkedIn coverage — guest API is NOT full coverage

The unauthenticated `jobs-guest` API (used by `speed-linkedin.mjs`) returns a subset of what
LinkedIn lists. The logged-in job search (`scripts/linkedin-jobsearch.mjs`) sees far more; treat
guest results as a cheap pre-filter.

**LinkedIn dates are re-promotion timestamps.** Per the Posting Age rule in `CLAUDE.md`, a
LinkedIn-nominated role is not rejected for an old ATS date -- but the employer ATS must still be
resolved for existence, the canonical JD, the real location and comp. Record the real ATS age in
the report.

Employers with no Greenhouse/Ashby/Lever board only appear via this lane; resolve their own
careers page or board API.

Pacing: charge the `search` budget in `li-budget.mjs` per query, scroll before extracting, stay
on result pages 1–2. Job listings only -- never people search from a scan.

## Headless

Loaded by the `websearch` lane of `scripts/morning.mjs` (daily only). Only this section applies there;
the prompt supplies roles, window, location rule and the TSV column contract inline, and those override
anything above.

- WebSearch + WebFetch only. No browser MCP, no LinkedIn (logged-in or guest), no subagents.
- If `data/web-search-learnings.md` exists, read it first and follow its playbook.
- Resolve every find to the employer's own ATS posting; drop anything without one, staffing agencies,
  aggregator relists, and employers in `data/_speed-noise.txt` or `data/_never-apply.txt`.
- Skip urls already in `data/scored-jobs.tsv` or `data/_web-roles.tsv`.
- Append finds to `data/_web-roles.tsv` only, then run `node scripts/web-roles.mjs --clean`.
- Never score, never draft outreach, never write reports here. End with the one summary line the prompt asks for.
