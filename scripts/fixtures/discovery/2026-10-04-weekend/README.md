# Discovery truth set, weekend of 2026-10-04

Hand-verified postings used to measure recall of the discovery lanes. These are public job
postings; nothing personal is stored.

## Window

2026-10-04 02:45Z to 2026-10-05 02:45Z (Sat 7:45pm PT to Sun 7:45pm PT), San Francisco Bay Area,
10 roles: account-executive, customer-success-manager, data-engineer, financial-analyst,
marketing-manager, product-designer, product-manager, registered-nurse, sdr, software-engineer.

## Method

One agent per role. A posting counts as truth only when the **employer's own ATS date** falls
inside the window: Ashby `publishedAt`, Greenhouse `first_published`, Lever `createdAt` (all
minute-level), Workday `postedOn`/`startDate` (day-level). Candidates came from ATS sweeps of the
career-ops and career-finder indexes, LinkedIn guest cards and HiringCafe, each resolved to the
ATS before it counted. Aggregator dates were never accepted on their own.

## Files

- `truth.tsv` — 14 rows. Columns: `role company title location url ats_date ats_family date_field source flags notes`.
  Roles with no row (6 of 10) had zero verified postings in the window.
- `source` is filled only for rows a nomination lane surfaced (the two Hercules rows came from a LinkedIn guest card resolved to Ashby). A blank `source` means the row was found by reading the employer ATS board directly. Every row, either way, carries an ATS date in `ats_date`.
- `ats_date` is UTC. Hercules `2026-10-05T00:21Z` is 2026-10-04 Pacific; convert to Pacific before applying any window to a hand-built truth set.
- `roles.json` — the per-role title families, negatives, years and seed companies used to build
  each test profile. `discovery-audit.mjs --live` builds its temp profiles from this file.

## Caveats

- **Weekend.** Six roles came back empty. That is an *unproven* zero, not a quiet market. The
  weekday rerun (`discovery-audit.mjs --live`) has to happen before anyone reads them that way.
- **Reposts are flagged, not removed** (`flags` column): NVIDIA JR2014880 and JR2007944 (slug does
  not match the title), JR2020348-1 and Cisco 2024135-1 (`-1` suffix). NVIDIA JR1997214 carries a
  day-level date of 2026-10-03, mostly before the window opened, and is also flagged
  `out-of-window`. Raw count 14, corrected 13, about 8-10 after removing likely reposts. Use
  `--exclude-flagged` for the strict set.
- **Clera excluded.** Clera is a recruiting marketplace with bulk-loaded timestamps; it was counted
  as a find in 9 roles during the test and is not a real employer.
- Sentry's posting sat about 61 min (03:45:38Z vs the 02:45Z edge) inside the window edge and may fall out of a rerun window.
- Hercules (2 rows) was reachable only through a LinkedIn guest nomination resolved to Ashby; it
  was in neither index.
