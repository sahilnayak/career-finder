# Setup Guide

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and configured
- Node.js 18+ (for PDF generation and utility scripts)
- (Optional) Go 1.21+ (for the dashboard TUI)

## Quick Start (5 steps)

### 1. Clone and install

```bash
# copy the career-finder folder you were given, then:
cd career-finder
npm install
npx playwright install chromium   # Required for PDF generation
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Easier: open Claude Code in the folder, paste or attach your resume, and say "set me up". The onboarding
skill reads the resume, proposes target roles and location for you to confirm, and writes
`config/profile.yml`, `modes/_profile.md`, `cv.md` and `portals.yml`. Check the result with
`node scripts/targets.mjs`.

### 3. Add your CV

Create `cv.md` in the project root with your full CV in markdown format. This is the source of truth for all evaluations and PDFs.

(Optional) Create `article-digest.md` with proof points from your portfolio projects/articles.

### 4. Configure portals

```bash
cp templates/portals.example.yml portals.yml
```

Edit `portals.yml`:
- Update `title_filter.positive` with keywords matching your target roles
- Add companies you want to track in `tracked_companies`
- Customize `search_queries` for your preferred job boards

### 5. Start using

Open Claude Code in this directory:

```bash
claude
```

Then paste a job offer URL or description. Career-Finder will automatically evaluate it, generate a report, create a tailored PDF, and track it.

### 6. Schedule the morning run (optional)

```bash
npm run doctor          # prerequisites
npm run morning:dry     # every lane it would run, and why any is skipped; spends nothing
npm run linkedin:login  # optional: log the dedicated Chrome profile into LinkedIn once
npm run schedule -- install   # daily run at schedule.daily_time; --with-speed / --with-hot opt in
npm run schedule:status
```

Scheduled runs call `claude -p --dangerously-skip-permissions` (headless runs cannot answer
prompts), on Sonnet, capped at `pipeline.daily_claude_cap` calls per day. See [`SCHEDULING.md`](SCHEDULING.md).

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-finder scan` |
| Process pending URLs | `/career-finder pipeline` |
| Generate a PDF | `/career-finder pdf` |
| Batch evaluate | `/career-finder batch` |
| Check tracker status | `/career-finder tracker` |
| Fill application form | `/career-finder apply` |

## Verify Setup

```bash
node scripts/cv-sync-check.mjs      # Check configuration
node scripts/verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ..  # Opens TUI pipeline viewer
```
