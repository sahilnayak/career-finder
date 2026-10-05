---
description: Multi-persona outreach drafts (HM/Recruiter/Peer/Leader) → copyable HTML
---

Generate email + LinkedIn copy for each provided persona using career-finder outreach mode.

Input format (one persona URL per line; separators are tolerant: → -> —> : =):

```
Job Description: <URL or text>
Hiring Manager → <linkedin URL>
Recruiter → <linkedin URL>
Peer → <linkedin URL>
Leader → <linkedin URL>
```

Args:

$ARGUMENTS

Load the career-finder skill:
```
skill({ name: "career-finder" })
```

Then run mode `outreach` with the inputs above.
