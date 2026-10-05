# Mode: feedback — Outcome Feedback Loop

Closes the loop: track which qualifiers actually got responses, and feed that back into scoring/pre-filter so
the search gets smarter from real results (not just coverage).

## Commands
- **Sync + report:** `node scripts/feedback-outcomes.mjs` — adds new qualifiers as `pending`, prints
  response-rate by title-family / score-band / source.
- **Bank a learning:** `node scripts/feedback-outcomes.mjs --learn` — once ≥5 decided outcomes exist, prepends a
  data-driven learning to `modes/scan-web.md` (e.g. "archetype A 67% vs archetype B 0% → prioritize A"), which the scorer reads.
- **Record an outcome:** `node scripts/record-outcome.mjs <company|url> <applied|responded|interview|offer|rejected|skipped>`.

## Store
`data/qualifier-outcomes.tsv` (`url, company, role, score, source, outcome, updated`) — **persists past the 24h
qualifiers prune**, so applied-to roles keep their outcome. Run each pipeline pass (sync) + ad-hoc via
`/career-finder feedback`. Complements the `patterns` mode (rejection analysis over `applications.md`).
