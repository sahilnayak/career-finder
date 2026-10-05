#!/usr/bin/env node
/**
 * outreach-judge.mjs — Score and rank the gold/silver/bronze outreach variants
 * in a drafts.json against the codified house rules, then pick a winner per
 * persona+channel slot.
 *
 * This is the deterministic half of the review: it mechanically checks the
 * things that have an objective answer (em-dash ban, the 300-char LinkedIn cap,
 * the persona CTA, subject format, banned phrases, JD-anchor provenance, and
 * whether every $/% claim in the copy actually appears in cv.md). The qualitative
 * half — which ANGLE lands best for this contact — is a judgment call left to the
 * LLM review swarm; this script gates compliance and surfaces the flags the swarm
 * (and the user) should act on first. A variant with a hard violation can never
 * win its slot regardless of how good the angle is.
 *
 * Usage:  node scripts/outreach-judge.mjs output/outreach/{slug}.drafts.json
 *         node scripts/outreach-judge.mjs langchain            # resolves newest match
 *         node scripts/outreach-judge.mjs <file> --json        # machine-readable only
 *
 * Writes:  output/outreach/{slug}.scorecard.json
 * Exit:    non-zero if any HARD violation remains (em-dash, over-cap, wrong CTA),
 *          so it can gate a pipeline before anything is sent.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';

const OUT_DIR = 'output/outreach';

// ── house rules ─────────────────────────────────────────────────────────────
const BANNED = [
  'hit the ground running', 'passionate about', 'i hope you\'re doing well',
  'add immediate value', 'i\'m reaching out because', 'i just wanted to',
  // "either way, i hope" was un-banned 2026-07-27: the user reinstated it as part of the
  // fixed recruiter closing in gen-outreach.mjs ("Either way, I hope you find a great fit
  // for this one:)"). Flagging it would make the gate fight the mandated template on every
  // run. Do not re-add it without changing that closing first.
  'circle back', 'synergy', 'leverage my', 'wear many hats',
  // note: "three reasons i'd be a good fit" was re-approved by the user 2026-06-19 as a bullet
  // lead-in (merged onto the JD sentence), so it is intentionally NOT banned.
];
// APPROVED CTA SET, not one frozen string (reset 2026-08-26).
//
// No single phrasing here is evidence-backed. Gating on a single exact string would hard-code an unreplicated
// preference AND destroy the ability to ever compare alternatives, because every future draft
// would be normalised to it. The judge therefore accepts any approved phrasing and fails only a
// draft that carries none, or that carries a chat ask in the Leader slot.
const CHAT_CTAS = [
  'open to a quick chat?',                      // current default
  "any advice you'd share?",                    // peer variant
  'free for a chat as a next step',             // the previous house string, still valid
];
const CHAT_CTA = CHAT_CTAS[0];
const EMAIL_CTA = /mutual fit|open to chatting about the role|free for a chat/i; // HM/Recruiter email tail
// 'connect me with {name}' is the pointer ask the Leader EMAIL template actually emits, and it was
// missing here, so every Leader email scored a false WARN. Added 2026-09-08.
const POINTER = [/point me to the hiring manager/i, /pointing me to/i, /who owns the req/i, /how i can contribute/i, /connect me with/i, /right person for this/i];

// ── helpers ─────────────────────────────────────────────────────────────────
const emDashes = s => (s.match(/—/g) || []).length;
// A bullet opening with a bare pronoun / back-reference. Scoped to the text before the
// first comma so "It turns out, ..." is caught but "Built X, it then ..." is not.
const BACKREF = /^\s*(?:it|its|this|that|these|those|they|them|their|such|doing so|getting it|making it|keeping it|the same)\b/i;
// every dollar/percent/"N+" magnitude the copy asserts
const claimTokens = s => [...new Set((s.match(/\$[0-9][0-9.]*[KMB]?\+?|\b[0-9]{1,3}%\+?|\b[0-9]{2,3}\+/g) || []))];

function statTime(f) { try { return statSync(f).mtimeMs; } catch { return 0; } }
function resolveTarget(arg) {
  if (arg && arg.endsWith('.json') && existsSync(arg)) return arg;
  const files = readdirSync(OUT_DIR).filter(f => f.endsWith('.drafts.json'));
  const matches = (arg ? files.filter(f => f.includes(arg.toLowerCase())) : files)
    .map(f => `${OUT_DIR}/${f}`)
    .sort((a, b) => statTime(b) - statTime(a));
  if (!matches.length) { console.error(`No drafts.json found for "${arg || 'latest'}" in ${OUT_DIR}`); process.exit(2); }
  return matches[0];
}

function scorePick(pick, persona, channel, charLimit, cvText) {
  let noJdAnchor = false;
  const body = pick.body || '';
  const subject = pick.subject || '';
  const blob = `${subject}\n${body}`;
  const lower = blob.toLowerCase();
  const violations = [];
  let score = 100;

  // HARD: em dashes
  const em = emDashes(blob);
  if (em > 0) { violations.push({ sev: 'HARD', msg: `${em} em-dash(es)` }); score -= 50 * em; }

  // HARD: render bugs. A missing spec field interpolated the literal string "undefined"
  // into the body ("Hi Scott, undefined, so I applied...") and shipped, because nothing
  // looked for it. These tells mean the template broke, not that the copy is weak, so
  // they gate. All were observed in real 2026-07-26 output.
  for (const [re, label] of [
    [/\b(undefined|null|NaN)\b/, 'literal "undefined"/"null" in body (missing spec field)'],
    [/\bat\s+at\b/i, 'doubled "at at" (headline already named the employer)'],
    // Exactly two dots is the render bug ("inbound.. Would"). Three is a deliberate
    // ellipsis closing a quoted post that the scrape truncated, which is honest and must
    // not be flagged.
    [/(?<!\.)\.\.(?!\.)/, 'doubled period ".."'],
    [/[a-z]\s+\./i, 'space before period'],
    [/\bSaw you'?re\b/i, "describes the recipient's own role back to them (banned 2026-06-19)"],
    // No application DATE in the copy (user-set 2026-08-03). "I applied on August 3" reads
    // as a nudge about how slow they have been to reply, and it stales the letter the
    // moment it sits unread. The line is "I applied for the {role} role and wanted to put
    // it directly on your radar" — that the application is in, never when.
    [/\b(applied|application|put the application in)\b[^.]{0,40}\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i,
      'names the application DATE (banned 2026-08-03) — say that you applied, never when'],
  ]) {
    if (re.test(blob)) { violations.push({ sev: 'HARD', msg: label }); score -= 40; }
  }

  // HARD: LinkedIn char cap
  if (charLimit && body.length > charLimit) {
    violations.push({ sev: 'HARD', msg: `over cap ${body.length}/${charLimit}` });
    score -= 40;
  }

  // HARD: CTA correctness by persona
  const isLeader = persona.toLowerCase().includes('leader');
  if (isLeader) {
    if (CHAT_CTAS.some((t) => lower.includes(t))) { violations.push({ sev: 'HARD', msg: 'Leader uses a chat CTA (should be a pointer ask)' }); score -= 30; }
    if (!POINTER.some(re => re.test(blob))) { violations.push({ sev: 'WARN', msg: 'Leader missing pointer/route ask' }); score -= 10; }
  } else if (channel === 'linkedin_connection') {
    if (!CHAT_CTAS.some((t) => lower.includes(t))) { violations.push({ sev: 'HARD', msg: `LinkedIn CTA is not one of the approved set (${CHAT_CTAS.map((t) => `"${t}"`).join(', ')})` }); score -= 30; }
  } else if (channel === 'email') {
    if (!EMAIL_CTA.test(blob)) { violations.push({ sev: 'WARN', msg: 'email missing chat/mutual-fit ask' }); score -= 10; }
  }

  // WARN: email subject format "Your Next {role} - {name}", plain hyphen
  if (channel === 'email') {
    if (!/^your next .+ - .+$/i.test(subject)) { violations.push({ sev: 'WARN', msg: `subject off-format: "${subject}"` }); score -= 10; }
  }

  // WARN: banned phrases
  for (const b of BANNED) if (lower.includes(b)) { violations.push({ sev: 'WARN', msg: `banned phrase "${b}"` }); score -= 10; }

  // WARN: JD anchor provenance
  // INFO (no deduction): a missing JD block applies to every variant equally, so a per-pick
  // penalty only flattened the ranking. Reported once per slot in main instead.
  if (!(pick.provenance || []).some(p => /jd anchor/i.test(p))) noJdAnchor = true;

  // HARD: a bullet that opens with a back-reference.
  // The three bullets are REORDERED by design (VORDER), so every bullet has to read
  // correctly in any position. Shipped 2026-07-26: silver's first bullet was "Getting
  // it reliable meant iterating against real inbound outcomes..." with no antecedent
  // for "it", because gold's first bullet had been moved below it.
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s+(.*)$/);
    if (!m) continue;
    const head = m[1].split(',')[0];
    if (BACKREF.test(head)) {
      violations.push({ sev: 'HARD', msg: `bullet opens with a back-reference ("${head.slice(0, 40)}...") — bullets are reordered, so each must stand alone` });
      score -= 30;
    }
  }

  // HARD: a claim amputated to fit the cap.
  // fitLinkedIn used to trim the pitch clause mid-phrase, severing the verb carrying the
  // result ("until meeting conversion" vs "until meeting conversion doubled"). A trimmed
  // clause that still parses is worse than a dropped one.
  //
  // This gates on a flag the GENERATOR sets, not on a text heuristic. The heuristic was
  // tried first and had to be abandoned: no regex can distinguish "until meeting
  // conversion." (amputated) from "holding $200K in retention." (complete) without a
  // parser, and the attempt flagged four correct drafts. gen-outreach records whether
  // fitLinkedIn actually cut.
  // HARD: the email must match TEMPLATE A (the house email shape).
  //
  //   Hi {first},
  //   Saw {one specific thing}. I applied for the {role} role and wanted to reach you directly.
  //   {one-sentence identity, ending in a colon}
  //   - three bullets
  //
  // TWO paragraphs before the bullets. A third paragraph (a JD "what drew me" line, or a long
  // credentials bridge) restates what the bullets then prove and reads as too wordy.
  //
  // The shape is structural but the opener is hand-written per person in each spec's emailObs,
  // so nothing else stops a future spec drifting back. gen-outreach warns; this fails the gate.
  if (channel === 'email') {
    // Body only: the generator's checkTemplateA budgets the body, so the subject must not count here.
    const cut = body.indexOf('\n\n- ');
    if (cut !== -1) {
      const pre = body.slice(0, cut);
      const paras = pre.split('\n\n').filter((x) => x.trim()).length - 1;   // minus the greeting
      const words = pre.split(/\s+/).filter(Boolean).length;
      if (paras !== 2) {
        violations.push({ sev: 'HARD', msg: `Template A wants 2 paragraphs before the bullets, this has ${paras}` });
        score -= 20;
      }
      if (words > 75) {
        violations.push({ sev: 'HARD', msg: `${words} words before the bullets, Template A budget is 75` });
        score -= 20;
      }
    }
  }

  if (pick.truncated === true) {
    violations.push({ sev: 'HARD', msg: 'body was truncated to fit the char cap — a claim may have lost its outcome verb; use a shorter whole clause instead' });
    score -= 30;
  }

  // HARD-ish: every numeric claim must appear in cv.md
  const cvNorm = cvText.replace(/\s+/g, ' ').toLowerCase();
  for (const t of claimTokens(blob)) {
    if (!cvNorm.includes(t.toLowerCase())) {
      violations.push({ sev: 'HARD', msg: `claim "${t}" not found in cv.md` });
      score -= 25;
    }
  }

  return { rank: pick.rank, score, char_count: body.length, violations, noJdAnchor };
}

// ── main ────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
const jsonOnly = process.argv.includes('--json');
const path = resolveTarget(arg);
const drafts = JSON.parse(readFileSync(path, 'utf-8'));
const cvText = existsSync('cv.md') ? readFileSync('cv.md', 'utf-8') : '';
if (!cvText) console.error('warning: cv.md not found — claim cross-check skipped');

let hardCount = 0;
const slots = [];
for (const p of drafts.personas) {
  for (const ch of p.channels) {
    const scored = ch.picks.map(pk => scorePick(pk, p.persona, ch.channel, ch.char_limit, cvText));
    scored.sort((a, b) => b.score - a.score);     // best first; gen order breaks ties (gold listed first)
    const winner = scored[0];
    hardCount += scored.reduce((n, s) => n + s.violations.filter(v => v.sev === 'HARD').length, 0);
    const notes = scored.every(s => s.noJdAnchor) ? ['no JD block for this job; variants ranked on copy alone'] : [];
    for (const s of scored) delete s.noJdAnchor;
    slots.push({ persona: p.persona, channel: ch.channel, contact: p.target.name, winner: winner.rank, ranked: scored, notes });
  }
}

/**
 * CROSS-RECIPIENT DUPLICATION (2026-07-26).
 *
 * Every check above scores ONE draft in isolation, so nothing could see the defect the
 * user actually reported: two people at the same company receiving the same letter.
 * Measured across output/outreach at the time this was written: 323 same-company gold
 * email pairs, 112 sharing an identical bullet set in identical order (34.7%), and 18
 * byte-identical once the first name is masked.
 *
 * WARN, not HARD, and the reasoning matters. A hard gate whose only escape is new prose
 * puts direct pressure on the generator to MANUFACTURE a difference, which is the worst
 * incentive to build into a pipeline constrained by what cv.md can support. The honest
 * remedy for two contacts with no differentiating signal is usually to drop one contact,
 * not to invent a distinction. So this reports and does not block.
 */
function maskName(body, name) {
  const f = String(name || '').trim().split(' ')[0];
  return f ? body.split(f).join('«NAME»') : body;
}
const bulletSet = body => body.split('\n').filter(l => /^\s*-\s+/.test(l)).map(l => l.trim()).join('|');

const duplication = [];
for (const ch of ['email', 'linkedin_connection']) {
  const winners = slots
    .filter(s => s.channel === ch)
    .map(s => {
      const p = drafts.personas.find(x => x.persona === s.persona && x.target.name === s.contact);
      const chan = p && p.channels.find(c => c.channel === ch);
      const pick = chan && chan.picks.find(k => k.rank === s.winner);
      return pick ? { contact: s.contact, persona: s.persona, body: pick.body || '' } : null;
    })
    .filter(Boolean);
  for (let i = 0; i < winners.length; i++) {
    for (let j = i + 1; j < winners.length; j++) {
      const a = winners[i], b = winners[j];
      const identical = maskName(a.body, a.contact) === maskName(b.body, b.contact);
      const sameBullets = bulletSet(a.body) && bulletSet(a.body) === bulletSet(b.body);
      if (identical || sameBullets) {
        duplication.push({
          channel: ch, a: a.contact, b: b.contact,
          kind: identical ? 'byte-identical (after name mask)' : 'identical bullet set and order',
        });
      }
    }
  }
}

// Personalization provenance: how many contacts got a real, person-specific observation
// versus the shared company template. gen-outreach computes observationSource; until
// 2026-07-26 it never reached the artifact, so every card claimed the observation came
// from the recipient's headline even when it was boilerplate.
const provenance = drafts.personas.map(p => ({
  contact: p.target.name,
  observation_source: p.target.observation_source || 'unknown',
  // Keep in sync with gen-outreach.mjs; see the note there for why 'profile-experience' counts.
  // 'profile-activity' added 2026-09-08: it IS the scraped post this check asks for. The
  // duplication message tells you to fix a shared observation with 'a real per-person hook (a
  // scraped post)', so a hook sourced from the person's recent-activity feed has to count, or
  // doing exactly what the tool advises still scores zero.
  personalized: ['recent-post', 'hiring-post', 'profile-experience', 'profile-activity'].includes(p.target.observation_source),
}));
const personalizedCount = provenance.filter(p => p.personalized).length;

const scorecard = { source: path, company: drafts.header.company, role: drafts.header.role, judged_at: new Date().toISOString(), hard_violations: hardCount, duplication, personalization: { personalized: personalizedCount, total: provenance.length, detail: provenance }, slots };
const outPath = path.replace(/\.drafts\.json$/, '.scorecard.json');
writeFileSync(outPath, JSON.stringify(scorecard, null, 2));

if (jsonOnly) { console.log(JSON.stringify(scorecard, null, 2)); process.exit(hardCount ? 1 : 0); }

console.log(`\n${drafts.header.company} — ${drafts.header.role}`);
console.log(`source: ${path}`);
console.log(`scorecard: ${outPath}\n`);
for (const s of slots) {
  const order = s.ranked.map(r => `${r.rank}:${r.score}`).join('  ');
  console.log(`${s.persona} / ${s.channel}  (${s.contact})`);
  console.log(`  pick: ${s.winner.toUpperCase()}    [${order}]`);
  for (const n of s.notes || []) console.log(`    i ${n}`);
  for (const r of s.ranked) for (const v of r.violations) console.log(`    ${v.sev === 'HARD' ? '✗' : '!'} ${r.rank}: ${v.msg}`);
}
if (duplication.length) {
  console.log(`\n! ${duplication.length} cross-recipient duplication(s):`);
  for (const d of duplication) console.log(`    ${d.channel}: ${d.a} and ${d.b} — ${d.kind}`);
  console.log('    Two people at one company comparing letters would see this. The fix is a real');
  console.log('    per-person hook (a scraped post) or dropping the weaker contact, NOT invented copy.');
}
console.log(`\npersonalization: ${personalizedCount}/${provenance.length} contact(s) have a person-specific observation` +
  (personalizedCount < provenance.length ? ` (${provenance.length - personalizedCount} on the shared company line)` : ''));

console.log(`\n${hardCount ? `✗ ${hardCount} HARD violation(s) — fix before sending.` : '✓ no hard violations.'}`);
process.exit(hardCount ? 1 : 0);
