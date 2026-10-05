#!/usr/bin/env node

/**
 * roster-score.mjs — decide WHO gets contacted, from card text alone.
 *
 * Pure functions, no I/O, no browser. That is the point: this module can be
 * replayed over every cached roster in data/rosters/*.json with zero LinkedIn
 * actions, so the ranking can be changed and validated without touching the
 * account. `node scripts/roster-score.mjs --replay` does exactly that.
 *
 * WHY THIS REPLACES THE OLD `SCORERS` TABLE
 * -----------------------------------------
 * A single flat regex score conflates two independent things: how senior someone
 * is (level) and what they do (function). Typical failures of that model:
 *
 *   1. A "Head of <team>" whose headline uses a different word form than the regex
 *      ("Deployed Engineers" vs "engineering") is mis-tagged as a peer and dropped.
 *   2. An IC whose headline lists PAST employers' titles ("ex: Director of
 *      Engineering@OtherCo") is promoted to Leader.
 *   3. Padding the selection to a fixed size seats someone from a different employer.
 *
 * So: parse (level, function) as TWO axes, strip past-employer clauses BEFORE any
 * employer test, and require positive employer evidence for anyone we address as
 * an authority. A documented gap beats a confident stranger.
 */

import { hasTargets, loadTargets, positiveRegex } from './targets.mjs';
import { LOCAL } from './role-filters.mjs';

// ── Exclusions (leaders come from below the C-suite) ──────
export const EXCLUDE_RE = /\b(ceo|cto|coo|cfo|cro|cpo|cio|ciso|chief|founder|co-?founder|president)\b/i;

// ── Axis 1: level ────────────────────────────────────────────────────────
const LEVEL_RES = [
  [5, EXCLUDE_RE],
  [4, /\bvp\b|\bs?vp\b|\bevp\b|vice president/i],
  [3, /\bhead of\b|\bhead,|\bhead\b\s+of|\bdirector\b|\bdirector,/i],
  // "…Leader" / "…Leadership" are common headline forms and must not fall through
  // to level 0 — `lead\b` does NOT match "Leader", so an earlier version of this
  // table read "Engineering Leader" as an individual contributor. Scored as a
  // manager (2) rather than a director, since the form is seniority-ambiguous.
  [2, /\bmanager\b|\bmanager,|\bengineering lead\b|\btech(nical)? lead\b|\bteam lead\b|\bsquad lead\b|\bleader\b|\bleadership\b/i],
  [1, /\b(staff|principal|senior|sr\.?|lead)\b/i],
];

// ── Axis 2: function ─────────────────────────────────────────────────────
// Order matters. `recruiting` is tested first because "technical recruiter"
// contains "technical". `target` is the user's own field, built from config/profile.yml
// (targets.roles + title_keywords, plus outreach.team_functions — the words naming the team
// that hires the role, e.g. ["data", "analytics"]); it is tested before the generic
// categories so a peer or manager in the user's field is classified as such.
// The remaining rows are a generic function taxonomy, not a target list.
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function targetFnRe() {
  if (!hasTargets()) return /$^/;
  const team = (loadTargets().outreach?.team_functions || []).map(String).filter(Boolean);
  const parts = [positiveRegex().source, ...team.map(t => `\\b${esc(t)}\\b`)].filter(p => p && p !== '$^');
  return parts.length ? new RegExp(parts.join('|'), 'i') : /$^/;
}
// Which other functions count as a match / are adjacent for the target function.
// Configure with outreach.adjacent_functions (subset of: engineering, solutions, gtm, product).
function targetAdjacent() {
  return hasTargets() ? (loadTargets().outreach?.adjacent_functions || []) : [];
}
const FN_RES = [
  ['recruiting',  /recruit|talent|sourcer|people ops|people operations|talent acquisition|\bhr\b|human resources/i],
  ['target',      targetFnRe()],
  ['solutions',   /forward deployed|forward deployment|solutions|customer engineer|field engineer|deployment|professional services|implementation|technical success|solutions? architect/i],
  ['gtm',         /revenue|customer success|\bgtm\b|go-to-market|growth|\bsales\b|account executive|\bae\b|partnerships/i],
  ['engineering', /engineer|engineering|software|platform|infrastructure|machine learning|\bml\b|\bai\b|research|data/i],
  ['product',     /product manager|\bpm\b|product owner|design/i],
];

// De-scoping words: real recruiters, but not for THIS req.
const DESCOPE_RE = /\b(coordinator|university|campus|intern|internship|sourcer|early career|new grad)\b/i;

/**
 * Two axes, never one scalar.
 * @returns {{level:number, fn:string, excluded:boolean, teamMatch:boolean}}
 */
export function parseTitle(text, teamTokens = []) {
  const hay = String(text || '');
  let level = 0;
  for (const [lv, re] of LEVEL_RES) { if (re.test(hay)) { level = lv; break; } }
  let fn = 'other';
  for (const [name, re] of FN_RES) { if (re.test(hay)) { fn = name; break; } }
  return { level, fn, excluded: level === 5, teamMatch: matchesTeam(hay, teamTokens) };
}

/** Team-token match, lightly stemmed so "deployed" ~ "deployment", "engineer" ~ "engineering". */
export function matchesTeam(text, teamTokens = []) {
  const hay = stem(text);
  return teamTokens.some(t => t && hay.includes(stem(t)));
}
const stem = s => String(s || '').toLowerCase()
  .replace(/\b(\w+?)(?:ing|ment|ed|ers|er|s)\b/g, '$1')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// ── Employer evidence ────────────────────────────────────────────────────
// The old test was `m[1].toLowerCase().includes(COMPANY_TOKEN)` — a substring
// match, so "Stripe Alternatives Blog" counted as working at Stripe. And it never
// stripped "ex:"/"formerly" clauses, so a past employer's title promoted an IC.
// Two forms, deliberately handled differently:
//
//  COLON form ("... , ex: Meta, Director of Engineering@Snap, VP Engineering@Upstart")
//    introduces a LIST of past roles, so it poisons everything to the END of the
//    string. Stopping at the first comma — which an earlier version of this file
//    did — left "Director of Engineering@Snap, VP Engineering@Upstart" standing,
//    and those promoted an IC to level 4 and into the Hiring Manager slot.
//
//  BARE form ("ex-Google, now VP Engineering at Acme") qualifies only the token
//    that follows it, so it must stop at the next separator or the real current
//    title would be thrown away.
//  BARE-LIST form ("Head of Engineering, Luma AI. Formerly VP@Microsoft, VP@Credit
//    Karma") is the colon form without the punctuation, and it is common. Requiring
//    a `:` or `-` after the keyword meant this was never stripped, so Microsoft and
//    Credit Karma read as the CURRENT employer and evidence came back `other` — which
//    the anti-leak guard treats as "can't confirm they work here" and holds out of
//    auto-pick. That silently dropped Luma AI's Head of Engineering (verified
//    2026-07-26: the run reported `MISSING: Leader` while he sat unselected at
//    level 4 / engineering, exactly the slot the ladder wanted filled).
//    The separator is now optional when a capitalised token or an @handle follows.
// Also deliberately NOT /i, for the same reason as PAST_BARE_LIST_RE: with `i`, the
// `(?=\s*(?:[A-Z]|@))` lookahead would fire on a lowercase word, so a sentence like
// "previously we shipped X" would poison everything after it.
const PAST_LIST_RE = /\b(?:[Ee][Xx]|[Ff]ormerly|[Pp]reviously|[Pp]rev|[Pp]ast)\b\s*(?:[:\-–]\s|(?=\s*(?:[A-Z]|@)))\s*.*$/s;
// BARE form stops at the next separator so a real current title after it survives
// ("ex-Google, now VP Engineering at Acme").
const PAST_ONE_RE = /\b(ex-|ex\s|formerly|previously|prev\.?|alum(?:ni)?)\s*[^,|·•]*/gi;
// BARE-LIST form: "ex-Ironclad, Amplitude, Capital One, Intel" is one comma-separated list of
// PAST employers, not an ex- clause followed by current ones. Stopping at the first comma left
// "Amplitude, Capital One, Intel" standing, which the comma-form employer test then read as the
// CURRENT employer — so BackOps AI's own Head of People & Talent came back `other` and was held
// out of auto-pick as unconfirmable (verified 2026-07-27). A bare ex- followed by a run of
// comma-separated Capitalised names poisons the whole run.
// NOTE: deliberately NOT /i. JS has no scoped flags, so an `i` here would make `[A-Z]`
// match lowercase as well — which swallowed "ex-Google, now VP Engineering at Acme" whole
// and dropped the CURRENT title. The keyword alternation spells both cases instead.
const PAST_BARE_LIST_RE = /\b(?:[Ee][Xx]-|[Ee][Xx]\s|[Ff]ormerly|[Pp]reviously|[Pp]rev\.?|[Aa]lum(?:ni)?)\s*[A-Z][\w.&'-]*(?:\s*,\s*[A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,2})+/g;
const LEGAL_RE = /\b(inc|llc|ltd|corp|co|gmbh|labs?|ai|technologies|technology)\b\.?/gi;

/**
 * Company names must compare equal across the forms LinkedIn actually uses:
 * a slug ("observeai"), a display name ("Observe.AI"), and a suffixed variant
 * ("Observe AI Inc"). Stripping legal suffixes on a WORD boundary alone is not
 * symmetric — "Observe.AI" has a boundary before "AI" and "observeai" does not,
 * so they normalized differently and a company failed to match itself. Verified
 * against observeai.json, and the same asymmetry affects retellai / lumalabsai /
 * soff-ai / exa-ai, i.e. most of this corpus.
 *
 * So compare on a SET of variants: letters-only, and letters-only with a trailing
 * suffix removed. A match on any variant is a match.
 */
function normVariants(s) {
  const letters = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!letters) return [];
  const out = [letters];
  // Strip suffixes REPEATEDLY: "lumalabsai" -> "lumalabs" -> "luma", so the slug
  // still matches a headline that says "at Luma Labs" or just "at Luma".
  let cur = letters;
  for (let i = 0; i < 3; i++) {
    const next = cur.replace(/(ai|labs?|inc|llc|ltd|corp|io|hq|app|hub)$/, '');
    if (next === cur || next.length < 3) break;
    out.push(next); cur = next;
  }
  return out.filter(v => v.length >= 3);
}
const normCo = s => normVariants(s)[0] || '';

/**
 * @returns {'ours'|'other'|'none'}
 *   'ours'  — headline names an employer and it is one of `aliases`
 *   'other' — headline names an employer and it is NOT ours  (hard drop)
 *   'none'  — headline names no employer at all               (cannot confirm)
 */
/**
 * Strip past-employer clauses. MUST run before both the level parse and the
 * employer test — a past title is not a current one, in either direction.
 */
export function currentOnly(text) {
  // Order matters: strip the colon-list and the bare-LIST forms before the bare-ONE form,
  // which stops at the first comma and would otherwise leave the tail of a list standing.
  return String(text || '')
    .replace(PAST_LIST_RE, ' ')
    .replace(PAST_BARE_LIST_RE, ' ')
    .replace(PAST_ONE_RE, ' ');
}

export function employerEvidence(text, aliases = []) {
  const cleaned = currentOnly(text);
  const tokens = [];
  // `@` may be written with or without a following space — "@ Labelbox" and
  // "@Observe.AI" are both ubiquitous on LinkedIn. Requiring \s+ after the @ (as an
  // earlier version did) silently failed the no-space form and pushed genuinely
  // confirmable people into `unconfirmedAuthority` ("Lead Software Engineer@Observe.AI"
  // and "Engineer @LiteLLM" are both real headline shapes).
  // "at" still needs the space, or "at" inside a word would match.
  // Capture up to three words, but only CAPITALIZED continuations, so "at Luma Labs"
  // yields the whole name while "at Uber working on maps" stops at "Uber". Each
  // token then contributes its word-level prefixes ("Luma Labs" -> "Luma Labs",
  // "Luma"), because a headline may name the company more or less fully than the
  // slug does. Word-level, never character-level — character prefixes would let
  // slug "exa-ai" match an unrelated "Exabeam".
  const NAME = "[A-Za-z0-9][\\w.&'-]{0,30}(?:\\s+[A-Z][\\w.&'-]{0,30}){0,2}";
  for (const m of cleaned.matchAll(new RegExp(`@\\s*(${NAME})`, 'g'))) tokens.push(m[1]);
  for (const m of cleaned.matchAll(new RegExp(`\\bat\\s+(${NAME})`, 'gi'))) tokens.push(m[1]);
  // Comma/pipe form: "Head of Engineering, Luma AI." The old pattern captured a SINGLE
  // word and demanded another separator immediately after, so a two-word company name
  // ("Luma AI") or a sentence-final period both failed — and the contact fell through to
  // `none`, i.e. unconfirmable, i.e. held out of auto-pick. Capture the same multi-word
  // capitalised NAME used by the @/at forms, and allow a trailing period.
  const CAP_NAME = "[A-Z][\\w.&'-]{0,30}(?:\\s+[A-Z][\\w.&'-]{0,30}){0,2}";
  for (const m of cleaned.matchAll(new RegExp(`[,|·•]\\s*(${CAP_NAME})\\s*(?=[,|·•.]|$)`, 'g'))) tokens.push(m[1].replace(/\.$/, ''));
  // "Labelbox/Alignerr" — a slash-joined dual employer counts for both halves.
  // "Labelbox/Alignerr" is a dual employer and counts for both halves.
  const split = tokens.flatMap(t => t.split('/'));
  const want0 = new Set(aliases.flatMap(normVariants));
  // LEADING-COMPANY FORM: "Retell AI Solutions Director" — the employer opens the
  // headline with no @, "at" or separator anywhere, so every pattern above misses it
  // and the person lands in `none`, i.e. held out of auto-pick as unconfirmable. That
  // dropped a Solutions Director, a perfectly good hiring manager, off the retellai
  // roster. Only consulted when NO employer token was found at all — if the headline
  // does name an employer elsewhere ("Google Cloud Partner Engineer at Foo"), that
  // named one wins and this rule never runs, so it cannot manufacture a false 'ours'.
  if (!split.length) {
    const w = cleaned.trim().split(/\s+/);
    for (let n = Math.min(3, w.length); n >= 1; n--) {
      if (normVariants(w.slice(0, n).join(' ')).some(v => want0.has(v))) return 'ours';
    }
    return 'none';
  }
  // Word-level prefixes: "Luma Labs Inc" -> ["Luma Labs Inc", "Luma Labs", "Luma"].
  const candidates = split.flatMap(t => {
    const w = t.trim().split(/\s+/);
    return w.map((_, i) => w.slice(0, w.length - i).join(' '));
  });
  const want = new Set(aliases.flatMap(normVariants));
  for (const t of candidates) { if (normVariants(t).some(v => want.has(v))) return 'ours'; }
  return 'other';
}

/** A card whose text is chrome, not a title. The only condition where a profile visit reliably pays. */
export function CORRUPTED(p) {
  const t = String(p?.title || p?.headline || '').trim();
  if (!t) return true;
  if (t === String(p?.name || '').trim()) return true;
  return /sent the following message|shared a post|^\d+:\d+|reacted to|commented on/i.test(t);
}

// ── Size → who we are even looking for ───────────────────────────────────
// At 150 people the Head of the function IS the hiring manager. At 3,000 the Head
// is three levels above the req and will not read cold mail, so we want the
// manager of the specific sub-team — and we drop the Leader persona entirely
// rather than emit a VP who cannot influence the req.
export function ladderFor(employeeCount) {
  const N = Number(employeeCount) || 300;
  if (N < 60)    return { N, hmTarget: 3, leaderTarget: null, alloc: { 'Hiring Manager': 1, Leader: 0, Recruiter: 0, Peer: 2 } };
  if (N < 200)   return { N, hmTarget: 3, leaderTarget: 4,    alloc: { 'Hiring Manager': 2, Leader: 1, Recruiter: 1, Peer: 1 } };
  if (N < 800)   return { N, hmTarget: 3, leaderTarget: 4,    alloc: { 'Hiring Manager': 2, Leader: 1, Recruiter: 1, Peer: 1 } };
  if (N < 2000)  return { N, hmTarget: 2, leaderTarget: 3,    alloc: { 'Hiring Manager': 2, Leader: 1, Recruiter: 1, Peer: 1 } };
  return           { N, hmTarget: 2, leaderTarget: null, alloc: { 'Hiring Manager': 2, Leader: 0, Recruiter: 1, Peer: 2 } };
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * @param ctx {{aliases:string[], teamTokens:string[], jdKeywords:string[], targetLevel:number, fnWanted:string}}
 */
export function scoreCard(p, ctx) {
  const raw = `${p.headline || ''} ${p.title || ''}`.trim();
  const text = currentOnly(raw);                     // past roles never set level
  const { level, fn, excluded, teamMatch } = parseTitle(text, ctx.teamTokens);
  const evidence = employerEvidence(raw, ctx.aliases);
  if (excluded) return { score: 0, level, fn, evidence, teamMatch, excluded: true };

  const target = ctx.targetLevel ?? 3;
  const fnMatch = fn === ctx.fnWanted || (ctx.fnWanted === 'solutions' && fn === 'engineering')
    || (ctx.fnWanted === 'target' && targetAdjacent().includes(fn));
  const jdHit = (ctx.jdKeywords || []).some(k => k && stem(text).includes(stem(k)));

  // Recruiters are NOT judged against the hiring manager's ladder. Their seniority
  // is irrelevant to whether they own this req — they route it either way. Scoring
  // them on level made "Sr Technical Recruiter at Uber", a perfectly good contact,
  // come out at -15 because level 1 sat two rungs below an HM target of 3.
  const levelScored = ctx.persona !== 'Recruiter';
  const levelFit = levelScored ? Math.max(0, 1 - 0.5 * Math.abs(level - target)) : 1;

  let score = 100 * (teamMatch ? 1 : 0)
            + 60 * (fnMatch ? 1 : 0)
            + 40 * levelFit
            + 25 * (evidence === 'ours' ? 1 : 0)
            + 12 * (jdHit ? 1 : 0)
            + 10 * (LOCAL.test(p.location || '') ? 1 : 0)
            - 15 * (DESCOPE_RE.test(text) ? 1 : 0)
            - (levelScored ? 50 * (level > target + 1 ? 1 : 0) : 0)
            - (levelScored ? 40 * (level < target - 1 ? 1 : 0) : 0);
  return { score: Math.round(score), level, fn, evidence, teamMatch, excluded: false };
}

// ── Persona assignment ───────────────────────────────────────────────────
const PERSONA_TAG = { 'Hiring Manager': 'team-manager', Leader: 'team-leader', Recruiter: 'recruiter', Peer: 'peer-role' };
const AUTHORITY = new Set(['Hiring Manager', 'Leader', 'Recruiter']);

/**
 * Is this person's FUNCTION adjacent to the req at all?
 * Without this gate, level alone decides — so an unrelated VP (say, Marketing) gets
 * seated as the Leader for a req they cannot influence. Level is a match target,
 * not a maximand.
 */
function fnAdjacent(fn, fnWanted) {
  if (fn === fnWanted) return true;
  // Generic org adjacency; the user's own field ('target') is configured in the profile.
  const ADJACENT = { solutions: ['engineering', 'gtm'], engineering: ['solutions'], gtm: ['solutions'],
                     target: targetAdjacent() };
  return (ADJACENT[fnWanted] || []).includes(fn);
}

function eligible(persona, s, ladder, ctx) {
  if (s.excluded) return false;
  if (s.evidence === 'other') return false;                 // hard drop, any level
  const adjacent = fnAdjacent(s.fn, ctx.fnWanted);
  switch (persona) {
    case 'Recruiter':
      return s.fn === 'recruiting';
    case 'Hiring Manager':
      return adjacent && s.level >= ladder.hmTarget - 1 && s.level <= ladder.hmTarget + 1;
    case 'Leader':
      return ladder.leaderTarget != null && adjacent
        && s.level >= ladder.leaderTarget && s.level <= ladder.leaderTarget + 1;
    case 'Peer':
      return adjacent && s.level <= 1;
    default: return false;
  }
}

/**
 * @returns {{selection, unresolvedAuthority, missingPersonas, personaCounts, scored}}
 */
export function assignPersonas(people, ctx) {
  const ladder = ctx.ladder || ladderFor(ctx.employeeCount);
  const scored = people.map(p => {
    const s = scoreCard(p, { ...ctx, targetLevel: ladder.hmTarget });
    return { ...p, ...s, relevance: s.score };
  });

  const selection = [];
  const unresolvedAuthority = [];
  const used = new Set();
  // LinkedIn lists some people twice under different profile URLs, so a URL-only
  // dedup is not enough — a replay could return the same person as
  // BOTH hiring-manager slots. Key on normalized name as well.
  const usedNames = new Set();
  const nameKey = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  for (const persona of ['Hiring Manager', 'Recruiter', 'Leader', 'Peer']) {
    const want = ladder.alloc[persona] || 0;
    if (!want) continue;
    // Re-score against this persona's own target level, so a Leader is judged as a
    // Leader rather than against the HM's target.
    const target = persona === 'Leader' ? ladder.leaderTarget : ladder.hmTarget;
    const pool = scored
      .map(p => ({ ...p, ...scoreCard(p, { ...ctx, targetLevel: target, persona }) }))
      .filter(p => !used.has(p.profileUrl) && !usedNames.has(nameKey(p.name)))
      .filter(p => eligible(persona, p, ladder, ctx))
      .sort((a, b) => b.score - a.score);

    let taken = 0;
    for (const p of pool) {
      if (taken >= want) break;
      if (usedNames.has(nameKey(p.name))) continue;   // duplicate surfaced within this pool
      // THE GATE: anyone we cold-email as an
      // authority must be verifiably AT this company. `none` = a bare headline that
      // names no employer — surfaced for manual promotion, never auto-picked.
      if (AUTHORITY.has(persona) && p.evidence !== 'ours' && !p.guestConfirmed) {
        // Dedup here too — LinkedIn's duplicate profile URLs otherwise list the same
        // person twice in the "verify these manually" output.
        if (!unresolvedAuthority.some(u => nameKey(u.name) === nameKey(p.name))) {
          unresolvedAuthority.push({ ...p, persona, why: 'headline names no employer' });
        }
        continue;
      }
      selection.push({ ...p, persona, tag: PERSONA_TAG[persona], relevance: p.score });
      used.add(p.profileUrl); usedNames.add(nameKey(p.name)); taken++;
    }
  }

  const personaCounts = selection.reduce((m, p) => { m[p.persona] = (m[p.persona] || 0) + 1; return m; }, {});
  const wanted = Object.entries(ladder.alloc).filter(([, n]) => n > 0).map(([k]) => k);
  const missingPersonas = wanted.filter(k => !personaCounts[k]);
  // NOTE: no top-up. The old code padded the selection to 6 with whoever ranked
  // next, which is how an employee of a different company got seated as a
  // contact. An unfilled slot is reported, never filled with a stranger.
  return { selection, unresolvedAuthority, missingPersonas, personaCounts, scored, ladder };
}

export function companyAliases(slug, extra = []) {
  const base = String(slug || '').replace(/[-_.]+/g, ' ');
  return [slug, base, base.replace(/\b(ai|labs|inc)\b/gi, '').trim(), ...extra].filter(Boolean);
}

// ── Offline replay harness ───────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('roster-score.mjs') && process.argv.includes('--replay')) {
  const { readFileSync, readdirSync, existsSync } = await import('fs');
  const only = process.argv[process.argv.indexOf('--replay') + 1];
  const files = readdirSync('data/rosters').filter(f => f.endsWith('.json'))
    .filter(f => !only || only.startsWith('--') || f.startsWith(only));
  for (const f of files) {
    let d; try { d = JSON.parse(readFileSync(`data/rosters/${f}`, 'utf8')); } catch { continue; }
    if (!d.people?.length) continue;
    const slug = f.replace(/\.json$/, '');
    const ctx = {
      aliases: companyAliases(slug, [d.company]),
      teamTokens: (process.env.TEAM_TOKENS || '').split(',').filter(Boolean),
      jdKeywords: (process.env.JD_KEYWORDS || '').split(',').filter(Boolean),
      fnWanted: process.env.FN_WANTED || 'target',
      employeeCount: d.employeeCount,
    };
    const r = assignPersonas(d.people, ctx);
    console.log(`\n=== ${slug}  (${d.people.length} people, N≈${r.ladder.N})`);
    for (const p of r.selection) {
      console.log(`   [${p.persona.padEnd(14)} ${String(p.score).padStart(4)}] lvl${p.level} ${p.fn.padEnd(11)} ${p.evidence.padEnd(5)} ${p.name} — ${(p.headline || p.title || '').slice(0, 72)}`);
    }
    if (r.missingPersonas.length) console.log(`   MISSING: ${r.missingPersonas.join(', ')}`);
    if (r.unresolvedAuthority.length) console.log(`   unconfirmed (not auto-picked): ${r.unresolvedAuthority.slice(0, 4).map(p => `${p.name} [${p.persona}]`).join(', ')}`);
  }
}
