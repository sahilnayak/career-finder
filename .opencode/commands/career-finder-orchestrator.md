---
description: Orchestrated discovery — launch a swarm of WebSearch agents to grow the company index, sweep career pages, score, iterate
---

Run the discovery orchestrator: launch parallel WebSearch agents across non-overlapping slices (industry / geo /
VC / YC / ATS host) to find new companies in the configured area, grow the index, sweep their career pages zero-token + browser
tail, score ≥4.3, and iterate until a fresh qualifier is found.

Load the career-finder skill:
```
skill({ name: "career-finder" })
```
