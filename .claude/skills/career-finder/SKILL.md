---
name: career-finder
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
user_invocable: true
args: mode
argument-hint: "[scan | scan-web | scan-index | discover | orchestrator | speed | deep | pdf | offer | offers | apply | batch | tracker | qualifiers | scored | catalog | feedback | pipeline | contact | outreach | training | project | interview-prep | dashboard | update]"
---

# career-finder -- Router

## Setup gate

Before any mode: if `cv.md`, `config/profile.yml`, `modes/_profile.md` or `portals.yml` is missing,
or `node scripts/targets.mjs` reports "run onboarding first", stop and run the
`career-finder-onboarding` skill. Every mode reads the user's target roles, location policy and
thresholds from `config/profile.yml`; never assume a role family, metro or score bar.

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `offer` | `offer` |
| `offers` | `offers` |
| `contact` | `contact` |
| `outreach` | `outreach` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `scan-web` | `scan-web` |
| `scan-index` | `scan-index` |
| `discover` | `discover` |
| `orchestrator` | `orchestrator` |
| `speed` | `speed` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `dashboard` | `dashboard` |
| `qualifiers` | `qualifiers` |
| `scored` | `scored` |
| `catalog` | `catalog` |
| `feedback` | `feedback` |
| `interview-prep` | `interview-prep` |
| `setup` / `onboard` | run the `career-finder-onboarding` skill |
| `hunt` | delegate to the `hunt` agent (`.claude/agents/hunt.md`) |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-finder -- Command Center

Available commands:
  /career-finder {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /career-finder pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-finder offer     → Evaluation only A-F (no auto PDF)
  /career-finder offers    → Compare and rank multiple offers
  /career-finder contact   → LinkedIn power move: find contacts + draft message
  /career-finder outreach  → Multi-persona email + LinkedIn drafts (HM / Recruiter / Leader) → HTML
  /career-finder deep      → Deep research prompt about company
  /career-finder pdf       → PDF only, ATS-optimized CV
  /career-finder training  → Evaluate course/cert against North Star
  /career-finder project   → Evaluate portfolio project idea
  /career-finder tracker   → Application status overview
  /career-finder apply     → Live application assistant (reads form + generates answers)
  /career-finder scan      → Scan portals and discover new offers
  /career-finder scan-web  → Browser web comb: your target roles in your area, last 24h (list only)
  /career-finder scan-index→ Zero-token sweep of your company index (ATS APIs)
  /career-finder discover  → Grow the company index (discovery agent) + recurring scan→score pipeline
  /career-finder orchestrator → Swarm of discovery agents: grow index + sweep + score + iterate till a qualifier
  /career-finder speed     → Speed-to-lead: most recently posted (≤12h) target roles at or above pipeline.qualify_score
  /career-finder batch     → Batch processing with parallel workers
  /career-finder patterns  → Analyze rejection patterns and improve targeting
  /career-finder followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-finder dashboard → Launch the TUI dashboard (pipeline / viewer / progress) in a new terminal
  /career-finder qualifiers→ View qualified jobs (score ≥ pipeline.qualify_score) with links
  /career-finder scored    → View ALL scored jobs (QUALIFIED / near / pass), ranked, with why
  /career-finder catalog   → Rebuild data/INDEX.md: one row per job → report + outreach + JD links
  /career-finder interview-prep → Company + round prep doc for an upcoming interview
  /career-finder setup     → (Re)run onboarding: resume → target roles → config → pipeline
  /career-finder hunt      → 10-minute find → score → draft loop (hunt agent)
  /career-finder feedback  → Outcome loop: track responses, feed back into scoring (gets smarter)

Inbox: add URLs to data/pipeline.md → /career-finder pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `offer`, `offers`, `pdf`, `contact`, `outreach`, `apply`, `pipeline`, `scan`, `scan-web`, `scan-index`, `discover`, `orchestrator`, `speed`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `dashboard`, `qualifiers`, `scored`, `catalog`, `feedback`, `interview-prep`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-finder {mode}"
)
```

Execute the instructions from the loaded mode file.
