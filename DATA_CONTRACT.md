# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, `targets`, `location`, `pipeline` thresholds, `outreach` sender + bullets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
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
| `data/*.tsv`, `data/bullets/*`, `data/rosters/*` | Your pipeline ledgers, outreach bullets and contact caches |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/*.md` | All mode instructions (offer, pdf, scan, batch, apply, outreach, speed, discover, orchestrator, scan-web, scan-index, catalog, feedback, qualifiers, scored, dashboard, interview-prep, etc.) **EXCEPT `modes/_profile.md`**, which is USER-layer (see above) |
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/{de,fr,ja,pt,ru}/*` | Language-specific modes |
| `CLAUDE.md` | Agent instructions |
| `AGENTS.md` | Codex instructions |
| `scripts/*.mjs` | Utility scripts (tracked) |
| `scripts/local/*.mjs` | User's local/experimental scripts (gitignored) |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
