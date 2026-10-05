# Mode: feedback — Outcome Feedback Loop

> Runs automatically in: daily (`outcomes` lane loads §Outcomes (headless); `feedback-outcomes --learn`).

Closes the loop: track which qualifiers actually got responses, and feed that back into scoring/pre-filter so
the search gets smarter from real results (not just coverage).

## Commands
- **Sync + report:** `node scripts/feedback-outcomes.mjs` — adds new qualifiers as `pending`, prints
  response-rate by title-family / score-band / source.
- **Bank a learning:** `node scripts/feedback-outcomes.mjs --learn` — once ≥5 decided outcomes exist, prepends a
  data-driven learning to `.claude/skills/career-finder/modes/scan-web.md` (e.g. "archetype A 67% vs archetype B 0% → prioritize A"), which the scorer reads.
- **Record an outcome:** `node scripts/record-outcome.mjs <company|url> <applied|responded|interview|offer|rejected|skipped>`.

## Store
`data/qualifier-outcomes.tsv` (`url, company, role, score, source, outcome, updated`) — **persists past the 24h
qualifiers prune**, so applied-to roles keep their outcome. Run each pipeline pass (sync) + ad-hoc via
`/career-finder feedback`. Complements the `patterns` mode (rejection analysis over `applications.md`).

## Outcomes (headless)

Loaded by the `outcomes` lane of `scripts/morning.mjs` (daily, once a day, only when Gmail is enabled and
`node scripts/applied-watchlist.mjs` returns at least one job). Gmail is **read-only**.

1. Run `node scripts/applied-watchlist.mjs` for the JSON list of in-flight applied jobs.
2. For each, search Gmail (gmail MCP `search_emails`, `read_email`) for messages from that company since
   the applied date. NEVER send, reply, draft, delete, archive, label or modify anything.
3. Classify the latest signal: `rejected` / `interview` (incl. scheduling links) / `offer` / `responded`
   (a real human reply, not an auto-acknowledgement) / NONE. Be conservative.
4. For each decided signal run `node scripts/record-outcome.mjs "<company>" <responded|interview|offer|rejected>`
   (it refuses ambiguous keys; narrow the key with the url if so). Never regress a status. Update that row's
   Status in `data/applications.md` with a dated `(auto-detected from Gmail)` note; never add rows.
5. Run `node scripts/feedback-outcomes.mjs --learn` once.

End with one line: `outcomes: rejected R, interview I, offer O, responded P`.
