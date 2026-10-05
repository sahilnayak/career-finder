---
description: AI job search command center -- show menu or evaluate job description
---

Career-Finder router. Arguments provided: "$ARGUMENTS"

If arguments contain a job description or URL (keywords like "responsibilities", "requirements", "qualifications", "about the role", "http", "https"), the skill will execute auto-pipeline mode.

Otherwise, the discovery menu will be shown.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
