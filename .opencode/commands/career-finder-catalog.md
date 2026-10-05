---
description: Rebuild data/INDEX.md — one referenceable row per job, with report + outreach + JD links
---

Regenerate the job catalog (data/INDEX.md) by joining applications.md + scored-jobs.tsv + outreach-log.tsv:
one row per job with score, status, and clickable links to its report, outreach package, and JD posting.
Runs node scripts/build-catalog.mjs --print.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
