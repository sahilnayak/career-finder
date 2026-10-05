---
description: Outcome feedback loop — track which qualifiers got responses and feed it back into scoring
---

Sync qualifiers into the outcomes store, report response-rate by role family, and (with enough data) bank a
data-driven learning that improves future scoring. Record outcomes with scripts/record-outcome.mjs.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
