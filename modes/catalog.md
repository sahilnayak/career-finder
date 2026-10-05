# career-finder — catalog mode

Regenerate and surface `data/INDEX.md`: one referenceable row per job, joining the structured
files so any job's score / status / report / outreach / JD is a single lookup away (no RAG needed).

## Execute

1. Regenerate the catalog (joins `applications.md` + `scored-jobs.tsv` + `outreach-log.tsv`):
   ```bash
   node scripts/build-catalog.mjs --print
   ```
2. Report the summary the script prints (totals, by-status, top jobs) and point the user to the file:
   > "Catalog rebuilt → `data/INDEX.md` ({N} jobs, {Q} qualifiers, {R} with reports, {O} with outreach).
   > Sorted by score; every row links its report, outreach package, and JD. Open `data/INDEX.md`, or ask
   > me to filter it (e.g. 'show applied', 'qualifiers with outreach', 'primary-role jobs ≥4.5')."
3. If the user asks to filter/slice, read `data/INDEX.md` (or grep the source TSVs) and answer directly —
   the catalog is exact + structured, so filter by column rather than guessing.

## Notes
- The catalog is **generated** — never hand-edit `data/INDEX.md`; change the source files and rerun.
- `🟢` = qualifier (≥ qualify_score), `🟡` = near (4.0–4.2). Outreach cell shows persona count + `✓` if any was sent.
- Cheap + deterministic: this is lexical/structured retrieval over the local files, not a vector index.
  For fuzzy semantic search across the report prose, a separate embedding index would be needed (ask).
