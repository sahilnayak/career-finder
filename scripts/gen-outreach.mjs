#!/usr/bin/env node

/**
 * gen-outreach.mjs — Generate per-company outreach drafts JSON from a compact spec,
 * applying the house templates + strict rules (no em dashes, LinkedIn ≤300 + exact CTA,
 * leader pointer-ask, recruiter ":)"). Then render each via render-outreach.mjs.
 *
 * Every channel emits THREE ranked variants (gold / silver / bronze), each leading
 * with a different proof point so the user can pick the angle. The proof points are the
 * three `outreach.default_bullets` in config/profile.yml (or JD-mapped bullets from the
 * spec / data/bullets): gold leads with bullet 1, silver with 2, bronze with 3.
 * The CTA never varies (exact LinkedIn wording; leader pointer-ask).
 *
 * PER-PERSON DIFFERENTIATION (2026-07-26). This header used to read "the observation
 * stays fixed per person — the differentiation is the proof combo", and that was the
 * whole problem: two hiring managers at one company received the same letter with a
 * different first name. Measured across 82 draft files: 112 of 323 same-company gold
 * email pairs shared an identical bullet set in identical order, and 18 were
 * byte-identical after masking the name.
 *
 * What varies per PERSON is the observation, via observationLadder(): their hiring post,
 * then their recent post quoted verbatim, then a shared company line. What deliberately
 * does NOT vary is the proof and the ask, because why the candidate wants this job is a property
 * of the job, not of the reader, and colleagues forward. Where no real per-person signal
 * exists, the fallback is honest and shared rather than invented; outreach-judge.mjs
 * reports the resulting duplication instead of pressuring the generator to fake a
 * difference.
 *
 * Usage:  node scripts/gen-outreach.mjs data/_outreach-spec.json
 * Spec = [{ company, role, jd_url, jd?, people:[{persona,name,title,linkedin,emailObs,liObs}], hmFirstName }]
 *   persona ∈ "Hiring Manager" | "Recruiter" | "Leader"
 *   emailObs = one-sentence opener observation (email)
 *   liObs    = short clause for LinkedIn (HM/recruiter) OR "<initiative> is the same system I shipped at X" (leader)
 *   jd       = optional per-variant JD anchor so each draft references a real line from the posting:
 *              { gold: {email, li, liLeader?}, silver: {...}, bronze: {...} }
 *                email    = why-this-role sentence woven in after the opener
 *                li       = JD-anchored pitch clause for HM/Recruiter LinkedIn
 *                liLeader = shorter JD-anchored hero for Leader LinkedIn (tight budget; falls back to li/default)
 *              When jd is present the variant is judged on how well it ties proof to that JD line (see
 *              modes/outreach.md). Absent -> generic VARIANTS copy.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { findEmail } from './find-email.mjs';
import { requireTargets, timezone } from './targets.mjs';

// Candidate identity and outreach copy come from config/profile.yml (`outreach` + `candidate`).
// Exits with an onboarding message if the profile is missing.
const PROFILE = requireTargets();
const OUT = PROFILE.outreach || {};
const SENDER = String(OUT.sender_name || '').trim() || 'Your Name';
const SENDER_LINKEDIN = (PROFILE.candidate && PROFILE.candidate.linkedin) || '';
// Local date for filenames/headers. targets timezone(): location.timezone, else CAREER_FINDER_TZ,
// else the system zone. toISOString() would roll over at UTC midnight.
const TZ = timezone();

// Confidence threshold for attaching an email to the HTML (goal 2026-06-11:
// only emails matching >= 80% ride along; weaker guesses are flagged, not trusted).
const EMAIL_MIN = 80;

// A spec email counts as already-verified only if its confidence note carries
// a score at/above the bar or our own finder stamp. ("not Hunter-verified"
// must NOT count, so no bare substring matching on "verified".)
// GROUND TRUTH OUTRANKS A SCORE (extended 2026-08-24).
//
// This used to match only a numeric confidence >= 80, so the ONLY way an address could be treated
// as good was a Hunter score. That is backwards for the two strongest kinds of evidence there are:
//   - the message actually DELIVERED (it was sent and did not bounce), and
//   - the company itself published the address (e.g. an auto-reply naming a team contact).
// Both were being overwritten with "below 80% bar, prefer LinkedIn", which tells the reader to
// avoid an address that is provably correct. A spec may now assert VERIFIED or DELIVERED and the
// finder will leave it alone.
const VERIFIED_RE = /\b(8[0-9]|9[0-9]|100)\s*%|>=\s*80%? bar|\bVERIFIED\b|\bDELIVERED\b/i;

// A BOUNCED address is settled in the other direction: SMTP 550 is the mail server stating the
// mailbox does not exist. Never let the finder repopulate or re-flag one, and never re-send to it.
const BOUNCED_RE = /\bBOUNCED\b|\b550\b/i;

// Derive the company email domain: explicit spec `domain` field, else the
// domain of any email already present on a contact.
function specDomain(c) {
  if (c.domain) return c.domain;
  const withEmail = (c.people || []).find(p => p.email && p.email.includes('@'));
  return withEmail ? withEmail.email.split('@')[1] : null;
}

// ---- LinkedIn roster integration (standing rule 2026-06-12) ----
// When the spec carries `linkedin_company`, the FULL /people/ roster is scanned
// (scripts/scan-roster.mjs, cached in data/rosters/) before the HTML is built,
// and when the spec has no hand-picked people (or sets use_roster: true) the
// roster's ranked selection decides the contacts. CEO/CTO/founders are never
// selected (excluded by the scanner).
// Domain tokens from a role title, for roster team-matching. Generic seniority and
// job-family words are dropped: they match everyone and so rank no one. "Early Access
// Deployment Engineer" -> ["deployment", "access"], not ["engineer"].
const GENERIC_ROLE_WORDS = new Set([
  'engineer', 'engineering', 'manager', 'director', 'lead', 'leader', 'head', 'senior', 'staff',
  'principal', 'junior', 'associate', 'specialist', 'consultant', 'architect', 'analyst',
  'the', 'and', 'of', 'for', 'to', 'at', 'in', 'on', 'with', 'a', 'an',
  'i', 'ii', 'iii', 'sr', 'jr', 'new', 'early', 'team', 'technical',
]);
function teamTokensFor(role) {
  return [...new Set(
    String(role || '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .split(/[^a-z]+/)
      .filter(w => w.length >= 3 && !GENERIC_ROLE_WORDS.has(w))
  )].slice(0, 5);
}

const ROSTER_TTL_DAYS = 30;
function loadRoster(c) {
  if (!c.linkedin_company) return null;
  const path = `data/rosters/${c.linkedin_company}.json`;
  const readIt = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null);
  let roster = readIt();
  const fresh = roster && (Date.now() - new Date(roster.scannedAt).getTime()) < ROSTER_TTL_DAYS * 864e5;
  // `partial` snapshots are written incrementally mid-visit and carry no selection.
  // Treating one as a cache hit meant drafting with zero contacts, silently.
  const usable = roster && roster.partial !== true && Array.isArray(roster.selection) && roster.selection.length > 0;
  if (!fresh || !usable) {
    if (fresh && !usable) console.log('roster: cache is PARTIAL (interrupted run) — rescanning.');
    console.log(`roster: cache missing/stale — scanning linkedin.com/company/${c.linkedin_company}/people/ (needs debug Chrome on :9222)...`);
    try {
      // --auto-mode is the default now, but pass depth explicitly: this call used to
      // send NO depth flag at all, which meant a full /people/ sweep even on a
      // 10,000-person company — the exact path that burned ~20 profile visits.
      const depth = c.li_mode === 'roster' ? '--no-auto-mode' : c.li_mode === 'targeted' ? '--search-only' : '';
      // TEAM TOKENS were dead until 2026-07-26. scan-roster.mjs accepts --team-tokens,
      // roster-score.mjs weights `teamMatch` at 100 — the LARGEST term in the ranking —
      // and NOTHING in the repo ever passed the flag. Measured: teamMatch was true for
      // 0 of 1994 roster people across all 19 cached files, so the biggest ranking signal
      // contributed a constant zero and the selection was decided by the smaller terms.
      const tokens = teamTokensFor(c.role);
      const teamArg = tokens.length ? `--team-tokens ${JSON.stringify(tokens.join(','))}` : '';
      execSync(`node scripts/scan-roster.mjs --company ${c.linkedin_company} ${depth} ${teamArg}`.trim(), { stdio: 'inherit', timeout: 40 * 60e3 });
    } catch (e) {
      console.log(`roster scan failed (${String(e).slice(0, 80)}) — using stale cache if present.`);
    }
    roster = readIt();
  }
  if (roster && roster.partial === true) {
    console.log('roster: still partial after scan — refusing to use it (would draft with no contacts).');
    return null;
  }
  return roster;
}
// Roster tag -> persona. Tags come from scan-roster.mjs / roster-score.mjs; matched by shape
// rather than an exact list so a role-specific peer tag ("peer-<family>") still maps to Peer.
const TAG2PERSONA_EXACT = { recruiter: 'Recruiter', 'eng-leader': 'Leader', 'eng-manager': 'Hiring Manager', 'gtm-leader': 'Hiring Manager', gtm: 'Peer' };
function tagToPersona(tag) {
  const t = String(tag || '').toLowerCase();
  if (TAG2PERSONA_EXACT[t]) return TAG2PERSONA_EXACT[t];
  if (/recruit|talent/.test(t)) return 'Recruiter';
  if (/leader|head|vp|director/.test(t)) return 'Leader';
  if (/manager|hm/.test(t)) return 'Hiring Manager';
  return 'Peer';
}

/**
 * ALLOWLIST for the scraped `recentPost` field.
 *
 * The capture is a raw slice of profile innerText, not a post. Its real shape is
 * `<degree> <headline> <age> • <POST BODY>`, so the authored words start after the
 * LAST age marker ("3mo •", "4d •", "2w •"). Everything before that is the person's
 * headline, and most captures contain no post at all: comment threads, reposts,
 * "Recent posts X shares will be displayed here", or the Experience section.
 *
 * This is an allowlist by deliberate choice (panel dissent, 2026-07-26): a denylist
 * of known junk fails OPEN when LinkedIn changes its markup, and failing open puts
 * "Saw your post on Explore Premium profiles" in line one of a cold email. If we
 * cannot positively locate an authored body, we return nothing and the ladder falls
 * through to a safe rung.
 */
const POST_AGE_MARKER = /\b\d+\s*(?:mo|mos|d|w|h|hr|hrs|yr|yrs)\s*•\s*/gi;
// Not their words: a comment they left, or someone else's post they shared.
const NOT_AUTHORED = /\bcommented on a post\b|\breposted this\b|\blikes? this\b|\bshares will be displayed here\b|\bShow all posts\b/i;
// The Experience section, not an update.
const EXPERIENCE_BLOCK = /^(?:Experience|Articles|Documents|Activity|Featured)\b|·\s*(?:Full-time|Part-time|Internship|Contract)\b/i;
// They announced they LEFT. Never write to them about a req at the old employer.
const DEPARTED = /\bstarting a new (?:position|role|job|chapter)\b|\bI'?m joining\b|\bexcited to (?:announce|share) that I(?:'| a)?m joining\b|\bnew position as\b/i;
// Topics that must never be quoted back while asking for a job.
const TOPIC_BLOCK = /\blay ?offs?\b|\blaid off\b|\bRIF\b|\bpassing\b|\bpassed away\b|\bcondolence|\bwar\b|\belection\b|\bpolitic|\bIsrael|\bPalestin|\bgovernment business\b|\bshooting\b|\bICE\b/i;

function authoredPost(raw, name, company) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (NOT_AUTHORED.test(s)) return { ok: false, reason: 'not-authored' };

  // Locate the authored body: text after the LAST age marker.
  POST_AGE_MARKER.lastIndex = 0;
  let lastEnd = -1;
  for (const m of s.matchAll(POST_AGE_MARKER)) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) return { ok: false, reason: 'no-post-marker' };
  let body = s.slice(lastEnd).trim();

  // Strip residual chrome that sits between the age marker and the words: the
  // "Edited •" badge, a leading self-name, and stray emoji.
  body = body.replace(/^(?:Edited|Promoted|Sponsored)\s*•?\s*/i, '');
  const firstName = String(name || '').trim().split(' ')[0];
  if (firstName) body = body.replace(new RegExp(`^${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s:]*`, 'i'), '');
  body = body.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();

  if (EXPERIENCE_BLOCK.test(body)) return { ok: false, reason: 'experience-block' };
  if (TOPIC_BLOCK.test(body)) return { ok: false, reason: 'topic-blocked' };
  if (MONEY_RE.test(body)) return { ok: false, reason: 'money-topic' };
  // "Starting a new position" is only disqualifying when the new employer is NOT the
  // company we're writing about. Joining the TARGET company is one of the best hooks
  // there is; joining a competitor means the contact is stale and must be dropped.
  if (DEPARTED.test(body)) {
    const namesTarget = company && new RegExp(`\\b${String(company).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body);
    if (!namesTarget) return { ok: false, reason: 'departed' };
  }

  // Positive prose test: long enough to be a real clause, mostly lowercase words.
  // Truncated captures ("My br") fail on length, which is correct — a half-word
  // quote is worse than no quote.
  if (body.length < 40) return { ok: false, reason: 'too-short' };
  const words = body.split(/\s+/).filter(w => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
  if (words.length < 7) return { ok: false, reason: 'not-prose' };
  const lower = words.filter(w => /^[a-z]/.test(w)).length;
  if (lower / words.length < 0.5) return { ok: false, reason: 'not-prose' };

  // The QUOTE is what ships, not the body, so it must independently be worth quoting.
  // Without this, "Hey network!" and a bare "Michael T." passed: the body was long
  // but its first sentence, which is all clipPost keeps, was a greeting or a name.
  const q = clipPost(body, 90);
  if (q.length < 30) return { ok: false, reason: 'quote-too-short' };
  if (!/\s/.test(q) || q.split(/\s+/).length < 5) return { ok: false, reason: 'quote-not-prose' };
  // A quote opening with a bare pronoun refers to something the reader can see and we
  // cannot. Real capture: "It keeps happening every few months or years." Quoting that
  // back signals the post was never actually read.
  if (QUOTE_BACKREF.test(q)) return { ok: false, reason: 'quote-contextless' };

  return { ok: true, text: body, reason: null };
}

/**
 * Clip an authored post to a quotable fragment. The old trimHook split on `•` first,
 * which every capture starts with, so it routinely returned the empty string and
 * shipped the literal "Saw your post on ." Now the body is already isolated, so this
 * only has to end on a clean word boundary.
 */
// A greeting is not a quote. Real captures open with "Hey network!", "Hi everyone!",
// "Excited to share!" — keeping only the first sentence there quotes the salutation.
const GREETING = /^(?:hey|hi|hello|good (?:morning|afternoon|evening))\b[^.!?]{0,24}[.!?]?$|^(?:excited|thrilled|happy|proud)[^.!?]{0,12}[.!?]$/i;
// A quote that opens by pointing at something we cannot see.
const QUOTE_BACKREF = /^\s*(?:it|this|that|these|those|they|them|he|she|there)\b/i;
// Words a truncated quote must never end on: the reader is left mid-thought.
const DANGLING_TAIL = /\s+(?:i|i'm|im|we|we're|they|the|a|an|and|or|but|to|of|for|with|that|which|is|was|are|were|has|have|had|it|its|this|my|our|your|as|at|in|on|by|from|so|if|when|after|before|about)$/i;
function clipPost(s, max = 90) {
  // Inner quote marks would nest inside the outer quote and break the sentence
  // (real capture: `Such an awesome read!! Voice and health AI ... (“Jarvis`).
  const clean = String(s).replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  let t = '';
  for (const sen of sentences) {
    if (!t && GREETING.test(sen)) continue;               // skip a leading salutation
    t = t ? `${t} ${sen}` : sen;
    if (t.length >= 40) break;                            // enough to be a real quote
  }
  if (!t) t = clean;
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '');
  t = t.replace(/[\s,;:.–—(-]+$/, '');
  // Truncation lands mid-thought ("...from a couple of months ago, I'm"). Walk back
  // past trailing function words, and past a trailing comma clause if one remains,
  // so the quote ends somewhere a reader can stop.
  let prev;
  do { prev = t; t = t.replace(DANGLING_TAIL, '').replace(/[\s,;:–—(-]+$/, ''); } while (t !== prev);
  if (DANGLING_TAIL.test(t) || /,$/.test(t)) t = t.replace(/,\s*[^,]*$/, '');
  return t.trim();
}

/**
 * Format an authored post as a quotable fragment, punctuated honestly.
 *
 * The scrape truncates at ~280 chars, so most quotes END MID-SENTENCE. Appending a
 * period to a fragment produces `"...has been made safe for."`, which reads like a
 * transcription error. A fragment gets an ellipsis; a complete sentence gets a period.
 */
function quotePost(text, max = 90) {
  const clip = clipPost(text, max);
  const source = String(text).replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  // Complete only if the clip consumed a full sentence from the source.
  const complete = /[.!?]$/.test(clip) || new RegExp(`${clip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.!?]`).test(source);
  const inner = clip.replace(/[.!?]+$/, '');
  return complete ? `"${inner}."` : `"${inner}..."`;
}

// A hiring post is the highest-signal observation in modes/outreach.md ("they literally
// asked"), so it gets its own rung above a generic authored post.
const HIRING_POST = /\b(we'?re |we are |i'?m |i am )?(hiring|recruiting)\b|\bjoin (my|our) team\b|\bopen role|\bwe'?re looking for\b|\bopen (position|req)\b/i;

/**
 * The observation ladder. Returns { emailObs, liObs, observationSource }.
 *
 * Rung 1  authored HIRING post   — they asked publicly; strongest hook that exists.
 * Rung 2  authored topical post  — quoted verbatim, which is both honest and provably read.
 * Rung 3  company/product line   — shared across recipients, NOT rotated (see call site).
 *
 * Quoting verbatim is what makes rung 2 deterministic. Turning a post into a clean
 * topic phrase ("your post about eval harnesses") needs a summarization step; a quote
 * needs none and cannot drift from what they actually wrote.
 */
function observationLadder({ hook, hiring, company, role }) {
  // `obs` is the observation SENTENCE ALONE; `emailObs` is the full opener (observation
  // + the applied line). Personas that need their own applied line — the recruiter needs
  // a findable req handle, not "wanted to reach you directly" — compose from `obs`.
  if (hook && hiring) {
    const obs = 'Saw your post about hiring.';
    return {
      obs,
      emailObs: `${obs} I applied for the ${role} role at ${company} and wanted to reach you directly.`,
      liObs: 'saw your post about hiring',
      observationSource: 'hiring-post',
    };
  }
  if (hook) {
    const obs = `Saw your recent post: ${quotePost(hook, 90)}`;
    return {
      obs,
      emailObs: `${obs} I applied for the ${role} role at ${company} and wanted to reach you directly.`,
      // Strip the quote marks AND every trailing period: quotePost ends a truncated
      // fragment with "..." , so removing only one left "..", which is a render-bug tell
      // the judge HARD-fails.
      liObs: `saw your recent post (${quotePost(hook, 42).replace(/^"|"$/g, '').replace(/\.+$/, '')})`,
      observationSource: 'recent-post',
    };
  }
  const obs = `I've been following what ${company} is building, so the ${role} role stood out.`;
  return {
    obs,
    emailObs: `${obs} I applied and wanted to reach you directly.`,
    liObs: `I've been following what ${company} is building`,
    observationSource: 'company-template',
  };
}
function peopleFromRoster(c, roster) {
  // No Peer persona by default (standing rule, user-set 2026-06-10): peers cost
  // send-budget without owning the req. Opt back in with `include_peers: true`
  // in the spec. HM / Recruiter / Leader always pass through.
  let selection = roster.selection || [];
  if (!c.include_peers) selection = selection.filter(s => tagToPersona(s.tag) !== 'Peer');
  return selection.map(s => {
    // role phrase: first segment only, drop "@ Company", bracketed asides, and
    // anything after a separator; cap length so LinkedIn drafts stay under 300.
    let roleText = (s.headline || s.title || '')
      .split(/[|•\[(]/)[0]
      .replace(/\s+@\s+.*/i, '')
      .trim();
    // headline often already ends in "at {Company}" — strip it so the observation,
    // which appends " at {company}", doesn't duplicate ("Recruiter at Anthropic at Anthropic").
    // Strip "at {Company}" ANYWHERE, not just at the end — a headline like
    // "Head of X at Luma AI | building Y" kept the clause, then the 40-char truncation
    // below sliced it to "...at Lu" -> "...at", and the template appended " at Luma AI"
    // again, rendering "at at Luma AI" (real, shipped 2026-07-26).
    const coRe = new RegExp('\\s+at\\s+' + c.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig');
    roleText = roleText.replace(coRe, ' ').replace(/\s+/g, ' ').trim();
    if (roleText.length > 40) roleText = roleText.slice(0, 40).replace(/\s+\S*$/, '');
    // Truncation can still strand a dangling connector ("Strategic Initiatives &
    // Executive", "Head of Forward Deployed Creatives at"). Drop trailing connectors
    // and conjunctions so the fragment reads as a whole phrase.
    roleText = roleText.replace(/[\s,&|/-]+$/, '').replace(/\s+(at|of|for|and|&|the|to|in|on|with)$/i, '').trim();
    // scan-roster captures the most recent post on every profile it visits, and the
    // capture is mostly LinkedIn activity chrome. Measured 2026-07-26 across the cached
    // rosters: 115 selected contacts, 97 with a captured post, and the old
    // `length >= 25 && <= 180` gate admitted 20 — of which 20 were chrome
    // ("<name> commented on a post", "Articles Documents") and 6 trimmed to
    // empty, rendering the literal string "Saw your post on ." Meanwhile ~68 genuinely
    // authored posts were rejected. authoredPost() is an ALLOWLIST for that reason: a
    // denylist of known junk fails OPEN when LinkedIn changes its markup, and the
    // failure mode of failing open is chrome in line one of a cold email.
    const post = String(s.recentPost || '').replace(/\s+/g, ' ').trim();
    const authored = authoredPost(post, s.name, c.company);
    const hook = authored.ok ? authored.text : null;
    return {
      persona: s.persona || tagToPersona(s.tag),
      name: s.name,
      title: s.headline || s.title || `at ${c.company}`,
      linkedin: s.profileUrl,
      recentPost: post || null,
      postReject: authored.ok ? null : authored.reason,
      // Hard-drop: the "post" says this person has LEFT the company. Writing to them
      // about a req there is the worst failure mode there is.
      departed: authored.reason === 'departed',
      // THE OBSERVATION LADDER (2026-07-26). Ordered rungs, each firing only when its
      // backing field actually exists. modes/outreach.md has specified six categories
      // since April; the code implemented two, and the lower one was a constant.
      //
      // The fallback rung is deliberately SHARED across recipients rather than rotated
      // per person. Why the candidate wants this
      // job is a property of the job, not of the reader, and colleagues forward. A shared
      // honest floor beats a rotated fake one. Real per-person difference comes from
      // rungs 1-2, which are real only when the person actually posted something.
      ...observationLadder({ hook, hiring: authored.ok && HIRING_POST.test(hook || ''), company: c.company, role: roleDisplay(c.role) }),
      rosterPicked: true,
    };
  });
}

// Upgrade contacts in place: try the finder for anyone without a >=80% address.
async function upgradeEmails(c) {
  const domain = specDomain(c);
  if (!domain || !Array.isArray(c.people)) return;
  for (const p of c.people) {
    if (isPlaceholder(p.name)) continue;
    if (p.email && VERIFIED_RE.test(p.email_confidence || '')) continue;
    // The spec supplied an address: trust it, no network lookup (flag it if unscored).
    if (p.email) {
      if (!p.email_confidence) p.email_confidence = 'supplied in spec (unverified)';
      continue;
    }
    // A recorded bounce is evidence, not a gap to fill. Leave the cleared address cleared.
    if (BOUNCED_RE.test(p.email_confidence || '')) { p.email = ''; continue; }
    const r = await findEmail({ name: p.name, domain, threshold: EMAIL_MIN });
    if (r.email) {
      p.email = r.email;
      p.email_confidence = `${r.confidence}% via ${r.source} (>=${EMAIL_MIN}% bar)`;
      console.log(`email finder: ${p.name} -> ${r.email} (${r.confidence}%, ${r.source})`);
    } else if (p.email) {
      // keep the spec's guess but mark it explicitly below the bar
      if (!/below \d+% bar/.test(p.email_confidence || '')) {
        p.email_confidence = `${p.email_confidence || 'unscored guess'} - below ${EMAIL_MIN}% bar, prefer LinkedIn`;
      }
      console.log(`email finder: ${p.name} — no match >=${EMAIL_MIN}% (${r.reason}); keeping spec guess flagged below bar`);
    } else {
      console.log(`email finder: ${p.name} — no match >=${EMAIL_MIN}% (${r.reason})`);
    }
  }
}

// Auto-discover the evaluation report for a company in reports/ so the rendered
// HTML links it instead of warning "no report found". Spec `report` field wins;
// otherwise newest reports/{num}-{slug}-{date}.md whose slug-part matches the
// company slug (full slug first, then its first token, e.g. "hippocratic-ai" -> "hippocratic").
//
// BINDS TO THE REQUISITION, NOT THE COMPANY (2026-07-26). The old version matched on
// the company slug and returned the NEWEST hit, which is wrong at any employer with more
// than one posting: it can attach a report for a different req at the same employer while
// the report whose **URL:** equals the spec's jd_url sits unused.
//
// Order now: (1) exact jd_url match against the report's **URL:** header, (2) role-slug
// overlap, (3) slug-only ONLY when the company has exactly one report, (4) refuse.
// Refusing is a feature: loadStars then returns nothing and render-outreach shows its
// existing "no report" banner, which is honest. Attaching the wrong 3.9/5 report is not.
function reportUrl(file) {
  try {
    const head = readFileSync(`reports/${file}`, 'utf-8').slice(0, 4000);
    const m = head.match(/^\*\*URL:\*\*\s*(\S+)/mi);
    return m ? m[1].trim().replace(/[),.]+$/, '') : null;
  } catch { return null; }
}
const canonUrl = u => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

function findReport(c, slugFn) {
  if (c.report) return c.report;
  if (!existsSync('reports')) return null;
  const full = slugFn(c.company);
  const head = full.split('-')[0];
  const files = readdirSync('reports').filter(f => /^\d+-.+\.md$/.test(f));
  const slugPart = f => f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
  const squash = s => s.replace(/-/g, '');
  const sq = squash(full);

  // Every report plausibly belonging to this company (not just the newest).
  const candidates = files.filter(f => {
    const s = slugPart(f), ss = squash(s);
    if (s === full || s === head) return true;
    if (ss === sq) return true;
    if (sq.length >= 4 && ss.startsWith(sq) && s.split('-')[0].startsWith(head)) return true;
    return false;
  });
  if (!candidates.length) return null;

  // 1. exact requisition match on the report's URL header.
  if (c.jd_url) {
    const want = canonUrl(c.jd_url);
    const exact = candidates.find(f => want && canonUrl(reportUrl(f)) === want);
    if (exact) return `reports/${exact}`;
  }

  // 2. role-slug overlap: the report slug carries the role after the company token.
  const roleTokens = new Set(slugFn(c.role || '').split('-').filter(t => t.length > 2));
  if (roleTokens.size) {
    const scored = candidates
      .map(f => {
        const tokens = slugPart(f).split('-').filter(t => t.length > 2);
        const hits = tokens.filter(t => roleTokens.has(t)).length;
        return { f, hits, ratio: hits / roleTokens.size };
      })
      .filter(x => x.hits >= 2 || x.ratio >= 0.5)
      .sort((a, b) => b.hits - a.hits || (a.f < b.f ? 1 : -1));
    if (scored.length) return `reports/${scored[0].f}`;
  }

  // 3. unambiguous company: exactly one report, so slug-only matching is safe.
  if (candidates.length === 1) return `reports/${candidates[0]}`;

  // 4. refuse rather than attach the wrong requisition.
  console.log(`report: ${c.company} has ${candidates.length} reports and none matches this requisition (jd_url or role) — attaching NONE. Set spec.report to override. Candidates: ${candidates.slice(0, 5).join(', ')}`);
  return null;
}

// Parse Block F (Interview Plan / STAR) items from a report. Handles both the
// numbered-list format and the STAR+R table format. Stops before any "Red flag"
// / objection-handling subsection so those Q&As never leak into a draft.
// Returns sanitized plain-text bullets usable in email bodies.
// Collapse an inline "S: ... T: ... A: ... R: ..." scaffold (used when a Block F
// table packs all four STAR beats into one "story" cell instead of separate
// columns) into a clean email-ready sentence: keep the headline before S:, then
// the Action + Result (the punchy halves), dropping the S/T labels entirely.
function destarInline(s) {
  if (!/\bS:\s/.test(s) || !/\b[AR]:\s/.test(s)) return s;
  const head = s.split(/\bS:\s/)[0].replace(/[.\s]+$/, '').trim();
  const grab = label => {
    const m = s.match(new RegExp(`\\b${label}:\\s*(.*?)(?=\\s*\\b[STAR]:\\s|$)`));
    return m ? m[1].replace(/[.\s]+$/, '').trim() : '';
  };
  const tail = [grab('A'), grab('R')].filter(Boolean).join(', ');
  return tail ? `${head}: ${tail}` : head;
}
function sanitizeStar(s) {
  return destarInline(s.replace(/\*\*/g, ''))
    .replace(/\s*→\s*/, ': ').replace(/\s*→\s*/g, ', then ')
    .replace(/↔/g, '/').replace(/−/g, '-').replace(/\s*—\s*/g, ', ').trim();
}
function loadStars(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return [];
  const md = readFileSync(reportPath, 'utf-8');
  // F section ends at the next ## OR the first ### subheading OR a red-flag header.
  const m = md.match(/## F[\)\s][^\n]*\n([\s\S]*?)(?=\n### |\n## |\n\*\*Red flags|\nRed-flag|\n#### )/i);
  if (!m) return [];
  const block = m[1];
  // Table format: rows like | # | JD requirement | STAR+R story | S | T | A | R | Reflection |
  const rows = block.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l));
  if (rows.length) {
    return rows.map(r => {
      const cols = r.split('|').map(c => c.trim());
      // cols: ['', #, JD req, STAR+R story, S, T, A, R, Reflection, '']
      const story = cols[3] || '';
      const result = cols[7] || '';
      const bullet = result && !/^n\/?a$/i.test(result) ? `${story}: ${result}` : story;
      return sanitizeStar(bullet);
    }).filter(Boolean);
  }
  // Numbered-list format: "1. **headline** → tail"
  return block.split('\n').map(l => l.match(/^\d+\.\s+(.*)$/)).filter(Boolean).map(x => sanitizeStar(x[1]));
}

// Pick a report STAR bullet that COMPLEMENTS the variant's lead resume proof
// (never one that repeats the same story — the lead bullet already tells it).
// "Same story" = shares a distinctive token (number, $ amount, or capitalised proper noun).
function distinctiveTokens(t) {
  return new Set((String(t || '').match(/\$[\d,.]+[KMB]?|\b\d+%|\b\d{2,}\+?|(?<=\s)[A-Z][A-Za-z0-9]{2,}\b/g) || []).map(x => x.toLowerCase()));
}
function starFor(rank, stars, leadKey) {
  if (!stars.length) return null;
  const sig = distinctiveTokens(B[leadKey]);
  return stars.find(s => ![...distinctiveTokens(s)].some(t => sig.has(t))) || null;
}

const spec = JSON.parse(readFileSync(process.argv[2], 'utf-8'));

// Company DISPLAY name. The ATS parsers title-case whatever the board reports, so the
// ledger carries "Openai" — which then rendered in every subject line and opener as
// "Your Next Early Access Deployment Engineer" / "at Openai" (shipped 2026-07-26).
// Getting a company's own name wrong in the subject is the fastest way to look automated.
// Keys are lowercased-alphanumeric; add entries as new employers surface.
const DISPLAY_NAMES = {
  openai: 'OpenAI', github: 'GitHub', gitlab: 'GitLab', youtube: 'YouTube',
  deepmind: 'DeepMind', huggingface: 'Hugging Face', linkedin: 'LinkedIn',
  paypal: 'PayPal', tiktok: 'TikTok', dbt: 'dbt Labs', ibm: 'IBM',
  aws: 'AWS', nvidia: 'NVIDIA', sap: 'SAP', vmware: 'VMware', mongodb: 'MongoDB',
  postgresql: 'PostgreSQL', elasticsearch: 'Elasticsearch', jpmorgan: 'JPMorgan',
};
for (const c of spec) {
  const key = String(c.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (DISPLAY_NAMES[key]) c.company = DISPLAY_NAMES[key];

  // Observation fallback for HAND-WRITTEN specs. The roster path builds emailObs/liObs
  // itself, but a spec that lists people[] directly had neither, so the templates
  // interpolated the string "undefined" straight into the body ("Hi Scott, undefined, so
  // I applied...") — and it rendered, because nothing checked. Never let a missing field
  // reach a draft.
  // HARD CAP (user-set 2026-08-18): at most TWO Recruiter contacts per outreach set — one
  // primary + one backup. A third recruiter at one company reads as a blast and spends
  // budget with no additional reply surface (all three recruiter wins came from a single
  // primary). Deterministic: keep the first two in spec order, drop and warn on the rest.
  if (Array.isArray(c.people)) {
    let seen = 0;
    c.people = c.people.filter(p => {
      if (!/^Recruiter\b/i.test(p.persona || '')) return true;
      seen += 1;
      if (seen > 2) { console.warn(`recruiter cap: dropping ${p.name} (${seen} recruiters in spec; hard cap is 2 — primary + backup)`); return false; }
      return true;
    });
  }
  for (const p of (c.people || [])) {
    if (!p.emailObs) p.emailObs = `I've been following what ${c.company} is building, so the ${c.role} role stood out. I applied and wanted to reach you directly.`;
    if (!p.liObs) p.liObs = `I've been following what ${c.company} is building`;
  }
}
// LOCAL date, not UTC (see TZ above).
const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
// The OUTREACH BRIDGE: one identity sentence between the opener and the bullets, ending in a
// colon so it leads them ("I'm a ... Three things I'd bring to {company}:"). Read from
// config/profile.yml `outreach.bridge`; {company} and {n} are substituted per draft.
const BRIDGE = String(OUT.bridge || '').trim() || null;
const NUMWORD = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };
// n = how many bullets this template actually renders. Leader and Peer deliberately run a
// SHORTER two-bullet body, so a hardcoded "Three reasons" in the profile line would promise
// three and deliver two. The announcer's count is rewritten to match what follows it.
const bridge = (co, n = 3) => {
  if (!BRIDGE) return '';
  let t = BRIDGE.replace(/\{company\}/g, co).replace(/\{n\}/g, String(n)).trim();
  // A plain identity sentence (no announcer) gets one appended, so the paragraph always ends in
  // the colon that leads the bullets.
  if (!t.endsWith(':')) t = `${t.replace(/[.\s]+$/, '')}. Three things I'd bring to ${co}:`;
  // The announcer noun is not always "reasons" (2026-08-24: the bridge now reads "Three things
  // I'd bring to X:"). Match the noun as well as the number, and preserve whichever noun the
  // profile actually uses, so a Leader or Peer email that renders TWO bullets says "Two things",
  // not "Three things". Getting this wrong promises three and delivers two, in the first
  // paragraph a hiring manager reads.
  // PRESERVE THE ORIGINAL CAPITALISATION. The announcer is not always sentence-initial: the
  // bridge can read "... Here are three reasons I could provide value for X:", where a
  // hard-capitalised replacement yields "Here are Three reasons" mid-sentence. Match the number
  // word too, and lower-case the replacement whenever the original was lower-case.
  return t.replace(/\b(One|Two|Three|Four|Five|\d+)\s+(reasons?|things?|points?)\b/i,
    (_m, num, noun) => {
      const singular = /s$/i.test(noun) ? noun.slice(0, -1) : noun;
      let word = NUMWORD[n] || String(n);
      if (!/^[A-Z0-9]/.test(num)) word = word.toLowerCase();
      return `${word} ${singular}${n === 1 ? '' : 's'}`;
    })
    // Subject-verb agreement when the count collapses to one. A Leader email renders a single
    // bullet, so "Here are three reasons" becomes "Here are one reason" unless the verb moves too.
    .replace(/\b([Hh]ere)\s+are\s+(one\s+)/g, (_m, here, one) => `${here} is ${one}`);
};

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Strip location qualifiers from the role for the COPY/subject (the filename/slug keeps the full
// role). Removes "(Remote)", "(Hybrid)", "({your city})", "(... Area)", etc., but leaves
// meaningful tags like "(Platform Team)" intact. Cities come from config `location`.
const escRe = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOC_WORDS = [PROFILE.location?.city, PROFILE.location?.metro, PROFILE.location?.state,
  ...(PROFILE.location?.cities || [])].filter(Boolean).map(x => escRe(String(x).toLowerCase()));
const LOC_PAREN = new RegExp(`\\s*\\((?:${[...LOC_WORDS, 'remote', 'hybrid', 'on-?site', 'us', 'usa', 'emea', 'apac', '[^)]*\\barea\\b'].join('|')})\\)`, 'gi');
const roleDisplay = r => r.replace(LOC_PAREN, '').trim();
// Placeholder names like "(TBD - Acme hiring manager)" (used when LinkedIn is OFF
// and contacts aren't resolved yet) must NOT leak into salutations. Render them as a
// clean fallback ("Hi there,") instead of "Hi (TBD,". Real names render first-name as usual.
const isPlaceholder = n => !n || /TBD/i.test(n) || String(n).trim().startsWith('(');
const first = n => isPlaceholder(n) ? 'there' : String(n).trim().split(' ')[0];
const art = w => (/^[aeiou]/i.test(w) ? 'an' : 'a');
// Keep a post hook short enough that a LinkedIn note stays under the 300-char cap:
// clip to the first clause and cap at ~70 chars on a word boundary.
const trimHook = (s) => {
  let t = String(s).split(/[—–|·•]/)[0].trim();
  if (t.length > 70) t = t.slice(0, 70).replace(/\s+\S*$/, '');
  return t.replace(/[,;:]\s*$/, '');
};

// FALLBACK BULLET BANK: the three standing bullets from config `outreach.default_bullets`.
// Each must be a COMPLETE SENTENCE that reads correctly in any position, because the
// variants reorder them (VORDER).
const DEFAULT_BULLETS = (Array.isArray(OUT.default_bullets) ? OUT.default_bullets : [])
  .map(x => String(x || '').trim()).filter(Boolean).slice(0, 3);
if (DEFAULT_BULLETS.length < 3) {
  console.warn('outreach: config/profile.yml outreach.default_bullets should hold 3 bullets; drafts will be thin until onboarding fills them.');
}
const B = { b0: DEFAULT_BULLETS[0] || '', b1: DEFAULT_BULLETS[1] || DEFAULT_BULLETS[0] || '', b2: DEFAULT_BULLETS[2] || DEFAULT_BULLETS[0] || '' };

/**
 * PER-PERSONA CTA (researched and reset 2026-08-26).
 *
 * Was one string for everyone: "Would you be free for a chat as a next step?". The default is
 * now "Open to a quick chat?".
 *
 * WHY, and the argument against it, because the panel split on this. FOR: a one-word reply fully
 * discharges the ask. The old wording forces three private decisions before "sure" is honest -
 * check the calendar, pick a modality, and decide whether authorising an interview-adjacent
 * conversation is even theirs to do alone. Published cold-outreach work points the same way
 * (interest-framed CTAs beating meeting-request CTAs across a 304k-email study), though that is
 * B2B sales data and only the direction transfers, not the numbers.
 *
 * AGAINST, recorded because it is a fair point: "as a next step" told the recipient what happens
 * next, and dropping it can leave "a chat about what?" unanswered. That failure mode is real but
 * it is a failure of the SENTENCE BEFORE the ask, not of the ask. Hence CTA_NEEDS_TOPIC below:
 * the clause preceding the CTA must name something concrete, and the generator checks it.
 *
 * NOT frozen to one string. The channel is n=3 sends at one company on one day, so no phrasing
 * here is evidence-backed. The judge accepts any string in the approved set rather than one exact
 * match, specifically so an alternative stays testable later. Hard-coding a single phrase would
 * destroy the ability to ever compare.
 */
// Lowercase the first letter after the semicolon joining APPLIED to WANT. A semicolon links two
// closely-related independent clauses and the second does not take a capital unless it is a proper
// noun or the pronoun I.
const lower1 = (t) => {
  const v = String(t || '');
  if (!/^[A-Z]/.test(v)) return v;
  if (/^I\b|^I'/.test(v)) return v;              // the pronoun I
  if (/^[A-Z][a-z]*[A-Z]/.test(v)) return v;     // CamelCase product names
  if (/^[A-Z][a-z]+ [A-Z]/.test(v)) return v;    // "Acme Cloud" style proper nouns
  return v[0].toLowerCase() + v.slice(1);
};

const CTA_BY_PERSONA = {
  'Hiring Manager': 'Open to a quick chat?',
  Recruiter: 'Open to a quick chat?',
  Peer: "Any advice you'd share?",
};
const CTA = CTA_BY_PERSONA['Hiring Manager'];          // default when a persona is unrecognised
const ctaFor = (persona) => CTA_BY_PERSONA[persona] || CTA;
const subj = `Your Next %ROLE% - ${SENDER}`;

// RULE: never mention the company's money raised / valuation / "backed by [investor]".
// (The candidate's own dollar achievements like "$200K+ in retention" are fine — those are proof, not company funding.)
// Bans the COMPANY's money, never the candidate's own results. The bare verb `\braised\b`
// used to match, so "shipped custom reporting that RAISED customer engagement 25%" — his own
// proof point, explicitly allowed by modes/outreach.md — was flagged as a funding mention on
// 6 drafts (2026-07-27). A checker that cries wolf on legitimate proof points pressures the
// writer into deleting them, which is the opposite of the rule's intent. `raised` now only
// counts when a funding object follows it.
const MONEY_RE = /\bbacked by\b|\braised\s+(?:over\s+|nearly\s+|about\s+|~)?\$|\braised\s+(?:a|its|their)\s+(?:seed|series|round)\b|\bseries [a-e]\b|\bseed round\b|\bfunding\b|\bvaluation\b|\bvalued at\b|\$\s?\d[\d.,]*\s?(m\b|million|bn\b|billion)\b|\b(ventures|capital partners)\b/i;
function flagMoney(label, text) {
  if (text && MONEY_RE.test(text)) {
    const hit = text.match(MONEY_RE)[0];
    console.log(`MONEY/BACKING mention ("${hit}") in ${label} — remove it (rule: never cite the company's raise or investors).`);
    return 1;
  }
  return 0;
}

// Three ranked angles. order[0] is the lead proof point for that variant. The LinkedIn pitch
// for each comes from config `outreach.li_pitches` ([gold, silver, bronze], each a continuation
// clause like "I built ..."); absent that it is derived from the lead bullet.
const LI_PITCHES = Array.isArray(OUT.li_pitches) ? OUT.li_pitches : [];
const DANGLING_END = /^(?:to|of|for|with|by|from|into|onto|at|in|on|about|across|through|via|and|or|the|a|an|while|including|using|[a-z]{3,}ing)$/i;
// LinkedIn notes never carry semicolons; a user bullet's ";" becomes ", " before insertion.
function liSafe(t) { return String(t || '').replace(/\s*;\s*/g, ', ').replace(/,\s*,/g, ',').trim(); }
// Clause boundaries a claim may be shortened at: commas/semicolons (optionally followed by a
// connective) and the bare connectives. Never a raw character slice.
// Only punctuation-led boundaries, or a bare connective followed by a verb (-ed/-ing): a bare
// ' and ' inside a noun phrase ('a Kafka and Spark pipeline') is not a clause boundary.
const CLAUSE_CUT_RE = /[,;]\s+(?:and\s+|which\s+|while\s+|so\s+)?|\s+(?:and|while)\s+(?=\w+(?:ed|ing)\b)/g;
// Longest head of `text` that ends on a clause boundary, fits `max`, keeps >= 4 words, does not
// split a metric, and does not end on a dangling word. '' when no whole clause fits.
function clauseHead(text, max) {
  const t = String(text || '').trim().replace(/[.\s]+$/, '');
  if (t.length <= max) return t;
  const cuts = [...t.matchAll(CLAUSE_CUT_RE)].map(m => m.index).reverse();
  for (const at of cuts) {
    const head = t.slice(0, at).trimEnd().replace(/[,;:]+$/, '');
    if (head.length > max) continue;
    if (head.split(/\s+/).length < 4) continue;
    if (/[\d$%]$/.test(head) && /^\s*[,;]?\s*[\d$%]/.test(t.slice(at))) continue;
    if (DANGLING_END.test(head.split(/\s+/).pop())) continue;
    return head;
  }
  return '';
}
function pitchFrom(bullet, max = 120) {
  let t = liSafe(bullet).replace(/[.\s]+$/, '');
  if (!t) return 'my background maps closely to the role';
  if (!/^I\b/.test(t)) t = `I ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  // Whole clauses only; '' tells the caller to fall back to a shorter variant (no pitch).
  return clauseHead(t, max);
}
const VARIANTS = [
  { rank: 'gold', order: ['b0', 'b1', 'b2'], pointer: "If you're not directly hiring, could you point me to the hiring manager?", why: 'leads with standing bullet 1' },
  { rank: 'silver', order: ['b1', 'b0', 'b2'], pointer: 'Mind pointing me to the right person?', why: 'leads with standing bullet 2' },
  { rank: 'bronze', order: ['b2', 'b0', 'b1'], pointer: 'Who owns the req?', why: 'leads with standing bullet 3' },
].map((v, i) => {
  const pitch = liSafe(LI_PITCHES[i]) || pitchFrom(B[v.order[0]]) || 'my background maps closely to the role';
  return { ...v, liPitch: pitch, liLeaderHero: pitchFrom(pitch, 90) };
});

// Per-role JD-tailored bullets (added 2026-06-15): when the spec carries
// `bullets: [b0, b1, b2]` (3 bullets, each mapped to a distinct JD requirement,
// ordered by JD priority), use them instead of the fixed B bank. gold leads with
// the #1 JD req, silver with #2, bronze with #3 — so every variant is JD-relevant
// and the three angles still differ by emphasis. Falls back to B when absent.
const VORDER = { gold: [0, 1, 2], silver: [1, 0, 2], bronze: [2, 0, 1] };
function tailored(c) { return Array.isArray(c.bullets) && c.bullets.length === 3; }
function bulletsFor(c, rank) {
  if (tailored(c)) return (VORDER[rank] || [0, 1, 2]).map(i => c.bullets[i]);
  const v = VARIANTS.find(x => x.rank === rank);
  return v.order.map(k => B[k]);
}

/**
 * Enforce LinkedIn's 300-char limit WITHOUT amputating a claim.
 *
 * Order of sacrifice, least-meaningful first:
 *   1. shorten the pitch clause to a whole-clause head (never mid-clause, never mid-metric)
 *   2. drop the pitch clause entirely ("I applied for the X role.")
 *   3. replace the role title with "the role" (the title is never abbreviated or rewritten)
 * The greeting+observation (first sentence) and the CTA (last sentence) are NEVER touched,
 * since outreach-judge gates on the CTA string. LI_MAX mirrors the judge's char_limit check.
 */
const LI_MAX = 300;
// Kept for the drafts.json `truncated` field the judge HARD-gates on. The fitter only ever
// drops whole clauses now, so it stays false; it is set only if no complete note fits.
let lastFitCut = false;
function clauseFit(body) {
  if (body.length <= LI_MAX) return body;
  const parts = body.match(/[^.?!]+[.?!]+\s*/g);
  if (!parts || parts.length < 3) return null;
  const first = parts[0], last = parts[parts.length - 1];
  const middle = parts.slice(1, -1);
  for (let drop = 0; drop < middle.length; drop++) {
    const kept = middle.slice(0, middle.length - drop);
    const whole = first + kept.join('') + last;
    if (whole.length <= LI_MAX) return whole;
    const before = first + kept.slice(0, -1).join('');
    const budget = LI_MAX - before.length - last.length - 2; // ". "
    const head = clauseHead(kept[kept.length - 1].trim().replace(/[.?!]+$/, ''), budget);
    if (head) {
      const cand = before + head + '. ' + last;
      if (cand.length <= LI_MAX) return cand;
    }
  }
  return null;
}
function fitLinkedIn(body, role) {
  lastFitCut = false;
  if (body.length <= LI_MAX) return body;
  const tries = [body];
  if (role && body.includes(`the ${role} role`)) tries.push(body.replace(`the ${role} role`, 'the role'));
  for (const b of tries) { const r = clauseFit(b); if (r) return r; }
  // Nothing complete fits (the observation itself is too long). Ship it whole and let the
  // OVER-300 report name it; never slice text mid-claim.
  return tries[tries.length - 1];
}

// jd = optional per-variant JD anchor: { email: "<why-this-role sentence>", li: "<JD-anchored pitch clause>" }
// The email lead-in merges the JD sentence with the "three reasons" announcer into one line ending
// in a colon, so it leads the bullets directly. The opener (p.emailObs) carries the interest hook
// and the "I applied" line; templates never describe the recipient's own role back to them.
// JD-tie style = SUBTLE ECHO, anchored to mission/work, NO announcer (set 2026-06-29, user-chosen).
// The opener (p.emailObs) carries a JD mission/product hook; each bullet weaves the JD's own verb/phrase
// (gen-bullets); the bullets follow the opener directly with NO "three reasons" announcer line. If a
// per-variant JD sentence (jd.email) is provided it is used as a one-line connector, never an announcer.
// Anchor to the JD's product/mission/work and what was BUILT; never describe the recipient's role back to them.
const leadIn = jd => (jd && jd.email ? `${jd.email.replace(/\.\s*$/, '')}.` : '');

// OPTIONAL PER-PERSON QUESTION (added 2026-08-24). Some first touches need to ask one concrete
// logistics question that decides whether the role is worth pursuing at all (e.g. a req listing
// one city while the team appears to sit in another), which is far cheaper to settle in the first
// email than three conversations later.
//
// It renders as its own short paragraph AFTER the proof bullets and BEFORE the CTA, so the bullets
// still own the middle of the letter and the ask still closes it. Set `emailPS` on the person, not
// on the company: it is a question for one recipient, and it is exactly the kind of thing that
// should never be duplicated across every letter.
const psLine = (p) => (p && p.emailPS ? `\n\n${String(p.emailPS).trim().replace(/\s+/g, ' ')}` : '');

/**
 * TEMPLATE A — the hard-coded email shape (user-selected 2026-08-25, "hardcode this template").
 *
 *   Hi {first},
 *
 *   Saw {one specific thing about them}. I applied for the {role} role and wanted to reach you
 *   directly.
 *
 *   {one-sentence identity from config/profile.yml outreach.bridge, ending in a colon}
 *
 *   - three JD-mapped bullets
 *
 *   {CTA}
 *
 * Exactly TWO paragraphs before the bullets. The previous shape had three: an observation, a
 * per-variant JD "what drew me" sentence, and a long credentials bridge, and read as too wordy:
 * the JD paragraph and most of the bridge restated what the bullets then prove.
 *
 * This validator exists because the SHAPE is structural but the OPENER is hand-written per person
 * in each spec's emailObs. Nothing else stops a future spec from drifting back to three paragraphs
 * or a 90-word preamble, and that drift is invisible in a rendered HTML until someone counts.
 * outreach-judge.mjs treats the same failures as HARD violations.
 */
/**
 * LINKEDIN PROSE RULES (researched 2026-08-26).
 *
 * (1) DOUBLED CONJUNCTION. The observation is hand-written per person and the template appends a
 *     joiner. When the observation itself ends in a result clause ("..., so X") and the template
 *     then opened with "so I applied", two independent "so"s stacked inside one run-on sentence:
 *       "I ship side projects on weekends, SO your hackathon build is a language I speak,
 *        SO I applied for the Data Engineer role."
 *     The template now ends the observation on a period, but a hand-written observation can still
 *     double a connective inside itself. Checked generally, not just for "so".
 *
 * (2) THE ASK MUST BE ANCHORED. "Open to a quick chat?" is deliberately small, and its one failure
 *     mode is floating free of any topic, leaving "a chat about what?" unanswered. That is a fault
 *     of the sentence BEFORE the ask, so require real content ahead of it: at least two sentences
 *     precede the CTA. This is the guard that makes the short ask safe.
 */
/**
 * SLOT COLLISION. The observation is hand-written per person; the template appends fixed slots
 * around it. When the hand-written half says something the template is also going to say, the
 * draft repeats itself, and it is invisible in the spec because neither half is wrong alone.
 *
 * Example of the failure:
 *   "Hi Jo, I applied for the Data Engineer role and your profile says to reach out, so I am
 *    taking you up on it. I applied for the Data Engineer role, and ..."
 *
 * Who owns the applied line, by template:
 *   liObs                        NEVER  - liChat and liLeader both append it
 *   emailObs, Hiring Manager     ALWAYS - emailHM appends nothing, Template A needs it here
 *   emailObs, Leader             ALWAYS - emailLeader appends nothing
 *   emailObs, Peer / Recruiter   NEVER  - both templates append their own applied line
 */
const APPLIED_RE = /\bI(?:'ve| have)? applied\b/i;
function checkSlotCollision(p) {
  const out = [];
  const li = String(p.liObs || '');
  if (APPLIED_RE.test(li)) {
    out.push(`${p.name}: liObs contains the applied line, which the LinkedIn template also appends`);
  }
  const em = String(p.emailObs || '');
  const appends = p.persona === 'Peer' || p.persona === 'Recruiter';
  if (appends && APPLIED_RE.test(em)) {
    out.push(`${p.name}: emailObs contains the applied line, which the ${p.persona} email template also appends`);
  }
  if (!appends && em && !APPLIED_RE.test(em)) {
    out.push(`${p.name}: ${p.persona} emailObs must carry the applied line, the template does not add one`);
  }
  return out;
}

/**
 * NEVER open by reciting how many roles the employer has open.
 *
 * The observation is supposed to be a specific, checkable thing about the RECIPIENT. A req count
 * is neither: it is a number scraped off their job board, it says nothing about them or about why
 * the candidate fits, and to the person who OWNS that org it reads as "you have fifteen holes to fill."
 * It also dates badly, since the count moves week to week.
 *
 * What to use instead, in preference order:
 *   1. something the person themselves posted or commented on  (observationSource: recent-post)
 *   2. what the person leads or owns, in their own words        ("saw you lead X at Y")
 *   3. a structural fact about THIS requisition                 ("put this req up in four cities")

 */
// A COUNT followed by a hiring noun, with up to three words between them. Deliberately does NOT
// require a nearby "open": "12 openings on the board" carries the count without the word, and an
// earlier version of this regex missed it for exactly that reason.
// "one" is excluded on purpose — "I applied for one of those reqs" is fine copy, and including it
// made that a false positive. The nouns are hiring nouns only, so "four US cities", "100+ discovery
// sessions" and "six years" do not trip it.
const REQ_COUNT_RE = /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozens?|several|multiple|numerous)\s+(?:\w+\s+){0,3}(?:open\s+)?(?:reqs?|requisitions?|openings?|roles?|positions?|seats?|headcounts?)\b/i;
// Same family, flagged separately 2026-09-16: an opener that recites WHERE/HOW WIDELY they posted
// ("put this req up in four cities on the same day") is not a req count, but it is the same
// "I scraped your job board" move. Kept narrow on purpose — a regex broad enough to catch every
// board-derived phrasing would start eating legitimate structural observations.
const BOARD_SPREAD_RE = /\b(put|posted|listed|opened|dropped)\b[^.]{0,40}\b(in|across)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(\w+\s+){0,2}(cities|locations|markets|offices|states|countries|regions|geos)\b/i;
function checkReqCount(p) {
  const out = [];
  for (const [field, text] of [['emailObs', p.emailObs], ['liObs', p.liObs]]) {
    if (text && BOARD_SPREAD_RE.test(text)) {
      out.push(`${p.name}: ${field} recites how widely they posted the req ("${text.match(BOARD_SPREAD_RE)[0].trim()}") — ` +
        `the observation must be about the PERSON`);
    }
    // A level number inside a role title ("Engineer 2 role", "Level 3 position") is not a count.
    const stripped = text ? String(text).replace(/\b(?:level|lvl|grade|engineer|developer|manager|specialist|associate|analyst|consultant|architect|[IVX]+)\s+\d+\s+(?=(?:\w+\s+){0,3}(?:roles?|positions?|openings?|reqs?)\b)/gi, '') : text;
    if (stripped && REQ_COUNT_RE.test(stripped)) {
      out.push(`${p.name}: ${field} recites the employer's open-req count ("${stripped.match(REQ_COUNT_RE)[0].trim()}") — ` +
        `use what they lead or a fact about THIS req instead`);
    }
  }
  return out;
}

const LI_CONNECTIVES = ['so', 'and', 'but', 'because', 'which'];
// A sentence ending on a preposition or a bare participle reads as an amputated clause
// ("...doubled inbound to.", "...while scaling."). "-ing" is only flagged for words of 6+ chars to skip "thing"/"king".
// DANGLING_END is defined above clauseHead (it must exist before VARIANTS is built).
function checkLinkedInProse(body, label) {
  const out = [];
  const sentences = String(body).split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  for (const sent of sentences) {
    // The template's own ", and" joiner (applied line + pitch) is not a doubled connective.
    const own = sent.replace(/\brole, and\b/i, 'role,');
    for (const c of LI_CONNECTIVES) {
      const hits = (own.match(new RegExp(`\\b${c}\\b`, 'gi')) || []).length;
      if (hits > 1) out.push(`${label}: "${c}" appears ${hits} times in one sentence, split it`);
    }
  }
  if (/;/.test(body)) out.push(`${label}: contains a semicolon; LinkedIn notes join with ", and" or a period`);
  for (const sent of sentences) {
    const m = sent.match(/\b(\w+)[.!?]$/);
    if (m && DANGLING_END.test(m[1])) out.push(`${label}: sentence ends on a dangling "${m[1]}" ("...${sent.slice(-40)}"); finish the clause`);
  }
  if (sentences.length < 3) {
    out.push(`${label}: only ${sentences.length} sentence(s); the ask needs a topic named before it`);
  }
  return out;
}

const TEMPLATE_A_MAX_WORDS = 75;

/**
 * The preamble must not spend what the bullets are about to prove. Template A compressed the
 * preamble to ~55 words, which makes any repeat glaring rather than merely present. Three real
 * instances on 2026-08-25 alone: an opener that used bullet 1's conversion metric, an observation
 * that restated a JD anchor almost verbatim, and a bridge that named an employer one line above
 * the bullet that names the same employer. Distinctive tokens only, so ordinary words do not trip it.
 */
function checkPreambleEcho(body, label, company) {
  const cut = body.indexOf('\n\n- ');
  if (cut === -1) return [];
  // Scan the preamble AND anything after the bullet list that is not the CTA or sign-off, because
  // emailPS renders there; a PS can restate bullet 1 verbatim and a preamble-only scan misses it.
  const afterBullets = body.slice(cut).split('\n').filter((l) => !l.startsWith('- ')).join('\n');
  const pre = body.slice(0, cut) + '\n' + afterBullets;
  // ONLY the bullet lines. Slicing to end of body also caught the CTA, which legitimately names
  // the company ("...how I can contribute at Greptile"), and produced three false positives per
  // Leader letter on the first run.
  const bullets = body.slice(cut).split('\n').filter((l) => l.startsWith('- ')).join('\n');
  // Numbers, $ amounts, and capitalised proper nouns that appear inside the bullets.
  const bulletNouns = [...new Set((bullets.match(/(?<=\s)[A-Z][A-Za-z0-9]{2,}\b/g) || []))].map(escRe);
  const tokRe = new RegExp(`\\$[\\d,]+K?|\\b\\d+%|\\b\\d{2,}\\+${bulletNouns.length ? `|\\b(?:${bulletNouns.join('|')})\\b` : ''}`, 'g');
  const tokens = (pre.match(tokRe) || []);
  // The employer's own name is expected in the bridge announcer ("add value at {company}:") and
  // is not an echo.
  const co = String(company || '').toLowerCase();
  const echoed = [...new Set(tokens)]
    .filter((t) => t.toLowerCase() !== co && bullets.toLowerCase().includes(t.toLowerCase()));
  return echoed.length ? [`${label}: preamble repeats ${echoed.join(', ')} which a bullet already carries; reword the opener (emailObs) or the bridge so the bullet is the only place it appears`] : [];
}
function checkTemplateA(body, label) {
  const cut = body.indexOf('\n\n- ');
  if (cut === -1) return [];                       // no bullet list (some leader/peer shapes)
  const pre = body.slice(0, cut);
  const paras = pre.split('\n\n').filter((x) => x.trim());
  const words = pre.split(/\s+/).filter(Boolean).length;
  const out = [];
  // greeting + opener + bridge = 3 segments. A 4th means the JD paragraph crept back.
  if (paras.length !== 3) out.push(`${label}: ${paras.length - 1} paragraph(s) before the bullets, Template A wants 2`);
  if (words > TEMPLATE_A_MAX_WORDS) out.push(`${label}: ${words} words before the bullets, Template A budget is ${TEMPLATE_A_MAX_WORDS}`);
  if (!pre.trimEnd().endsWith(':')) out.push(`${label}: the paragraph above the bullets must end in a colon that leads them`);
  return out;
}
const join = (opener, lead) => `${opener}${lead ? `\n\n${lead}` : ''}`;
function emailHM(co, role, p, v, jd, star, bl, tlr) {
  const [b0, b1, b2] = bl;
  const last = tlr ? b2 : (star || b2); // tailored: keep all 3 JD-mapped bullets; legacy: STAR replaces 3rd
  return `Hi ${first(p.name)},\n\n${p.emailObs}\n\n${bridge(co)}\n\n- ${b0}\n- ${b1}\n- ${last}${psLine(p)}\n\nWould you be open to a short 15-min chat later this week to see if there's a mutual fit?\n\nBest,\n${SENDER}`;
}
/**
 * The recruiter email is a DIFFERENT ARTIFACT, not the HM email with a swapped CTA.
 *
 * Two defects this fixes. First, it was the only template that never interpolated
 * p.emailObs, so a real post hook was discarded for recruiters even when one existed
 * and two recruiters at one company got a byte-identical first line by construction.
 * Second, a recruiter's job is to LOCATE the application and screen it: the old opener
 * gave them no req handle, no date, no link, and none of the facts that decide whether
 * a screen is worth booking. Those facts sit BELOW the bullets so the distinguishing
 * hook still owns line one.
 */
function emailRecruiter(co, role, p, v, jd, star, bl, tlr, jdUrl, appliedOn) {
  const [b0, b1, b2] = bl;
  const last = tlr ? b2 : (star || b2);
  // The fallback observation already names the role ("...so the {role} role stood out"),
  // so repeating it in the applied line printed the title twice in two sentences. Use
  // the short applied line whenever the observation has already said it.
  const obs = p.obs || p.emailObs;
  const named = role && obs.includes(role);
  // NO APPLICATION DATE, EVER (user-set 2026-08-03). `appliedOn` is accepted for call
  // compatibility and deliberately ignored. "I applied on August 3" reads as a nudge about
  // how long they have taken to reply, and it dates the letter the moment it sits unread
  // for a week. Say that the application is in; never say when.
  //
  // The observation may ALREADY say "I applied" — the shared fallback opener ends with
  // "I applied and wanted to reach you directly." Appending the recruiter's own applied
  // line on top produced "I applied and wanted to reach you directly. I applied on July 27
  // and wanted to put it on your radar directly." in real output (2026-07-27). When the
  // observation covers it, add nothing.
  // 2026-08-18: the guard missed "I am pursuing..."-class observations — an obs that
  // avoided the applied-claim but carried its own intro clause ("wanted to introduce
  // myself directly") got the template's applied line STACKED on top ("directly" twice,
  // two intros — caught in review). Any intro-meta phrasing
  // in the obs now suppresses the appended line, not just a literal "I applied".
  const alreadyApplied = /\bI applied\b|introduce myself|on your radar|reach you directly|put a name to/i.test(obs);
  const applied = alreadyApplied
    ? ''
    : named
      ? `I applied and wanted to put it on your radar directly.`
      : `I applied for the ${role} role and wanted to put it on your radar directly.`;
  const opener = applied ? `${obs} ${applied}` : obs;
  // RECRUITER CLOSING — user-set 2026-07-27, use this verbatim every time.
  // The "Posting: <url>" line and the "Based in …, in-office …; no remote." screening
  // block were REMOVED: they read as a form submission rather than a note to a person,
  // and the recruiter already has the req in front of them. The closing now offers the
  // two things a recruiter actually wants (answers about the background, a conversation)
  // and ends warmly so a "no" still lands well.
  // NOTE: this text deliberately contains "Either way, I hope" and the ":)" — both were on
  // the judge's banned list until the user reinstated them here. outreach-judge.mjs no
  // longer flags them; do not re-add those bans without checking this template first.
  const closing = `Would you be open to chatting about the role? Happy to answer questions about my background, and I'd love to learn more about the team. Either way, I hope you find a great fit for this one:)`;
  // emailPS goes BEFORE the fixed closing, never inside it: the closing is verbatim by user
  // instruction and must not be edited. A recruiter is usually the best person to answer a
  // logistics question, so this template needs the field as much as the HM one does.
  return `Hi ${first(p.name)},\n\n${opener}\n\n${bridge(co)}\n\n- ${b0}\n- ${b1}\n- ${last}${psLine(p)}\n\n${closing}\n\nBest,\n${SENDER}`;
}
function emailLeader(co, role, p, hmFirst, v, jd, star, bl, tlr) {
  const lead = bl[0];
  const second = tlr ? bl[1] : star; // tailored: second JD-mapped bullet as the 2nd example
  const secondLine = second ? `\n- ${second}` : '';
  const jdLine = jd && jd.email ? `\n\n${jd.email.replace(/\.\s*$/, '')}.` : '';
  // Leader email closes with the POINTER ask, same as the Leader LinkedIn note (user-set
  // 2026-08-31: "should be like can you connect me to the right person"). The old
  // "Would value connecting with you about how I can contribute" line asked for nothing.
  const leaderAsk = hmFirst ? `If you're not the right person for this, could you connect me with ${hmFirst}?` : v.pointer;
  return `Hi ${first(p.name)},\n\n${p.emailObs}\n\n${bridge(co, second ? 2 : 1)}\n\n- ${lead}${secondLine}${psLine(p)}\n\n${leaderAsk}\n\nCheers,\n${SENDER}`;
}
/**
 * NEVER AMPUTATE A CLAIM TO MAKE THE CAP (2026-07-26).
 *
 * Failure mode: two notes in the same variant, where one recipient's first name is a few
 * characters longer, and fitLinkedIn spends those characters on the verb that carried the
 * entire claim ("...until meeting conversion."). A trimmed clause that still parses is worse than a
 * dropped one, because it reads as a finished thought that says nothing.
 *
 * The fix is to try the SHORTER pitch (liLeader, populated in all 48 cached bullets
 * files) before letting sentence surgery near the pitch clause.
 */
function liChat(p, role, v, jd) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const build = pitchClause => pitchClause
    // Flowing joiner (user-set 2026-08-29, twice in one sitting: "i do not like the ;" and then
    // "make the copy sound more fluid, sounds like we jotting off"). The applied line and the pitch
    // are ONE sentence joined by ", and"; the pitch clause is written as a continuation and must not
    // carry its own "and"/"so" or checkLinkedInProse flags the doubled connective.
    ? `Hi ${first(p.name)}, ${lower1(p.liObs)}. I applied for the ${role} role, and ${lower1(pitchClause)}. ${ctaFor(p.persona)}`
    : `Hi ${first(p.name)}, ${lower1(p.liObs)}. I applied for the ${role} role and believe I'd excel because ${v.liPitch}. ${ctaFor(p.persona)}`;

  // Longest first, then progressively shorter WHOLE clauses. Only if every intact
  // option is over does fitLinkedIn get to cut.
  const options = [jd && jd.li, jd && jd.liLeader, v.liLeaderHero].map(liSafe).filter(Boolean);
  for (const o of options) {
    const body = build(o);
    if (body.length <= LI_MAX) return body;
  }
  const plain = build(null);
  if (plain.length <= LI_MAX) return plain;
  return fitLinkedIn(build(options[options.length - 1] || null), role);
}
function liLeader(p, role, v, jd) {
  // leader has a tight budget (its observation is long), so it uses a dedicated short hook
  const heroRaw = liSafe(jd && jd.liLeader ? jd.liLeader : v.liLeaderHero);
  if (!heroRaw) return fitLinkedIn(`Hi ${first(p.name)}, ${lower1(p.liObs)}. I applied for the ${role} role. ${v.pointer}`, role);
  // Same flowing shape as liChat (user-set 2026-08-29, "sounds like we jotting off"): applied
  // line and proof are ONE sentence, joined by ", and". The hero clause is a continuation and
  // must not carry its own "and"/"so".
  return fitLinkedIn(`Hi ${first(p.name)}, ${lower1(p.liObs)}. I applied for the ${role} role, and ${lower1(heroRaw)}. ${v.pointer}`, role);
}

// Peer = a current teammate in/near the role. Colleague tone: curious about the
// team, not "add immediate value to the company." Leads with one proof point.
function emailPeer(co, role, p, v, jd, star, bl, tlr) {
  const lead = bl[0];
  const second = tlr ? bl[1] : star;
  const secondLine = second ? `\n- ${second}` : '';
  const jdLine = jd && jd.email ? `\n\n${jd.email}` : '';
  // Same dedup the recruiter template does (see emailRecruiter): the observation may ALREADY
  // say "I applied" — both the shared fallback opener and hand-written specs end that way.
  // Appending the peer's own applied line on top printed it twice in one paragraph
  // ("I applied and wanted to reach you directly. I applied for the X role and would value
  // your read..."). When the observation covers it, drop it.
  const applied = /\bI applied\b/i.test(p.emailObs)
    ? `Would value your read on the team before I get further along.`
    : `I applied for the ${role} role and would value your read on the team before I get further along.`;
  return `Hi ${first(p.name)},\n\n${p.emailObs} ${applied}\n\n${bridge(co, second ? 2 : 1)}\n\n- ${lead}${secondLine}${psLine(p)}\n\nWould you be open to a quick 15 minutes on what the work actually looks like day to day?\n\nThanks,\n${SENDER}`;
}
function emailBodyFor(persona, co, role, p, hmFirst, v, jd, star, bl, tlr, jdUrl, appliedOn) {
  if (persona === 'Recruiter') return emailRecruiter(co, role, p, v, jd, star, bl, tlr, jdUrl, appliedOn);
  if (persona === 'Leader') return emailLeader(co, role, p, hmFirst, v, jd, star, bl, tlr);
  if (persona === 'Peer') return emailPeer(co, role, p, v, jd, star, bl, tlr);
  return emailHM(co, role, p, v, jd, star, bl, tlr);
}

const logRows = [];
let over = 0;
let templateAViolations = 0;
let echoWarnings = 0;
let liProseWarnings = 0;
let slotCollisions = 0;
let reqCountHits = 0;
let moneyHits = 0;
// Auto-load JD-mapped bullets from data/bullets/*.json (written by scripts/gen-bullets.mjs)
// when the spec doesn't inline `bullets`.
//
// MATCH THE REQUISITION, NOT THE EMPLOYER (fixed 2026-08-24). This used to resolve on
// `data/bullets/{companySlug}.json` and fall back to a company-name scan, with no reference to
// the role at all. One cache file per employer is not one per job, and an employer routinely has
// several open reqs with completely different pitches.
//
// Failure mode: an employer cache written for a different req at the same company loads silently
// and its bullets reach a hiring manager for the wrong role.
//
// Resolution order, most specific first:
//   1. spec.bullets_slug          — an explicit pointer in the spec always wins
//   2. company + role match       — cache whose `role` matches the spec's role
//   3. company + jd_url match     — same requisition by URL
//   4. company-only, ONLY if exactly one cache exists for that employer
// Ambiguity returns null rather than guessing: no bullets is a visible failure, the WRONG
// bullets is an invisible one that reaches a hiring manager.
/**
 * THE STANDING BULLET SET: config/profile.yml `outreach.default_bullets` (DEFAULT_BULLETS above).
 * Archetype-level, not company-level, so one set travels across employers.
 *
 * PRECEDENCE, most specific first:
 *   1. `bullets` inlined in the spec
 *   2. a company cache named by the spec's `bullets_slug`
 *   3. THESE
 * A data/bullets/{slug}.json file is never picked up merely for existing; a company set must be
 * asked for by name, so a stale file for a different req at the same employer cannot load silently.
 */

function loadBulletsCache(company, role, jdUrl, explicitSlug) {
  const normRole = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (explicitSlug) {
    const p = `data/bullets/${explicitSlug}.json`;
    if (existsSync(p)) {
      try {
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        if (Array.isArray(d.bullets) && d.bullets.length === 3) { d._path = p; return d; }
      } catch { /* fall through */ }
    }
    console.warn(`  !! bullets_slug "${explicitSlug}" named in the spec did not load — refusing to substitute another file`);
    return null;
  }
  if (!existsSync('data/bullets')) return null;
  const forCompany = [];
  for (const f of readdirSync('data/bullets')) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(`data/bullets/${f}`, 'utf-8'));
      if ((d.company || '').toLowerCase() !== String(company).toLowerCase()) continue;
      if (!Array.isArray(d.bullets) || d.bullets.length !== 3) continue;
      d._path = `data/bullets/${f}`;
      forCompany.push(d);
    } catch { /* skip */ }
  }
  if (!forCompany.length) return null;
  const byRole = forCompany.filter((d) => normRole(d.role) === normRole(role));
  if (byRole.length === 1) return byRole[0];
  const byUrl = forCompany.filter((d) => jdUrl && d.jd_url && d.jd_url.split('?')[0] === String(jdUrl).split('?')[0]);
  if (byUrl.length === 1) return byUrl[0];
  if (forCompany.length === 1) return forCompany[0];
  console.warn(`  !! ${company}: ${forCompany.length} bullet caches for this employer and none matches role "${role}" — ` +
    `refusing to guess. Set "bullets_slug" in the spec. Candidates: ${forCompany.map((d) => d._path).join(', ')}`);
  return null;
}

for (const c of spec) {
  // JD-mapped bullets: spec inline wins; else load the gen-bullets cache.
  c._bulletSource = tailored(c) ? 'inline' : null;
  if (!tailored(c)) {
    const cb = c.bullets_slug ? loadBulletsCache(c.company, c.role, c.jd_url, c.bullets_slug) : null;
    if (cb) {
      c.bullets = cb.bullets;
      c._bulletSource = 'company file';
      c.jd = c.jd ? { ...cb.jd, ...c.jd } : cb.jd; // spec jd clauses override cached
      console.log(`bullets: ${c.company} -> company set from ${cb._path} (named by bullets_slug)`);
    } else if (DEFAULT_BULLETS.length === 3) {
      c.bullets = DEFAULT_BULLETS;
      c._bulletSource = 'standing set (profile)';
      // The JD anchors still come from a company cache when one exists: they feed the LinkedIn
      // pitch clause, which has no bullet list to carry the point.
      const jdOnly = loadBulletsCache(c.company, c.role, c.jd_url, c.jd_anchor_slug || null);
      if (jdOnly && jdOnly.jd) c.jd = c.jd ? { ...jdOnly.jd, ...c.jd } : jdOnly.jd;
      console.log(`bullets: ${c.company} -> standing set from config/profile.yml`);
    }
  }
  // roster scan runs BEFORE the HTML is built (standing rule 2026-06-12)
  if (c.linkedin_company && (!c.people || !c.people.length || c.use_roster)) {
    const roster = loadRoster(c);
    if (roster?.selection?.length) {
      c.people = peopleFromRoster(c, roster);
      console.log(`roster: ${c.company} contacts decided by roster (${roster.total} scanned, ${roster.visited || 0} visited, CxO excluded: ${roster.excludedCxO?.length || 0}) -> ${c.people.map(p => `${p.persona}: ${p.name}`).join('; ')}`);

      // Drop anyone whose own post says they LEFT. Writing to them about a req at their
      // former employer is the worst contact failure in the corpus.
      const gone = c.people.filter(p => p.departed);
      if (gone.length) {
        console.log(`contacts: dropping ${gone.length} who announced a move away from ${c.company}: ${gone.map(p => p.name).join(', ')}`);
        c.people = c.people.filter(p => !p.departed);
      }

      // WARN (never block) when no selected contact is verifiably on the hiring team.
      // Deliberately advisory: the token match is a stem test against JD words, and a
      // title like "Early Access Deployment Engineer" yields tokens that few headlines
      // at a large employer carry, including the correct hiring manager's. Blocking on
      // it would have refused 100% of runs. Print the targeted-search strings instead,
      // so the fix is one copy-paste away.
      const tokens = teamTokensFor(c.role);
      const onTeam = (roster.selection || []).filter(s => s.teamMatch === true).length;
      if (tokens.length && onTeam === 0) {
        console.log(`! CONTACT CHECK: none of ${c.company}'s selected contacts matched the team tokens [${tokens.join(', ')}].`);
        console.log(`  The roster may be returning off-team people (modes/outreach.md: large companies need targeted search). Verify with:`);
        console.log(`    "${c.company} ${roleDisplay(c.role)}"           <- peers`);
        console.log(`    "${c.company} ${tokens[0]} lead OR manager OR head"  <- hiring manager / leader`);
      }
    }
  }
  if (!Array.isArray(c.people) || !c.people.length) {
    // Roster unavailable (LinkedIn OFF or no cache) and the spec carries no
    // hand-picked contacts: ship the HTML with TBD placeholders so the draft
    // isn't dropped; names resolve when the roster can run again.
    c.people = ['Hiring Manager', 'Recruiter'].map(persona => ({
      persona,
      name: `(TBD - ${c.company} ${persona.toLowerCase()})`,
      title: 'posting (roster pending)',
      // no recipient known, so anchor the opener on the posting itself
      emailObs: `Saw ${c.company} is hiring ${art(roleDisplay(c.role))} ${roleDisplay(c.role)}.`,
      liObs: `saw ${c.company} is hiring ${art(roleDisplay(c.role))} ${roleDisplay(c.role)}`,
    }));
    console.log(`roster: ${c.company} — no roster available; using TBD placeholder contacts`);
  }
  await upgradeEmails(c);
  const sl = `${slug(c.company)}-${slug(c.role)}-${today}`;
  const rd = roleDisplay(c.role); // role for the copy/subject, with location qualifiers stripped
  // No application date in the copy (user-set 2026-08-03) — see emailRecruiter(). Passed
  // as null so the signature stays intact and nothing downstream can reintroduce a date.
  const appliedOn = null;
  const hmHM = c.people.find(p => p.persona === 'Hiring Manager');
  const hmFirst = (hmHM && !isPlaceholder(hmHM.name)) ? first(hmHM.name) : null;
  const jdHooks = c.jd || {};
  const reportPath = findReport(c, slug);
  const stars = loadStars(reportPath);
  // Collapse artifacts from clause concatenation: a proof clause ending in "." then a
  // template period ("inbound.. Would") -> single period; also no space before punctuation.
  const tidy = s => String(s).replace(/\.{2,}(\s|$)/g, '.$1').replace(/\s+([.,;:!?])/g, '$1');
  const personas = c.people.map(p => {
    const tlr = tailored(c);
    for (const w of checkSlotCollision(p)) { console.log(`SLOT COLLISION: ${w}`); slotCollisions++; }
    for (const w of checkReqCount(p)) { console.log(`REQ-COUNT OBSERVATION: ${w}`); reqCountHits++; }
    const emailPicks = VARIANTS.map(v => {
      const jd = jdHooks[v.rank];
      const bl = bulletsFor(c, v.rank);
      const star = tlr ? null : starFor(v.rank, stars, v.order[0]);
      const body = tidy(emailBodyFor(p.persona, c.company, rd, p, hmFirst, v, jd, star, bl, tlr, c.jd_url, appliedOn));
      moneyHits += flagMoney(`${c.company}/${p.name}/${v.rank} email`, body);
      for (const w of checkTemplateA(body, `${c.company}/${p.name}/${v.rank}`)) {
        console.log(`TEMPLATE A: ${w}`); templateAViolations++;
      }
      for (const w of checkPreambleEcho(body, `${c.company}/${p.name}/${v.rank}`, c.company)) {
        console.log(`ECHO: ${w}`); echoWarnings++;
      }
      return {
        rank: v.rank,
        subject: subj.replace('%ROLE%', rd),
        body,
        char_count: null,
        why_picked: `${v.rank[0].toUpperCase() + v.rank.slice(1)}: ${tlr && jd ? 'JD-mapped bullets, led by the ' + (v.rank === 'gold' ? '#1' : v.rank === 'silver' ? '#2' : '#3') + ' JD requirement' : v.why}.${jd ? ' Anchored to JD.' : ''}${star ? ' Blended with report STAR point.' : ''}`,
        provenance: [`Observation -> ${p.title}`, tlr ? `Bullets -> ${c._bulletSource || 'inline'}` : `Lead proof -> ${v.order[0]} (resume)`, ...(jd ? ['JD anchor -> posting'] : []), ...(star ? [`Report STAR -> ${reportPath}`] : [])],
      };
    });
    const liPicks = VARIANTS.map(v => {
      const jd = jdHooks[v.rank];
      const body = tidy(p.persona === 'Leader' ? liLeader(p, rd, v, jd) : liChat(p, rd, v, jd));
      // Did fitLinkedIn have to CUT to make the cap? Only the generator knows; the judge
      // gates on this rather than trying to detect an amputated clause from the text.
      const truncated = lastFitCut;
      moneyHits += flagMoney(`${c.company}/${p.name}/${v.rank} linkedin`, body);
      if (body.length > 300) { console.log(`OVER 300 (${body.length}): ${c.company}/${p.name}/${v.rank}`); over++; }
      if (truncated) console.log(`TRUNCATED to fit 300: ${c.company}/${p.name}/${v.rank} — a claim may have lost its outcome verb.`);
      for (const w of checkLinkedInProse(body, `${c.company}/${p.name}/${v.rank}`)) {
        console.log(`LI PROSE: ${w}`); liProseWarnings++;
      }
      return {
        rank: v.rank,
        subject: null,
        body,
        truncated,
        char_count: body.length,
        why_picked: `${v.rank[0].toUpperCase() + v.rank.slice(1)}: ${tlr ? 'JD-mapped pitch, led by the ' + (v.rank === 'gold' ? '#1' : v.rank === 'silver' ? '#2' : '#3') + ' JD requirement' : v.why}.${jd ? ' Anchored to JD.' : ''} ${body.length}/300.`,
        provenance: [`Observation -> ${p.title}`, tlr ? `Pitch -> ${c._bulletSource || 'inline'}` : `Lead proof -> ${v.order[0]} (cv.md)`, ...(jd ? ['JD anchor -> posting'] : [])],
      };
    });
    const chans = [
      { channel: 'email', char_limit: null, picks: emailPicks },
      { channel: 'linkedin_connection', char_limit: 300, picks: liPicks },
    ];
    logRows.push([c.company, c.role, p.persona, sl, p.name]);
    // observation_source is carried through so the judge and the HTML can be HONEST about
    // whether this contact got a person-specific hook or the shared company line. It was
    // computed since 2026-07-25 and dropped here, so every card asserted the observation
    // came from the recipient's headline even when it was boilerplate.
    return {
      persona: p.persona,
      target: {
        name: p.name, headline: p.title, company: c.company, tenure: null,
        linkedin_url: p.linkedin, email: p.email || null,
        email_confidence: p.email_confidence || null,
        observation_evidence: p.emailObs,
        observation_source: p.observationSource || 'spec-provided',
        // 'profile-experience' added 2026-08-24. The whitelist recognised only post-derived hooks, so a
        // hook drawn from the person's OWN job history scored as "shared company line" even though it
        // names something true of exactly one recipient (e.g. they recently made the same career move the
        // candidate is making). That is more person-specific than most posts and does not decay the way a
        // post does. It still requires an actual profile visit, so the provenance bar is unchanged: what
        // is NOT allowed is a hook invented from a search card.
        personalized: ['recent-post', 'hiring-post', 'profile-experience', 'profile-activity'].includes(p.observationSource),
      },
      channels: chans,
      // The email suppression note: a contact with no address >= the bar is LinkedIn-only,
      // and the card should say so rather than showing an empty email field.
      send_recommendation: p.email ? '' : 'No verified email cleared the 80% bar for this contact. Send on LinkedIn; do not guess an address.',
      warnings: [],
    };
  });
  const out = { header: { company: c.company, role: c.role, date: today, jd_url: c.jd_url, report_path: reportPath }, candidate: { name: SENDER, email: OUT.sender_email || null, linkedin: SENDER_LINKEDIN }, send_order: 'HM email + LinkedIn and recruiter (if any) together now; leaders as escalation in ~5 days (pointer ask routes to the HM). Each channel gives gold/silver/bronze: send gold by default, swap to silver/bronze to lead with a different standing bullet.', personas };
  const path = `output/outreach/${sl}.drafts.json`;
  mkdirSync('output/outreach', { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2));
  execSync(`node scripts/render-outreach.mjs ${path}`, { stdio: 'ignore' });
  console.log(`${c.company}: ${personas.length} people x 2 channels x 3 variants = ${personas.length * 6} drafts -> output/outreach/${sl}.html`);
}

console.log(over ? `\n${over} LinkedIn drafts still over 300 — tighten manually.` : '\nAll LinkedIn drafts <= 300.');
console.log(slotCollisions ? `${slotCollisions} SLOT COLLISION(s): hand-written text repeats what the template appends.` : 'No slot collisions.');
console.log(reqCountHits ? `${reqCountHits} REQ-COUNT OBSERVATION(s): never open by counting the employer's open roles.` : 'No req-count observations.');
console.log(liProseWarnings ? `${liProseWarnings} LinkedIn prose warning(s).` : 'LinkedIn prose clean (no doubled connectives, ask is anchored).');
console.log(echoWarnings ? `${echoWarnings} preamble echo warning(s): the opener spends what a bullet proves.` : 'No preamble/bullet echo.');
console.log(templateAViolations
  ? `${templateAViolations} TEMPLATE A violation(s): the email shape drifted, fix emailObs or outreach.bridge.`
  : 'Email shape matches Template A (2 paragraphs before the bullets).');
console.log(moneyHits ? `${moneyHits} draft(s) mention the company's money/investors — fix the spec (rule: never cite the raise or "backed by X").` : 'No money/backing mentions.');
console.log(`\nLOG_ROWS=${logRows.length}`);
