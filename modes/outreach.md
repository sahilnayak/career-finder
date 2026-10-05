# Mode: outreach -- Multi-persona Outreach Drafting (fan-out / fan-in)

All sender details come from `config/profile.yml`: `outreach.sender_name`, `outreach.sender_email`,
`outreach.bridge` (one identity sentence for emails) and `outreach.default_bullets` (the standing
three proof bullets). Proof points come from `cv.md` and the evaluation report only. Nothing in this
file names a candidate, an employer the candidate worked for, or a career.

## HARD RULE -- outreach is USER-SELECTED, not automatic

Scoring >= `pipeline.qualify_score` makes a job ELIGIBLE for outreach, not owed. The user picks
which qualifiers to pursue; only picked jobs get drafted.

Why: contact discovery spends a hard-capped, risk-bearing LinkedIn budget (shared counter in
`scripts/li-budget.mjs`: `CAPS`, `HORIZONS`, `BURST_PER_HOUR`; per-run cap `PER_RUN_CAP` in
`scan-roster.mjs`) plus any email-finder quota. Read the numbers there, not from prose.

| Step | Cost | Runs |
|---|---|---|
| `gen-bullets.mjs` (JD-mapped bullets) | headless `claude -p`, no LinkedIn | automatic for every eligible job |
| `scan-roster.mjs` (LinkedIn contacts) | profile visits | only for picked jobs |
| `find-email.mjs` | finder quota | only for picked jobs |
| `gen-outreach.mjs` + `render-outreach.mjs` + `outreach-judge.mjs` | cheap | only for picked jobs |

**How the user picks:** `w` on the dashboard Found panel, or
`node scripts/outreach-queue.mjs add --company "X" --role "Y"`.

**Files:** `data/outreach-queue.tsv` (queue), `scripts/outreach-queue.mjs` (add / done / remove /
list / awaiting), `scripts/outreach-owed.mjs` (owed = eligible AND picked AND undrafted),
`scripts/drain-outreach.mjs`. A picked job stays owed until drafted. Unpicked qualifiers age off the
board with the window.

**Draft-only holds absolutely.** Picking a job authorises drafting, never sending.

## HARD RULE -- never name the application date

Say the application is in, never when. A date reads as a nudge and stales the note. Enforced in
`gen-outreach.mjs` and gated HARD by `outreach-judge.mjs`.

## HARD RULE -- plan contacts before spending any LinkedIn action

Run `node scripts/contact-plan.mjs --company "X" --role "Y" --jd-url URL` first. It costs zero
account budget (ATS JSON and cached rosters only) and says who to look for: the ATS
`department`/`team` (Greenhouse needs `?content=true`), how this company titles its managers (from
sibling reqs), and seniority scaled inversely to company size (<60: function lead; <200:
Head/Director; <800: Director/Senior Manager; <3000: manager of the sub-team; >=3000: skip Leader).

Then spend in rungs, stopping when the slots fill:

| Rung | Cost | What |
|---|---|---|
| 0-1 | free | cached roster + ATS org -> target team and title |
| 2 | 1 pageview | the LinkedIn job page (repost signal, "people you can reach out to") |
| 3 | 1 search | one company+team scoped people search, page 1 |
| 4 | 1 search | recruiter query, only if rung 3 left it empty |
| 5 | free (guest) | anonymous employer confirm |
| 6 | 0-2 profiles | visit only the finalists |

Target ~4 charged actions per company; do not process two companies back to back (the rolling-hour
burst is usually the binding limit).

## Profile visits buy the hook

Every contact that appears in a draft gets a profile visit: the visit yields `recentPost`, the only
person-specific signal. Without it the opener falls back to a company-generic line. `scan-roster.mjs`
queues provisional persona finalists for visits ahead of raw card rank; `--max-visits` defaults to 6.
If the budget runs out, the roster cache makes the run resumable tomorrow.

## LinkedIn depth matches company size

`scan-roster.mjs --auto-mode` reads the employee count: < 800 -> full `/people/` roster sweep;
>= 800 -> targeted persona search only (big-company rosters return off-team people). Override with
the queue's `li_mode` column (`auto | roster | targeted`) or `--search-only` / `--no-auto-mode` /
`--large-threshold N`.

## What varies per person, and what must not

**Varies per person: the observation only.** `observationLadder()` in `gen-outreach.mjs` takes the
first rung that exists: (1) their hiring post, (2) their recent post quoted verbatim, (3) a shared
company line.

**Does not vary: the proof, the ask, the CTA, the subject.** Why the candidate wants the job is a
property of the job, and recipients forward. With no real per-person signal, say the same honest
thing to both, or drop the weaker contact; never invent a distinction. The judge reports duplication
as WARN, never HARD.

**Bullets must be order-independent** (no opening `It`/`This`/`Doing so`); gated HARD.
**Never amputate a claim to fit 300 chars**; use the shorter whole clause instead.
**Every HARD verdict blocks:** `drain-outreach.mjs` leaves the job queued (`--force` overrides).

## Purpose

Generate copy-ready email + LinkedIn drafts for up to four personas (Hiring Manager, Recruiter, Peer, Leader) in a single pass, then render them into a copyable HTML page. Pulls proof points from the per-role evaluation report.

This mode complements `contact` (which finds *one* primary target). Use `outreach` when you already have URLs for multiple stakeholders and want every draft on a single page.

## Input format

The user pastes one of these shapes (separator chars are tolerant: `→`, `->`, `—>`, `:`, `=`, `=>`):

```
Job Description: <URL or text>
Hiring Manager → <linkedin URL>
Recruiter → <linkedin URL>
Peer → <linkedin URL>
Leader → <linkedin URL>
```

Parser rules:
- The JD line is the only required field beyond at least one persona.
- Persona keys accept singular or plural and case-insensitive: `Hiring Manager`/`HM`, `Recruiter`/`Recruiters`, `Peer`/`Peers`, `Leader`/`Leaders`/`Executive`.
- Multiple URLs per persona are allowed (one per line, same key repeated). Treat each as a separate target inside that persona's section.
- If the user provides only the JD, ask for at least one persona URL before proceeding.

### Direct path: a hand-written spec for `gen-outreach.mjs`

`node scripts/gen-outreach.mjs <spec.json>` takes an array of companies. Minimal example:

```json
[{
  "company": "Acme",
  "role": "Solutions Engineer",
  "jd_url": "https://jobs.ashbyhq.com/acme/123",
  "hmFirstName": "Dana",
  "bullets_slug": "acme",
  "people": [
    { "persona": "Hiring Manager", "name": "Dana Lee", "title": "Head of Solutions",
      "linkedin": "https://www.linkedin.com/in/...", "email": "dana@acme.com",
      "observationSource": "recent-post",
      "emailObs": "Saw your post on moving onboarding in-house. I applied for the Solutions Engineer role and wanted to reach you directly.",
      "liObs": "saw your post on moving onboarding in-house" }
  ]
}]
```

- `hmFirstName`: optional, informational. Leader drafts take the HM first name from the `Hiring Manager` person in `people`, so keep that entry's `name` real.
- `liObs`: a clause, not a sentence. It follows `Hi {Name}, ` so start lowercase and end without a period; the generator lowercases a leading capital unless it is a proper noun, acronym or `I`. Never put "I applied" in it (both LinkedIn templates append it).
- `emailObs`: full sentences, capitalised. Hiring Manager / Leader: MUST contain the applied line; Peer / Recruiter: must NOT.
- `observationSource` (rendered as `observation_source`): one of `recent-post`, `hiring-post`, `profile-experience`, `profile-activity`, `company-template`. Omitted = `spec-provided`, which is not counted as personalized.
- `email`: when supplied, it is used as-is and no network email lookup runs. Omit it to let the finder search.
- Bullets precedence: `bullets` inline in the spec -> `data/bullets/{bullets_slug}.json` -> the standing set in `config/profile.yml`. Provenance shows `inline`, `company file`, or `standing set (profile)`.
- `data/bullets/{slug}.json` format: `{ "bullets": [3 strings], "jd": { "gold": { "email": "...", "li": "...", "liLeader": "..." }, "silver": {...}, "bronze": {...} } }`. `jd.*.li` is a continuation clause appended after `I applied for the {role} role, and `: lowercase start, no trailing period, and no leading `and`/`so`.

## Personas, channels, and templates

| Persona | Email | LinkedIn connection (≤300 chars) | LinkedIn DM (≤300 chars) |
|---|---|---|---|
| Hiring Manager | yes (T1 or T2) | yes | optional (after connect) |
| Recruiter | yes | yes | no |
| Peer | no | yes | no |
| Leader | yes (T1 or T2) | yes | no |

Templates live verbatim at the bottom of this file under **TEMPLATES**. Do not paraphrase the structure -- match the slot order exactly. Voice stays user's; substitutions are slot-level only.

## Strict style rules (apply to every draft)

These are non-negotiable:

- **No em dashes (—) anywhere.** Use periods, commas, parentheses, or colons. Compound modifiers with hyphens (`human-in-the-loop`) are fine.
- **Active voice. Short, direct sentences.**
- **No clichés or metaphors** (`passionate about`, `hit the ground running`, `cutting-edge`, `synergies`, `move the needle`, `wear many hats`, `rockstar`, `ninja`, `game-changer`).
- **No setup phrases** (`I'm reaching out because`, `I just wanted to`, `In conclusion`, `Hope this email finds you well`).
- **No hashtags or emojis** unless the chosen template includes one .
- **No fluff or vague claims.** Every reason needs a number or proof point.
- **One personalized observation only.** Pull from one of the six categories below; do not stack two.
- **LinkedIn HARD CAPS:**
  - Every LinkedIn message must be ≤300 characters. Always count and report the count next to the draft.
  - Every LinkedIn message ends with an approved CTA from the set in `scripts/outreach-judge.mjs` (default `Open to a quick chat?`), with at least two sentences before it so the ask has a topic. **Leader persona:** never a chat ask; end with a pointer ask such as `If you're not directly hiring, could you point me to the hiring manager?`. **Peer:** `Any advice you'd share?` or a pointer ask.
- **Email subject:** `Your Next [Job Title] - [Candidate Name]` (plain hyphen, not em dash).
- **Open with a checkable, specific observation** about the recipient or their team; the candidate's interest must be grounded in `cv.md`, never invented.
- **Bridge line:** emails carry one identity sentence from `outreach.bridge` in `config/profile.yml`, injected by `bridge()` in `gen-outreach.mjs`. Edit the profile, not the script. Keep emails to two short paragraphs before the bullets.
- **JD tie = subtle echo, no announcer.** One line ties to the JD's mission/product in its own words, then straight into three bullets that each weave the JD's own verb for a different requirement. Enforced in `gen-bullets.mjs` + `gen-outreach.mjs`.
- **Strip location qualifiers from the role in the COPY and subject.** Remove city/metro tags, `(Remote)`, `(Hybrid)`, etc. from the role as it appears in bodies and the subject line. Keep the full role (with the qualifier) only in the filename/slug and header metadata. Leave meaningful team tags intact. `gen-outreach.mjs` does this via `roleDisplay()`.
- **Truth-safe tool/product claims.** Never assert hands-on/production use of a company's product the CV does not support. If the candidate has only explored it, say `digging into {product}` (interest), not `building on {product}` (production claim). When in doubt, ASK the user whether they've actually used it before writing the claim.
- **Score + judge before sending.** Run `node scripts/outreach-judge.mjs <slug>` (deterministic: em-dash/cap/CTA/subject/banned-phrase/claim-vs-cv gate) and, for the qualitative pick, an optional reviewer pass (JD-fit, truth, voice, persuasion). Gold/silver/bronze are angles, not quality tiers; the judge gates HARD violations regardless of angle.

### Six personalization categories (pick one per draft)

1. Recent post or article
2. Career path or role transition
3. Company growth or initiative (product launch/GA, hiring wave — NEVER funding/round/investor signals, which the no-company-money ban prohibits)
4. Mutual connection or shared network
5. Skills or endorsements
6. Speaking engagements or publications

Hiring posts are the highest-signal observation -- they literally asked. Prefer them when they exist.

## Contact discovery — match the method to company size

**Before drafting, the contacts must actually be on the hiring team for THIS req.** How you find them depends on company size:

- **Small company / startup (one small roster):** `scan-roster.mjs` + persona-search is fine — the `/people/` roster is on-topic and the right people surface.
- **Large or multi-team company: do NOT trust the roster / generic persona-search.** The `/people/` page is a random subset, and title-only searches ("Engineering Manager at {Co}", "Technical Recruiter") return people with no tie to the team. Instead run a **targeted LinkedIn people search on the JD's TEAM + ROLE**: `"{Company} {Team} {Role}"` , then `"{Company} {Team} lead OR manager OR head"`. Pick:
  - **Hiring Manager / Leader (gold)** = **Head of {Team}** — the actual decision-maker.
  - **Peer** = someone whose headline is the exact team+role.
  - **Recruiter** = a recruiter for that org; prefer the function-matched one.
- **VERIFY every contact's headline shows they're on the hiring team before including them. Drop generic/off-team people** — outreach to someone who can't influence the req wastes the contact.

## Email finding — repeatable process

Once contacts are picked, find a real email for each (so the email drafts are actionable, not just LinkedIn). `gen-outreach.mjs` auto-runs `findEmail` per contact and only attaches a match ≥ `EMAIL_MIN` (80). **It only runs the finder when the spec carries the company `domain`** — set `"domain": "company.com"` on each company object (a Greenhouse/Ashby JD URL does NOT reveal it), or the finder is silently skipped and every contact ships email-less. Run it manually with `node scripts/find-email.mjs`. The process, in order — **stop at the first hit ≥ 80**:

1. **Get the company email domain.** Not the LinkedIn slug — the real mail domain. Find it from the company site, the careers/apply page, or an address already on another contact. Startups are usually `{brand}.ai` / `.com`. The domain, not the name, is what every step needs.
2. **MX gate.** `find-email.mjs` rejects a domain with no MX records (no mailbox lives there) — a wrong domain fails fast here.
3. **Name-based finders** (`find-email.mjs` does these): **Hunter email-finder** (trust its 0–100 score; ≥80 wins) → **company-site scrape** (`/`, `/about`, `/team`, `/contact`, `/people`) → **GitHub commit metadata** (`gh api search/commits` — engineers leak real addresses). These resolve most recruiters/ICs directly.
4. **GitHub-org pattern mining (works with ZERO Hunter quota).** When Hunter is exhausted (`searches 50/50`, `verifications 100/100`) or the name-finders miss, mine the company's **public GitHub org** for real committer addresses to establish the pattern from confirmed data:
   - `gh api "/orgs/{Org}/repos?per_page=20&sort=pushed"` → pick the active repos.
   - `gh api "/repos/{Org}/{repo}/commits?per_page=100"` → extract `.commit.author.email`, keep only `@{domain}`.
   - A handful of real addresses reveals the pattern: five `flast`-shaped addresses ⇒ pattern **`flast@domain` (5/5)**; construct each contact from it.
   - Also `gh api -H "Accept: application/vnd.github.cloak-preview+json" "/search/commits?q=author-name:\"Full Name\""` to try the contact directly (engineers leak real work addresses; common names return noise — verify the repo is the right person).
   - These are **pattern-derived, NOT mailbox-verified** when Hunter's verifier is down. Put them in the HTML with the confidence string `pattern-derived (GitHub flast@domain, N/N) — unverified, prefer LinkedIn`. Use them at the user's discretion; LinkedIn stays the safe first touch.
5. **Pattern + verifier fallback (what cracked the hard ones).** When the name-finders miss (common for senior/HM contacts Hunter doesn't index), **establish the company's address pattern from the contacts that DID resolve** — e.g. two resolved `first@` addresses ⇒ pattern is `first@domain`. Then construct the missing contact's candidate from that pattern and **verify it directly** with `node scripts/find-email.mjs --verify cat@anthropic.com` (Hunter email-verifier). The finder now does this automatically, trying `first@`, `first.last@`, `firstlast@`, `flast@`; pass `--pattern first` to force the known one.
   - **Only trust `status:valid` + `result:deliverable` + `accept_all:false`.** A catch-all domain (`accept_all:true`) returns valid for *every* address and proves nothing — treat those as unverified.
   - **Confidence is capped at 88** for pattern+verifier (an alias can also verify valid), labeled `hunter email-verifier (pattern)` — above the 80 bar, but note "pattern-inferred, verify before send."
5. **Nicknames.** The first-name token drives the pattern, so a nickname drives `first@`. If it doesn't verify, try the likely legal name before giving up.
6. **Never put a sub-80 guess in the HTML as if confirmed.** If nothing clears the bar, leave the email blank and flag it; the LinkedIn drafts still work. Drafts are draft-only regardless — the email is a convenience, not a send trigger.

Commands: `node scripts/find-email.mjs --name "First Last" --domain co.com [--pattern first]` · `node scripts/find-email.mjs --verify addr@co.com`.

## Pipeline

1. **Parse the input.** Extract JD reference + one or more `(persona, linkedin_url)` pairs.
2. **Resolve company + role.**
   - If JD is a URL: navigate with Chrome DevTools MCP (`mcp__chrome-devtools__new_page` then `take_snapshot`). Pull company name, role title, and any signal worth dropping into an observation (new product, team-growth/hiring blurb, mission). Do NOT use funding/raise/investor signals — see the money ban in `ban_compliance`.
   - If JD is text: parse company + role from the text.
3. **Locate the evaluation report.** Look for `reports/{NNN}-{company-slug}-*.md`. If found, load Block B (CV match), Block C (level/strategy), Block F (STAR proof points), and Block G (legitimacy / timing signals). These are the source of truth for the bullets.
   - If absent: fall back to `cv.md` + `config/profile.yml` (`narrative`, `superpowers`, `proof_points`) + `modes/_profile.md`. Tell the user the bullets will be weaker without a report and offer to run `/career-finder offer` first.
4. **Load shared context once** (so every subagent gets the same facts):
   - `cv.md`
   - `config/profile.yml` (candidate, narrative, superpowers, proof_points sections)
   - `modes/_profile.md` (bridge identities, archetype framing)
   - The evaluation report (full text) if present
   - The TEMPLATES block from this mode file
   - The strict style rules above
5. **Fan out: spawn one subagent per persona** (parallel, in a single tool-call message). Use `subagent_type=general-purpose`. Each subagent gets the SUBAGENT PROMPT below with placeholders filled in.
6. **Fan in: collect each subagent's JSON return blob.** Each blob is a `PersonaResult` (schema below).
7. **Write the working JSON** to `output/outreach/{company-slug}-{role-slug}-{YYYY-MM-DD}.drafts.json` (creates the dir if missing).
8. **Render the HTML:** run `node scripts/render-outreach.mjs <path-to-json>`. Output goes to `output/outreach/{company-slug}-{role-slug}-{YYYY-MM-DD}.html`.
9. **Append the outreach log** at `data/outreach-log.tsv` (create with header row if missing). Columns: `date<TAB>company<TAB>role<TAB>persona<TAB>channel<TAB>gold_summary<TAB>jd_url<TAB>html_path<TAB>sent<TAB>response`. Mark `sent` and `response` as `pending`.
10. **Print the HTML path to the user**, plus a one-line send-order recommendation (HM email + connection together same day; recruiter same day; leader as escalation if no response by day 3-4; then ONE follow-up to the primary, then the held-back backup; day 10 silence = dead. ).

NEVER auto-send. Drafts are for the user to review and send manually. This is a hard rule from the project's ethical-use policy.

## Subagent prompt (template -- the main agent fills the `{{...}}` slots)

Spawn each subagent with:

```
You are drafting outreach for ONE persona only.

INPUTS
- Persona type: {{PERSONA_TYPE}}                       # Hiring Manager | Recruiter | Peer | Leader
- LinkedIn URL: {{TARGET_LINKEDIN_URL}}
- Company: {{COMPANY}}
- Role: {{ROLE}}
- JD reference: {{JD_REF}}                              # URL or "text supplied above"
- Channels to draft: {{CHANNELS}}                       # e.g. ["email", "linkedin_connection"]

CONTEXT (verbatim, do not summarize)
- CV: {{CV_MD}}
- Profile narrative: {{PROFILE_NARRATIVE}}
- Profile superpowers + proof_points: {{PROFILE_PROOF}}
- Bridge identities + archetype framing: {{BRIDGE}}
- Evaluation report (Block B / C / F / G): {{REPORT_BLOCKS}}        # or "(none -- fall back to CV)"
- House-style templates for this persona: {{TEMPLATES}}
- Strict style rules: {{STYLE_RULES}}

TASK

Step 1 -- Scrape the LinkedIn profile.
Use Chrome DevTools MCP **attached to the user's logged-in Chrome** (NOT a fresh headless instance — LinkedIn auth-walls unauthenticated contexts):
- mcp__chrome-devtools__new_page (or navigate_page on an existing tab) to TARGET_LINKEDIN_URL
- mcp__chrome-devtools__take_snapshot to read the rendered profile
- If recent posts are visible, capture the most recent 3 with date and topic. Hiring posts trump all others.
- If posts are not visible (gated behind login), fall back to the headline + current role + tenure.
- Capture: full name, current title, current company, tenure, top 3 skills/endorsements (if visible), 3 most recent posts (if visible), 1-2 mutuals if surfaced.

Step 2 -- Fan out (parameter-space generation, NOT 100 prose paragraphs).
For each channel in CHANNELS:
- Define axes:
  - observation_source ∈ {recent_post, hiring_post, role_transition, company_initiative, mutual, skill_endorsement, publication}  (choose only those supported by Step 1 evidence; do NOT invent)
  - bridge_identity ∈ {bridges from Profile} (typically 2-3)
  - proof_combo ∈ {top 5 candidate combinations of 3 bullets pulled from Block B if present, else superpowers + proof_points}
  - opener_tone ∈ {direct, complimentary-but-tight, curious}
  - closer_phrasing ∈ {exact-cta, slight-variant} (LinkedIn uses an approved CTA; email may relax slightly)
  - structure ∈ {template_T1, template_T2} (where two templates exist for this channel)
- Cartesian-product the axes. Score each combination on a rubric (below). Keep the top ~20 by score and only fully draft those (do not waste tokens drafting the obviously-bad ones).
- Target ~100 distinct combinations enumerated; ~20 fully drafted; top 3 returned.

Step 3 -- Score each fully-drafted variant. Rubric (1-5 each, sum is the rank):
- structure_compliance (matches the chosen template's slot order)
- bullet_strength (every reason has a number or named system; vague=0)
- observation_quality (specific, factual, ≤1 sentence, sourced from Step 1 evidence)
- jd_anchor (EXPECTED: the variant references a specific line from the job description and ties a proof point to it. `outreach-judge.mjs` reports a missing JD anchor as a WARN (-10), not a hard fail; fix it before sending, but it does not block the draft.)
- ban_compliance (no em dashes, no clichés, no setup phrases, no emojis-unless-template-allows, NO company money/investors — never cite the raise, valuation, round, "funding," or "backed by [investor]"; the candidate's own $ achievements are fine). Any violation = hard fail; eject the variant.
- length_fit (LinkedIn ≤ 300; email body 100-180 words; subject ≤ 60 chars)
- punch (lead bullet has the strongest hero metric; no padded percentages stacked)
- channel_fit_cta (LinkedIn ends with an approved CTA; HM/leader emails ask for a 15-min chat)

Step 4 -- Fan in. Critique the top 5 in 2-3 sentences each. Pick gold (best overall), silver (best alternative angle), bronze (best safe fallback). Diversity matters: gold and silver should not share the same observation source AND same proof_combo. **Each of gold/silver/bronze must anchor on a DIFFERENT JD line** -- gold on the role's headline ask, silver on the build/integration ask, bronze on the customer/relationship ask (re-pick per posting). The variants are judged primarily on JD-anchoring quality.

Step 5 -- Provenance. For each pick, cite where each bullet came from. Format: `Bullet 2 -> Block B row 5 of report 720` or `Superpower #2 from profile.yml` or `cv.md L26`.

OUTPUT (return ONLY this JSON, no prose around it; use a fenced ```json block)

{
  "persona": "{{PERSONA_TYPE}}",
  "target": {
    "name": "...",
    "headline": "...",
    "company": "...",
    "tenure": "...",
    "linkedin_url": "{{TARGET_LINKEDIN_URL}}",
    "observation_evidence": "verbatim quote or paraphrase of the post/signal you used"
  },
  "channels": [
    {
      "channel": "email" | "linkedin_connection" | "linkedin_dm",
      "char_limit": 300 | null,
      "picks": [
        {
          "rank": "gold" | "silver" | "bronze",
          "subject": "..." (email only; null otherwise),
          "body": "...",
          "char_count": 287,
          "why_picked": "1-2 sentence critique of why this beats silver/bronze",
          "provenance": ["Bullet 1 -> Block B row 1", "Bullet 2 -> Block F STAR #3", "Observation -> recent post 2026-04-28"]
        }
      ]
    }
  ],
  "send_recommendation": "1-2 sentences: when to send, in what order relative to the other personas",
  "warnings": []  // include any issues: "could not access LinkedIn posts (login wall)", "no evaluation report -- bullets are weaker", etc.
}
```

## Output JSON contract (what the renderer expects)

The renderer reads a top-level object:

```
{
  "header": {
    "company": "...",
    "role": "...",
    "date": "YYYY-MM-DD",
    "jd_url": "...",
    "report_path": "reports/720-faros-ai-2026-04-30.md"  // or null
  },
  "candidate": {
    "name": "<outreach.sender_name>",
    "linkedin": "<candidate.linkedin from config/profile.yml>"
  },
  "send_order": "Send HM email + LinkedIn connection together same day. Recruiter same day. Leader as escalation if no response by day 3-4; one follow-up to the primary, then the backup; day 10 = dead.",
  "personas": [ <PersonaResult>, <PersonaResult>, ... ]
}
```

## Output paths

- HTML: `output/outreach/{company-slug}-{role-slug}-{YYYY-MM-DD}.html`
- Working JSON: `output/outreach/{company-slug}-{role-slug}-{YYYY-MM-DD}.drafts.json` (kept for re-renders or audits)
- Log row: `data/outreach-log.tsv` (created on first run with header)

## Browser MCP -- attached session, not headless

The project-wide rule in `CLAUDE.md` is to use Chrome DevTools MCP for all browser automation. **`outreach` adds one constraint on top of that**: attach to the user's already-logged-in Chrome instance — do NOT spin up a fresh headless Chrome. LinkedIn auth-walls unauthenticated contexts, and the attached session is the only way to pull recent posts, mutual connections, and endorsements without surfacing a login wall.

## Failure modes -- handle gracefully

- LinkedIn login wall: degrade to headline + role + tenure. Note in `warnings`. Do not invent posts.
- 404 on JD URL: stop and ask the user for an updated link or the JD text.
- No evaluation report: proceed with `cv.md` + profile, but add a top-of-page banner in the HTML noting "Bullets are weaker without a per-role evaluation. Consider running /career-finder offer first."
- Less than four personas supplied: render only what was asked for. Do not invent missing personas.

## Browser-safe subagent fan-out

**Outreach drafting is parallelized with subagents, but the browser work is NOT.** The project rule "NEVER 2+ agents driving the debug Chrome in parallel" (`_shared.md`) means the per-persona subagents must NOT each scrape LinkedIn — that would race the single debug Chrome on :9222. The codified flow:

1. **Main agent scrapes serially** on the attached Chrome (:9222): run `scan-roster.mjs` for the company, then visit each chosen contact's profile to capture the observation evidence (headline, recent/hiring post, tenure, mutuals). One agent, one browser, sequential.
2. **Then fan out one DRAFTING subagent per persona, in parallel, with NO browser access.** Pass each subagent the scraped contact data + CV + profile narrative + the report's Block B/C/F/G + the persona templates + the strict style rules + the three JD anchors (gold/silver/bronze). The subagent returns the `PersonaResult` JSON only — it does not touch any MCP/browser tool.
3. **Main agent fans in:** assemble the top-level JSON, lint every LinkedIn draft (≤300 chars, approved CTA, no em-dashes), render via `render-outreach.mjs`, append `outreach-log.tsv` (pending/pending), and re-run `outreach-owed.mjs` to confirm 0 owed.

This gives the speed of parallel drafting without ever pointing two agents at the same browser. Draft only, never send.

## No Peer persona by default

**Default outreach personas are Hiring Manager, Recruiter, and Leader — do NOT include Peers unless the user explicitly asks.** Peers cost send-budget without owning the req. Peer templates remain in this mode file for when the user opts in.

## Two people per persona

**During contact discovery, find TWO people per persona (primary + backup) whenever the company's LinkedIn surface allows it.** One contact per persona is a single point of failure: unverifiable email, stale profile, or no reply kills the whole channel. Selection order: **(a) located in the user's `location.metro` first** (LinkedIn location filter), since a local contact is likelier to own local reqs — then (b) closest title match, (c) 1st/2nd-degree with mutuals, (d) most recently active. Note each contact's location in the HTML card. Render both people (primary first, backup labeled). Log both in `outreach-log.tsv`. If a persona genuinely has only one findable person (small company), note it in `warnings` instead of padding with a bad fit.
- Subagent returns malformed JSON: re-prompt that one subagent with the schema and an example, max one retry. If it still fails, render the others and put a placeholder card for the broken persona.

## Future improvements (suggestions to grow this skill over time)

These are deliberate v2+ ideas, not v1 behavior. Surface them when the user asks how to make outreach better:

1. **Reply tracking + pattern mining.** After each send, log `sent_at`, `response_y_n`, `time_to_response`, `outcome`. After ~30 sends, run a pattern analyzer (similar to `scripts/analyze-patterns.mjs`) to learn which observation categories, opener tones, and proof combos correlate with replies. Save the winners as `feedback_*` memories so future drafts default to them.
2. **Persona-level template evolution.** When 10+ sends in a persona accumulate, propose template tweaks ("HM emails with hiring-post observations get 3.2× the reply rate; default to that source when a hiring post exists").
3. **Char-count + ban linter as a script.** `scripts/lint-outreach.mjs <draft.txt>` that validates against the strict rules pre-send. Fast feedback when the user hand-tweaks a draft.
4. **LinkedIn snapshot cache.** Cache scraped LinkedIn profiles for 7 days under `data/linkedin-cache/{slug}.json` so re-runs do not re-hit the browser. Invalidate when the URL is reprovided with a `--fresh` flag.
5. **Multi-language mirrors.** When the user is targeting `modes/de`, `modes/fr`, or `modes/ja`, mirror this mode in those folders with native templates and DACH/Francophone/Japan-specific subject conventions.
6. **A/B at the company level.** When the user is sending to two similar roles at different companies, auto-pick gold for one and silver for the other. Log which version got the response.
7. **Chained follow-ups.** If `data/outreach-log.tsv` shows no response in N days, integrate with `scripts/followup-cadence.mjs` to generate the next-touch draft (different angle, shorter, no repeat of prior bullets).
8. **Recipient warmth scoring.** Pull mutual-count + recent-activity from the LinkedIn snapshot. Score each persona "cold/warm/hot" and adjust the opener tone accordingly. Hot recipients can skip the personalized observation and go straight to the ask.
9. **Subject-line bandit.** Generate 5 subjects per email, pick gold by rubric, but log all 5 and the chosen one. If reply data ever shows a non-gold subject won, update the rubric weights.
10. **Send-on-approval via Gmail MCP.** Add a `--send` flag that, after the user types `OK send <persona>`, posts the gold variant via the Gmail MCP. Hard rule: requires explicit per-message confirmation; never bulk send.
11. **Observation library.** Keep a personal `data/observation-library.tsv` of openers that worked. Surface re-usable phrasings when scraping a profile that doesn't yield a fresh post.
12. **Renderer diff mode.** When the user re-runs outreach for the same role, render a side-by-side of the new picks vs the prior picks so they can pick the better-evolved version.

---

## TEMPLATES (verbatim, do not paraphrase the structure)

### Hiring Manager -- Email Template 1 (T1)

```
Subject: Your Next [Role] - [Your Name]

Hi [Name],

[Interest hook grounded in cv.md and their product], so the [Role] role stood out. I applied and wanted to reach you directly.

[JD subtle-echo opener: ONE line tying to the JD's mission/product in the JD's own words, employer-specific, no announcer]

- [JD-mapped reason 1 with a number or system]
- [JD-mapped reason 2 with a number or system]
- [JD-mapped reason 3 with a number or system]

Would you be open to a short 15-min chat later this week to see if there's a mutual fit?

Best,
[Your Name]
```

Notes: open with the candidate's interest, never a recap of the recipient's own role. Merge the JD sentence and the "three reasons" clause into one line ending in a colon (no orphaned identity line, no "add immediate value" / "Because of these reasons" fluff). Bullets are the 3 JD-mapped proof points.

### Hiring Manager -- Email Template 2 (T2)

```
Subject: Your Next [Role] - [Your Name]

Hi [Name],

You said you're looking for [qualities pulled verbatim from the JD or HM's post] in your next [Role], and I match those qualities. Here's why:

Over the past [X] years, I have:
- [Leadership / role-complexity proof]
- [Key deliverable with metric 1]
- [Key deliverable with metric 2]

Are you open to a 15-minute call to discuss the role? Happy to send a tailored resume with executive endorsements. (Never attach on a cold first email.)

Best,
[Your Name]
```

### Hiring Manager -- LinkedIn Connection (≤300 chars)

```
Hi [First], [interest hook grounded in cv.md], so I applied for the [Role title] role. [JD-anchored pitch clause]. Open to a quick chat?
```

Slot rules:
- *interest hook* the candidate's genuine relevance (never a recap of the recipient's role). Keep it short — the interest hook is longer than a bare observation, so trim it to stay ≤300.
- *JD-anchored pitch clause* ONE clause mapped to a specific JD line; capitalized as its own sentence
- *hero metric* ONE concrete number, not stacked percentages
- *CTA* exact wording, no substitutions

### Recruiter -- Email

```
Subject: Your Next [Role] - [Your Name]

Hi [Name],

I applied for the [Role] role at [Company] today and wanted to put it on your radar directly.

[JD subtle-echo opener: ONE line tying to the JD's mission/product in the JD's own words, employer-specific, no announcer]

- [Highlight 1 with metric]
- [Highlight 2 with metric]
- [Highlight 3 with metric]

Would you be open to chatting about the role?

Best,
[Your Name]
```

Notes: the recruiter email no longer uses the "I hope you are doing well" opener, the "A little about me / Three highlights" announcer, the trailing "Happy to answer any questions" filler. Same merged JD + "three reasons" lead-in as the HM email.

### Recruiter -- LinkedIn Connection (≤300 chars)

```
Hi [Name], [one-sentence observation about background or shared network]. I recently applied for the [Role title] role and believe I'd excel because [one-sentence bridge + hero metric]. Open to a quick chat?
```

### Peer -- LinkedIn Connection (≤300 chars)

DO NOT ask for a job. Ask for perspective, or for a pointer to the hiring manager, or both.

**Variant A — perspective ask (default):**

```
Hi [Name], [one specific observation about their work, post, or tenure]. I recently applied for the [Role] at [Company] and would love your perspective on [team / culture / leadership]. Open to a quick chat?
```

**Variant B — pointer ask (when the peer likely knows the HM):**

```
Hi [Name], [one specific observation about their work, post, or tenure]. I recently applied for the [Role] at [Company]. Do you know who the hiring manager is? Happy to grab time on your calendar if you have thoughts on the team too.
```

**Variant C — perspective + pointer combined (tight, use a short observation):**

```
Hi [Name], [one short observation]. I recently applied for the [Role] at [Company] and would love your perspective on the team. Also, if you know the hiring manager, would you mind a quick intro?
```

**Picking the variant:**
- Default to **A** when the peer is newly tenured (under ~6 months) or in a different function from the role you applied for. They'll have culture context but probably not internal-routing power.
- Prefer **B** when the peer is tenured (1+ years) and in the same function as the role. They almost certainly know who the hiring manager is, and a direct pointer ask saves a hop.
- Use **C** when you want both signal types in one touch. Risk: it's two asks in one message, which can lower response rate. Worth it only when char budget supports a tight observation that leaves room for both.

### Leader -- Email Template 1 (T1)

```
Subject: Your Next [Role] - [Your Name]

Hi [Name],

[Interest hook grounded in cv.md and their product], so the [Role] role at [Company] stood out. I applied and wanted to reach you directly.

[optional JD "why-this-role" sentence]

Two examples:

- [JD-mapped achievement 1 with a hero metric and a system named]
- [JD-mapped achievement 2 with a hero metric and a system named]

Would value connecting with you or [hiring manager first name] about how I can contribute at [Company].

Cheers,
[Your Name]
```

Note: open with the candidate's interest, not a description of the leader's team. The Leader email routes to the HM (the "or [HM first name]" clause), so it stays a 2-example email, not the 3-reasons format.

### Leader -- Email Template 2 (T2)

```
Subject: Your Next [Role] - [Your Name]

Hi [Name],

I recently applied for the [Role] position at [Company]. In my current role at [Company], I [specific achievement with metrics] that directly improved [business outcome].

I'm excited about bringing similar results to your team. If you're not directly involved in the hiring process, would you mind pointing me to the appropriate person?

Best,
[Your Name]
```

### Leader -- LinkedIn Connection (≤300 chars)

Leader closer rule: do NOT use a chat CTA. End with a pointer ask to the hiring manager instead.

```
Hi [Name], [interest hook grounded in cv.md]. [hero clause as its own sentence]. I applied for the [Role] role. If you're not directly hiring, could you point me to the hiring manager?
```

Slot rules:
- *interest hook* → the candidate's relevance (never a recap of the leader's role); join to the hero clause with a period, not a comma, so neither runs on
- *proof slot* → ONE concrete system or pattern the leader will recognize as relevant
- *role slot* → exact role title from the posting
- *closer* → pointer ask. Phrasing may flex (`could you point me to the hiring manager?`, `mind pointing me to the right person?`, `who owns the req?`) but the function is the same: ask for an internal redirect, not a chat with the leader.
