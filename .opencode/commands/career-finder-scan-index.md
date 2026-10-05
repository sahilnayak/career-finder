---
description: Zero-token sweep of the company index (data/company-index.tsv) for fresh target roles
---

Sweep the growing company index via ATS APIs (zero token), filter to `targets.roles` in the configured
`location`, dedup against history, and surface fresh candidates to score. Grow the index first with
build-company-index.mjs.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
