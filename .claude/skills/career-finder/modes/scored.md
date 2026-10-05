# Mode: scored — View ALL Scored Jobs

> Interactive only: no scheduled lane runs this mode.

Show every role the pipeline has scored (`data/scored-jobs.tsv`), ranked by score, with verdict
(**QUALIFIED** ≥ qualify_score / **near** 4.0–4.2 / **pass** <4.0) + the one-line why + link. Complements `qualifiers`
(which shows only fresh ≥ qualify_score ≤24h) — this is the full picture: near-misses and passes too, so you can see
what was evaluated and why each landed where it did.

## Run
```
node scripts/scored-view.mjs            # all scored, ranked
node scripts/scored-view.mjs --min 4.0  # only near-misses and above
```

## Store
`data/scored-jobs.tsv` (`date, company, role, score, verdict, why, url`) — appended by every scoring pass
(`speed` / `discover` / `offer`). Dedups by URL, keeps the highest score.
