# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, `targets`, `location`, `pipeline` thresholds, `outreach` sender + bullets, comp range |
| `config/narrative.md` | Your archetypes, narrative, negotiation scripts (older installs: `modes/_profile.md`, migrated by `doctor.mjs`) |
| `data/scan-web-learnings.md` | Search learnings banked by scan-web, `feedback-outcomes.mjs --learn` and `speed-metrics.mjs` |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `data/follow-ups.md` | Your follow-up history |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `data/jds/*` | Your saved job descriptions |
| `data/_first-seen.tsv` | First-seen ledger: `url_key`, `first_seen`, `source`, `last_date` (4 columns; the ATS date as last seen). It decides `fresh` / `new` vs `known` / `re-promoted`, so **deleting it reclassifies every row as new** and the next sweep re-surfaces old reqs. Safe to delete only to start fresh |
| `data/_nominations.tsv` | 7-day re-probe ledger for employers the nominate loop could not resolve; deleting it just retries them sooner |
| `data/_new-boards.tsv` | Boards found by the nominate loop, rewritten each run; deleting it loses nothing the index does not already hold |
| `data/*.tsv`, `data/bullets/*`, `data/rosters/*` | Your pipeline ledgers, outreach bullets and contact caches. This includes `data/company-index.tsv` (your live index, seeded once from the starter) and `data/_repair-schedule.tsv` (backoff dates for dead boards) |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `.claude/skills/career-finder/modes/*.md` | All mode instructions (offer, pdf, scan, batch, apply, outreach, speed, discover, orchestrator, scan-web, scan-index, catalog, feedback, qualifiers, scored, dashboard, interview-prep, etc.) |
| `.claude/skills/career-finder/modes/_shared.md` | Scoring system, global rules, tools |
| `.claude/skills/career-finder/modes/_profile.template.md` | Template onboarding copies to `config/narrative.md` |
| `.claude/skills/career-finder/modes/{de,fr,ja}/*` | Language-specific modes |
| `CLAUDE.md` | Agent instructions |
| `AGENTS.md` | Codex instructions |
| `scripts/*.mjs` | Utility scripts (tracked) |
| `scripts/local/*.mjs` | User's local/experimental scripts (gitignored) |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `templates/company-index.starter.tsv` | Bundled starter company index (about 1,600 boards, `source=starter`, no scan history). `doctor`, `scan-index` and `update-system apply` copy it to `data/company-index.tsv` only when that file is missing or header-only |
| `data/registries/*.tsv` | Sector registries (`healthcare`, `finance`, `bigtech`): hand-verified employer boards that `scan-index` reads in addition to the company index. Columns `company, ats_type, ats_api_url, careers_url, status, verified_on, how_verified, note`; `status` is `verified`, `unverified` or `needs-parser`, and only `verified` rows are swept. System layer: do not put personal rows here, add them to `data/company-index.tsv` |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
