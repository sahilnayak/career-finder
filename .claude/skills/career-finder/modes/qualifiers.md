# Mode: qualifiers — View Qualified Jobs (score ≥ qualify_score)

> Interactive only: no scheduled lane runs this mode.

Show the roles that passed the `offer` bar (score ≥ qualify_score) from `data/qualifiers.tsv`, with scores + clickable links.

## Run
```
node scripts/qualifiers-view.mjs            # score ≥ qualify_score (default), clickable links
node scripts/qualifiers-view.mjs --min 4.0  # widen the bar
```
Renders a ranked terminal view (company · role · score · why · link), deduped by URL, newest/highest first.
Only roles scored ≥ qualify_score by the scan→score pipeline appear — that's the bar set for this search.

## Source
`data/qualifiers.tsv` (`date, company, role, score, why, url, source`), appended by the `discover` pipeline's
scoring step. The user can also just ask "what are my qualifiers?" and I'll read + summarize the file.
