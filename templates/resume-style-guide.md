# Resume Style Guide

**Use this for every generated resume PDF.** It is a neutral default; onboarding may replace the
values below with the styles of the candidate's own resume (fonts, accent color, sizes) so generated
PDFs look like theirs. Keep any PDF generator's CSS in sync with this table.

## Fonts
- **Primary:** Arial (name, headings, body, bullets). Replace with the candidate's font if known.

## Colors
| Use | Hex |
|---|---|
| Name | `#000000` |
| Body text | `#111111` |
| **Accent** -- role subtitle, section headings, company names | `#1b3a5c` |
| Links | `#1155cc` |
| Dates / secondary | `#000000` |

## Type scale (pt)
| Element | Size | Weight | Color |
|---|---|---|---|
| Name | 24pt | bold | `#000000` |
| Role / subtitle | 18pt | bold | accent |
| Section heading | 12pt | bold, UPPERCASE | accent |
| Contact line | 12pt | regular | `#000000` (links `#1155cc`) |
| Job title | 11.5pt | bold | `#111111` |
| Company name | 11pt | bold | accent |
| Dates | 10.5pt | regular | `#000000` |
| Summary + Highlights | 11pt | regular (label bold) | `#111111` |
| Experience bullets | 10.5pt | regular | `#111111` |

## Bullets
- Dark filled round dots (U+25CF), marker color `#111111`.

---

## Tailoring rules (apply to every qualifier, score >= `pipeline.qualify_score`)

**When:** a job clears the qualify score -> generate a tailored resume PDF as a **draft** in
`output/` (never auto-sent).

**Read the target JD first, then:**

1. **Integrity (hard rule).** Content comes **only from `cv.md`**. Never invent experience,
   metrics, skills or claims. Tailoring = select, reorder, lightly reword real content. Copy every
   number exactly as `cv.md` states it.
2. **Map every element to the JD -- keep all, emphasize relevant:**
   - **Role subtitle** = the target job's exact title.
   - **Highlights** -- reorder so bullets matching the JD's top priorities come first.
   - **Experience bullets** -- within each job, JD-relevant bullets first.
   - **Skills** -- technologies/methods the JD names first; keep the rest after.
3. **Wording.** Keep the candidate's own phrasing. Align on substance and order; do not keyword-stuff.
4. **Output.** One PDF per qualifier -> `output/cv-{candidate-slug}-{company}-{date}.pdf`, where
   `{candidate-slug}` comes from `candidate.full_name` in `config/profile.yml`. Draft only.
5. **Layout:** continuous flow (never keep blocks together at the cost of white space); 2 pages is fine.
