# Mode: scan — Portal Scanner (Offer Discovery)

> Runs automatically in: daily (`scan`, hiringcafe, workable, browser-boards, probe-ats, resolve-nominations, web-roles clean/archive/learn).

Scans configured job portals, filters by title relevance, and adds new offers to the pipeline for later evaluation.

## Default filters (apply BEFORE the scan loop runs)

These defaults run on every `scan` invocation unless the user explicitly overrides them. Implement and verify them BEFORE the scan loop starts — never as a post-hoc filter on a raw run.

| Filter | Default | Source |
|--------|---------|--------|
| Recency | Last `pipeline.scan_window_days` days (default 7), bucketed in `location.timezone`; `--days 1` = today only | Posted date from API payload or page snapshot. If the source doesn't expose a posted date, include it and flag `posted: unknown` in the pipeline entry. |
| Location | `location` block of `config/profile.yml` | Keep a posting only if `locationMatches()` in `scripts/targets.mjs` accepts it: local to `location.city`/`metro`/`cities[]`, or remote when `location.remote_policy` allows it. |
| Roles | `targets.roles` + `targets.title_keywords` (negatives from `targets.title_negatives`), via `titleMatches()` in `scripts/targets.mjs` | `config/profile.yml` |

**Sanity check (mandatory):** After each level (1, 2, 3) and after the merged dedup, log `raw_count → filtered_count` per filter step in the output summary. If `filtered_count == 0` while `raw_count > 0`, surface it explicitly — a 0-result scan is almost always an over-strict filter or a date-parse bug, not a real "nothing posted today."

**First scan: use a wider window.** The first run has nothing deduped yet and a fresh index may be thin, so run `node scripts/scan.mjs --days 30` (and `node scripts/scan-index.mjs --days 30`) once to build up the pipeline, then fall back to the default window. If the scan prints `coverage low: run onboarding step 7/8`, the company index has fewer than 30 boards: grow it before trusting an empty result. Dealbreakers (`targets.dealbreakers`) are removed and counted separately, as are location rejects.

**Override syntax:** The user can relax a default per-run by saying things like "scan last 7 days" or "include remote" — log the override in the summary header so it's auditable.

## Recommended execution

Run as a subagent so it doesn't consume the main context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

## Configuration

Read `portals.yml`, which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: positive/negative/seniority_boost keywords for title filtering

## Discovery strategy (3 levels)

### Level 1 — Direct browser (Chrome DevTools MCP) (PRIMARY)

**For each company in `tracked_companies`:** Navigate to its `careers_url` with Chrome DevTools MCP (`mcp__chrome-devtools__new_page` or `navigate_page` → `mcp__chrome-devtools__take_snapshot`), read ALL visible job listings, and extract title + URL for each. See the `browser-automation` skill for the canonical runbook (debug Chrome on port 9222, profile `~/.career-finder-chrome-debug`, playwright-stealth MCP as the Cloudflare fallback). This is the most reliable method because:
- Sees the page in real time (not Google's cached results)
- Works with SPAs (Ashby, Lever, Workday)
- Detects new offers instantly
- Doesn't depend on Google indexing

**Every company MUST have `careers_url` in portals.yml.** If it doesn't, look it up once, save it, and use it in future scans.

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with a public API or structured feed, use the JSON/XML response as a fast complement to Level 1. It's faster than driving the browser and reduces visual scraping errors.

**Current support (variables in `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; offer detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing convention by provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build the public URL if it's not in the payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build the detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read the full JD, GET the detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (depending on tenant) → `title`, `externalPath` or URL built from the host

### Level 3 — WebSearch queries (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals transversally (all Ashby, all Greenhouse, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but results may be stale.

**Execution priority:**
1. Level 1: Chrome DevTools MCP → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

The levels are additive — they all run, results are merged and deduplicated.

### Level 0 — Zero-LLM lanes run by `npm run morning`

- **ATS sweep** (`scan-index.mjs` / `scan-core.mjs`): Greenhouse, Ashby, Lever, Workday (paginated),
  SmartRecruiters, Workable, Rippling, Recruitee, BambooHR, Teamtailor, iCIMS, Oracle HCM/Taleo.
  Unparsed families are logged as `unsupported family`. Employers the name probe cannot resolve
  need a `careers_url` (Workday / Oracle / iCIMS job-search URL) in `discovery.seed_companies`.
- **LinkedIn, past 24h** (default ON, `integrations.linkedin`): for each of the first 4
  `targets.roles`, three searches: crawl (`linkedin-crawl.mjs`, paged `/jobs/search-results/`
  with `f_TPR=r86400&sortBy=DD`), faceted and semantic (`linkedin-jobsearch.mjs --form faceted|semantic`).
  Max 12 searches/day, budgeted by `li-budget.mjs`; jobs pages only; `data/LINKEDIN_OFF` stops it.
  Logged out = FAILED lane with fix `npm run linkedin:login`. Cards are ATS-resolved before scoring.
  Daily mode only, never speed or hot; skipped with a reason when Chrome is missing.
- **Primary watchlist** (`scan-index.mjs --only data/primary-watchlist.tsv --primary-only --hours 72`):
  daily, re-sweeps employers that have posted the primary role before.
- **Portals** (`scan.mjs`): `tracked_companies` with an `api:` in `portals.yml`, daily.
- **HiringCafe** (`hiringcafe-scan.mjs`): one server-rendered GET per search, daily. Dates are aggregator
  claims; every hit is ATS-verified downstream.
- **LinkedIn guest API** (`speed-linkedin.mjs --hours 24`): logged-out job cards, daily.
- **LinkedIn job-alert emails** (`linkedin-email-alerts.mjs`): read-only Gmail, daily; never sends or labels.
- **Browser-rendered boards** (`browser-boards.mjs`): client-rendered boards via the debug Chrome, daily,
  skipped without Chrome.
- **New boards / repair** (`discover-companies.mjs`, `probe-ats.mjs`): grow and fix `company-index.tsv`.

Run them first; the browser/WebSearch levels below are for tracked companies they do not cover.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Browser scan (Chrome DevTools MCP)** (parallel in batches of 3-5):
   For each company in `tracked_companies` with `enabled: true` and `careers_url` defined:
   a. `mcp__chrome-devtools__new_page` (or `navigate_page`) to `careers_url`
   b. `mcp__chrome-devtools__take_snapshot` to read all job listings
   c. If the page has filters/departments, navigate the relevant sections
   d. For each job listing, extract: `{title, url, company}`
   e. If the page paginates results, navigate additional pages
   f. Accumulate in the candidate list
   g. If `careers_url` fails (404, redirect), try `scan_query` as a fallback and flag for URL update

5. **Level 2 — ATS APIs / feeds** (parallel):
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch the API/feed URL
   b. If `api_provider` is defined, use its parser; if not, infer by domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. For **Ashby**, send POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query for `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only carries basic metadata. For each relevant item, read `id`, GET `https://{company}.bamboohr.com/careers/{id}/detail`, and extract the full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as the public URL if present; otherwise use the detail URL.
   e. For **Workday**, send POST JSON with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results are exhausted
   f. For each job, extract and normalize: `{title, url, company}`
   g. Accumulate in the candidate list (dedup with Level 1)

6. **Level 3 — WebSearch queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Run WebSearch with the defined `query`
   b. From each result, extract: `{title, url, company}`
      - **title**: from the result title (before " @ " or " | ")
      - **url**: result URL
      - **company**: after the " @ " in the title, or extract from the domain/path
   c. Accumulate in the candidate list (dedup with Levels 1+2)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in the title (case-insensitive)
   - 0 keywords from `negative` must appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → company + normalized role already evaluated
   - `pipeline.md` → exact URL already in pending or processed

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to the pipeline:

   WebSearch results can be stale (Google caches results for weeks or months). To avoid evaluating expired offers, verify each new URL from Level 3 with Chrome DevTools MCP. Levels 1 and 2 are inherently real-time and don't need this verification.

   For each new Level 3 URL (sequential — NEVER drive the debug Chrome in parallel):
   a. `mcp__chrome-devtools__new_page` (or `navigate_page`) to the URL
   b. `mcp__chrome-devtools__take_snapshot` to read the content
   c. Classify:
      - **Active**: visible job title + role description + visible Apply/Submit control inside the main content. Don't count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects this way when the offer is closed)
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Only navbar and footer visible, no JD content (content < ~300 chars)
   d. If expired: log in `scan-history.tsv` with status `skipped_expired` and discard
   e. If active: continue to step 8

   **Don't interrupt the entire scan if a single URL fails.** If the page load errors (timeout, 403, etc.), mark as `skipped_expired` and continue with the next.

8. **For each new verified offer that passes filters**:
   a. Add to the `pipeline.md` "Pending" section: `- [ ] {url} | {company} | {title}`
   b. Log in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **Offers filtered by title**: log in `scan-history.tsv` with status `skipped_title`
10. **Duplicate offers**: log with status `skipped_dup`
11. **Expired offers (Level 3)**: log with status `skipped_expired`

## Title and company extraction from WebSearch results

WebSearch results come in the format: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns by portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If a non-publicly-accessible URL is found:
1. Save the JD in `data/jds/{company}-{role-slug}.md`
2. Add to pipeline.md as: `- [ ] local:data/jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries run: N
Offers found: N total
Filtered by title: N relevant
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-finder pipeline to evaluate the new offers.
```

## careers_url management

Each company in `tracked_companies` should have `careers_url` — the direct URL to its job listings page. This avoids looking it up every time.

**Known patterns by platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** The company's own URL (e.g., `https://openai.com/careers`)

**API/feed patterns by platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` doesn't exist** for a company:
1. Try the platform's known pattern
2. If it fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Chrome DevTools MCP to confirm it works
4. **Save the found URL in portals.yml** for future scans

**If `careers_url` returns 404 or redirects:**
1. Note in the output summary
2. Try scan_query as a fallback
3. Flag for manual update

## portals.yml maintenance

- **ALWAYS save `careers_url`** when adding a new company
- Add new queries as new portals or interesting roles are discovered
- Disable queries with `enabled: false` if they generate too much noise
- Adjust filtering keywords as target roles evolve
- Add companies to `tracked_companies` when you want to follow them closely
- Verify `careers_url` periodically — companies switch ATS platforms
