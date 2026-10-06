# Customization Guide

## Profile (config/profile.yml)

This is the single source of truth for your identity. All modes read from here.

Key sections:
- **candidate**: Name, email, phone, location, LinkedIn, portfolio
- **target_roles**: Your North Star roles and archetypes
- **narrative**: Your headline, exit story, superpowers, proof points
- **compensation**: Target range, minimum, currency
- **location**: Country, timezone, visa status, on-site availability

## Role vocabulary and seniority (config/profile.yml `targets`)

- **`targets.synonyms`**: other titles that mean the same job as a role, e.g.
  `"sales engineer": ["Solutions Engineer", "Forward Deployed Engineer"]`. A list REPLACES the built-in one for
  that role (the built-in Sales Engineer list is deliberately strict: Solutions / Pre-Sales only, so add FDE here
  if you want it). Synonyms are matched, never searched for.
- **`targets.seniority`**: `ic` drops director / VP / head of / chief titles, `manager` drops VP / head of / chief.
  Left unset, no seniority title is dropped, and a "... Manager" role also keeps Director / Head of / Lead
  titles in the same function.
- **`targets.negatives`**: alias for `title_negatives`. Prefix a phrase with `!` to make it a hard drop.
- Check any title with `node scripts/targets.mjs --test "<job title>" "<location>"`.

## Registries (data/registries/*.tsv)

Hand-verified employer boards that are swept in addition to the index (health systems, banks, big tech).
To add one, append a row with `company, ats_type, ats_api_url, careers_url, status, verified_on, how_verified, note`
and set `status` to `verified` only after the API URL returned jobs. Only `verified` rows are swept; the index
wins on a duplicate. Workday boards on `*.myworkdaysite.com` (`/recruiting/{tenant}/{site}`) are supported.

## Kill switches

`npm run pipeline:off` (everything), `data/NOMINATE_OFF` or `NOMINATE_OFF=1` (the nomination loop only),
`data/HOT_OFF`, `data/LINKEDIN_OFF`, `data/VERIFY_OFF`. See `docs/SCHEDULING.md`.

## Index maintenance

`npm run repair` lists dead or moved boards; `npm run repair:apply` fixes them. Boards that keep failing are
retried on a backoff (`data/_repair-schedule.tsv`). `build-company-index.mjs --import <file> [--scrub]` merges
another index. A fresh clone already has the starter index, so you do not need to build one.

## Target Roles (config/narrative.md)

The archetype table in `config/narrative.md` determines how offers are scored and CVs are framed. Edit the table to match YOUR career targets:

```markdown
| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Your Role 1** | key skills | what they need |
| **Your Role 2** | key skills | what they need |
```

Also update the "Adaptive Framing" table to map YOUR specific projects to each archetype.

## Portals (portals.yml)

Copy from `templates/portals.example.yml` and customize:

1. **title_filter.positive**: Keywords matching your target roles
2. **title_filter.negative**: Tech stacks or domains to exclude
3. **search_queries**: WebSearch queries for job boards (Ashby, Greenhouse, Lever)
4. **tracked_companies**: Companies to check directly

## CV Template (templates/cv-template.html)

The HTML template uses these design tokens:
- **Fonts**: Space Grotesk (headings) + DM Sans (body) -- self-hosted in `fonts/`
- **Colors**: Cyan primary (`hsl(187,74%,32%)`) + Purple accent (`hsl(270,70%,45%)`)
- **Layout**: Single-column, ATS-optimized

To customize fonts/colors, edit the CSS in the template. Update font files in `fonts/` if switching fonts.

## Negotiation Scripts (.claude/skills/career-finder/modes/_shared.md)

The negotiation section provides frameworks for salary discussions. Replace the example scripts with your own:
- Target ranges
- Geographic arbitrage strategy
- Pushback responses

## Hooks (Optional)

Career-Finder can integrate with external systems via Claude Code hooks. Example hooks:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo 'Career-Finder session started'"
      }]
    }]
  }
}
```

Save hooks in `.claude/settings.json`.

## States (templates/states.yml)

The canonical states rarely need changing. If you add new states, update:
1. `templates/states.yml`
2. `scripts/normalize-statuses.mjs` (alias mappings)
3. `.claude/skills/career-finder/modes/_shared.md` (any references)
