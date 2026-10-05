---
description: Speed-to-lead monitor — find the most recently posted (≤12h) target roles that clear the qualify score
---

Run one speed-to-lead cycle: ATS sweep (≤12h, exact post times) over the company index + browser supplement
(LinkedIn/Google Jobs fresh) → dedup → score → surface only roles ≥ `pipeline.qualify_score`, newest first. Loop it with /loop 15m.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
