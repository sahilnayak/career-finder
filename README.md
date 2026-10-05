# Career-Finder

A job-search pipeline that runs inside Claude Code and adapts to whatever career is on your resume.

You give Claude your resume. It proposes the roles you should target and asks where you want to
work. You confirm or edit. From then on the pipeline does the legwork for that career: it scans
company job boards and aggregators every morning, scores each posting against your CV, writes an
evaluation report for the good fits, tailors a resume PDF, drafts outreach for the ones you pick,
and tracks everything. **It never applies or sends anything on its own.** You review and click.

> **This is not a spray-and-pray tool.** It is a filter that finds the few postings worth your
> time. It recommends against applying to anything scoring below 4.0/5.

## Quick start

1. Install [Claude Code](https://claude.ai/code), Node.js 18+, and optionally Go 1.21+ (dashboard).
2. In this folder: `npm install` and `npx playwright install chromium` (PDF generation).
3. Run `claude` in this folder, paste or attach your resume, and say **"set me up"**.
   Onboarding writes `cv.md`, `config/profile.yml`, `modes/_profile.md` and `portals.yml`.
4. Check it: `node scripts/targets.mjs` prints your roles, location and thresholds;
   `node scripts/targets.mjs --test "<job title>" "<location>"` shows how one posting is judged.
5. Paste a job URL to evaluate it, or run `/career-finder scan`.

Full guide: [`docs/SETUP.md`](docs/SETUP.md). Everything you can tune: [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md).

## What you configure

All of it lives in `config/profile.yml` (see `config/profile.example.yml`):

| Block | Controls |
|---|---|
| `targets` | role titles to search, extra title keywords, negatives (`!` = hard), primary role, seniority |
| `location` | metro/city/state/country, lat/lng + radius, LinkedIn geo id, remote policy |
| `pipeline` | qualify score (default 4.3), daily quota, primary-role quota, window hours |
| `outreach` | sender name/email, one-sentence bridge, three standing proof bullets |

Archetypes, narrative and negotiation notes go in `modes/_profile.md`.

## Commands

```
/career-finder                → list modes
/career-finder {paste a JD}   → evaluate + report + PDF + tracker
/career-finder scan           → scan portals for new postings
/career-finder scan-index     → zero-cost ATS sweep of the company index
/career-finder discover       → grow the company index, then scan and score
/career-finder pdf            → tailored resume PDF
/career-finder outreach       → draft emails / LinkedIn notes (never sent)
/career-finder interview-prep → prep for a specific interview
/career-finder tracker        → application status
/career-finder dashboard      → terminal dashboard
```

The full mode list is in `CLAUDE.md`.

## How the morning run works

```
discover companies → ATS sweep + HiringCafe + LinkedIn job listings + Gmail job alerts
   → score against cv.md (A-G report) → qualifiers on the dashboard
   → tailored resume + outreach drafts for jobs you pick → you apply → outcomes feed back
```

Details: [`docs/PIPELINE-SPEC.md`](docs/PIPELINE-SPEC.md), [`docs/SCRIPTS.md`](docs/SCRIPTS.md).

## Dashboard

```bash
cd dashboard && go build -o career-dashboard . && ./career-dashboard --path ..
```

## Your data stays yours

Personal files (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, `reports/`, `output/`)
are the user layer and are never overwritten by system updates. See [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

## Disclaimer

Career-Finder is a local tool, not a hosted service. You are responsible for what you submit and
for following the terms of the sites it reads. See [`LEGAL_DISCLAIMER.md`](LEGAL_DISCLAIMER.md).

## Credits

Based on [career-ops](https://github.com/santifer/career-ops) by
[Santiago Fernández (santifer)](https://santifer.io), MIT licensed. See [`LICENSE`](LICENSE) and
[`CITATION.cff`](CITATION.cff).

Most of it has since been rewritten: role-agnostic onboarding from any resume, config-driven
targeting, the LinkedIn 24h job lanes, the added ATS families and the portable morning run.
