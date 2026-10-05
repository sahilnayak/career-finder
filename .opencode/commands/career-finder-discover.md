---
description: Grow the company index (discovery agent) and run the recurring scan→score pipeline
---

Grow data/company-index.tsv with companies in the configured area (config/profile.yml `location`) via the discovery agent
(zero-token sources + live-web browser crawl), then sweep + score for fresh roles matching `targets.roles` that clear
`pipeline.qualify_score` into data/qualifiers.tsv.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
