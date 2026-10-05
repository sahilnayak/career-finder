# User Profile Context -- career-finder

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.
     
     Customize everything here: your archetypes, narrative,
     proof points, negotiation scripts, location policy.
     
     The system reads _shared.md (updatable) first, then this
     file (your overrides). Your customizations always win.
     ============================================================ -->

## Your Target Roles

<!-- ONBOARDING FILLS THIS from the resume, then the user confirms it.
     The role list must match `targets.roles` in config/profile.yml.
     One row per archetype (2-5 rows). Nothing here is a default career:
     derive every row from the candidate's own cv.md. -->

| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **{Archetype 1 -- usually targets.primary_role}** | {3-5 themes from the JDs} | {the problem a hiring manager pays this person to solve} |
| **{Archetype 2}** | {themes} | {what they buy} |
| **{Archetype 3}** | {themes} | {what they buy} |

## Your Adaptive Framing

<!-- Map the candidate's real projects/roles (from cv.md) to each archetype. -->

| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| {Archetype 1} | {strengths from cv.md} | cv.md + article-digest.md |
| {Archetype 2} | {strengths} | cv.md |
| {Archetype 3} | {strengths} | cv.md |

## Your Scoring Notes

<!-- Optional user-specific weighting on top of modes/_shared.md:
     must-haves, dealbreakers, industries to prefer or avoid, tenure gates
     the candidate does or does not meet. -->

## Your Exit Narrative

<!-- Replace with YOUR story. This frames everything. -->

Use the candidate's exit story from `config/profile.yml` to frame ALL content:
- **In PDF Summaries:** Bridge from past to future
- **In STAR stories:** Reference proof points from article-digest.md
- **In Draft Answers:** The transition narrative appears in the first response

## Your Cross-cutting Advantage

<!-- What's your "signature move"? What do you do that others can't? -->

{One sentence onboarding writes from the resume: the thing this candidate does that most applicants for these roles cannot.}

## Your Portfolio / Demo

<!-- If you have a live demo, dashboard, or public project:
     url: https://yoursite.dev/demo
     password: demo-2026
     when_to_share: "{which archetypes}" -->

If you have a live demo/dashboard (check profile.yml), offer access in applications for relevant roles.

## Your Comp Targets

<!-- Research comp ranges for YOUR target roles -->

**General guidance:**
- Use WebSearch for current market data (Glassdoor, Levels.fyi, Blind)
- Frame by role title, not by skills
- Contractor rates are typically 30-50% higher than employee base

## Your Negotiation Scripts

<!-- Adapt to YOUR situation, currency, location -->

**Salary expectations:**
> "Based on market data for this role, I'm targeting [RANGE from profile.yml]. I'm flexible on structure -- what matters is the total package and the opportunity."

**Geographic discount pushback:**
> "The roles I'm competitive for are output-based, not location-based. My track record doesn't change based on postal code."

**When offered below target:**
> "I'm comparing with opportunities in the [higher range]. I'm drawn to [company] because of [reason]. Can we explore [target]?"

## Your Location Policy

<!-- Adapt to YOUR situation -->

**In forms:**
- Follow your actual availability from profile.yml
- Specify timezone overlap in free-text fields

**In evaluations (scoring):**
- Remote dimension for hybrid outside your country: score **3.0** (not 1.0)
- Only score 1.0 if JD says "must be on-site 4-5 days/week, no exceptions"

## Morning quota

<!-- Numbers live in config/profile.yml `pipeline` -- do not duplicate them here. -->

The morning run aims for `pipeline.daily_quota` qualifiers found within `pipeline.window_hours`,
at least `pipeline.primary_quota` of them matching `targets.primary_role`. If short, keep searching
(grow the company index, widen titles within `targets.title_keywords`); never lower
`pipeline.qualify_score` or fake freshness. A short day is reported as short.

## Outreach on qualify

A job that clears `pipeline.qualify_score` is **eligible** for outreach, not owed. Nothing drafts
automatically, interactive or headless. Pick jobs with `w` on the dashboard or
`node scripts/outreach-queue.mjs add`; drafts are draft-only and sending is always the user's call.
`scripts/outreach-owed.mjs` is a read-only "awaiting" view of eligible jobs without a draft.
