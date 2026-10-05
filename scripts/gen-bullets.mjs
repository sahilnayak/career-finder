#!/usr/bin/env node

/**
 * gen-bullets.mjs — headless JD-mapped outreach bullets via `claude -p`.
 *
 * Produces, for ONE role, three email bullets (each mapped to a DIFFERENT top JD
 * requirement, ordered by JD priority) plus the short LinkedIn li/liLeader clauses
 * per variant. Writes to data/bullets/{slug}.json, which gen-outreach.mjs loads
 * automatically when the spec has no inline `bullets`. No browser needed — runs in
 * the headless cron path (same `claude -p` the speed loop already uses for scoring).
 *
 * Truthfulness: synthesize/recombine real cv.md + config/narrative.md experience and state
 * reasonable, defensible inferences (adjacent skills) — but invent NO fake metrics,
 * employers, or tools (rule set 2026-06-15).
 *
 * Usage:
 *   node scripts/gen-bullets.mjs --company "Acme" --role "Senior Data Engineer" \
 *        --jd-url https://... [--jd-text "..."] [--slug plaid] [--out data/bullets/plaid.json]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { requireTargets } from './targets.mjs';
import { resolveNarrative } from './lib/paths.mjs';

const PROFILE = requireTargets();
const PRIMARY = PROFILE.targets.primary_role || PROFILE.targets.roles[0];

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); args[k] = (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true; }
}
if (!args.company || !args.role) { console.error('usage: node scripts/gen-bullets.mjs --company X --role "Y" [--jd-url URL] [--jd-text ...] [--slug s] [--out f]'); process.exit(1); }

const slug = (args.slug || args.company).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = args.out || `data/bullets/${slug}.json`;
mkdirSync('data/bullets', { recursive: true });

const cv = existsSync('cv.md') ? readFileSync('cv.md', 'utf-8') : '';
const NARRATIVE = resolveNarrative();
const profile = NARRATIVE ? readFileSync(NARRATIVE, 'utf-8') : '';

const jdRef = args['jd-text']
  ? `JOB DESCRIPTION (text):\n${args['jd-text']}`
  : `JOB DESCRIPTION URL: ${args['jd-url'] || '(none — work from the role title + company)'}\nFetch it if you can; many ATS pages (Ashby/Workday/SPA) are JS-walled and will fail — then work from the role title, company, and archetype knowledge.`;

const prompt = `You write outreach material for ONE job, tailored to its job description. Output ONLY JSON (no prose, no markdown fences).

CANDIDATE — full resume (source of truth, never invent beyond it except reasonable defensible inferences):
${cv}

CANDIDATE — archetype/framing notes:
${profile.slice(0, 4000)}

TARGET ROLE: ${args.company} — ${args.role}
${jdRef}

TASK
1. Identify the THREE most important requirements of this specific job description, in priority order.
2. Write 3 email bullets, one per requirement, ordered by JD priority (bullet 0 = the #1 requirement). For EACH bullet, internally draft 3-5 candidates and keep the best. Each bullet: maps tightly to its JD requirement by WEAVING the JD's own verb/phrase for that requirement NATURALLY into the sentence (subtle echo — NOT a "Requirement: proof" label) so the reader sees the JD's own language reflected, anchored to the JD's product/mission/work and what the candidate BUILT, and NEVER describing the recipient's own role back to them ("your role is…"); grounded in the candidate's real experience or a reasonable, defensible inference (adjacent skill they could back up); concrete (a number or a named system where possible); <= 28 words; sounds like a credible ${PRIMARY} talking plainly about their own work, not a buzzword machine. NO em dashes. Invent NO fake metrics, employers, or tools.

   ORDER-INDEPENDENCE (hard rule). These three bullets are REORDERED downstream: every variant leads with a different one, so each bullet must read correctly in ANY position. Therefore:
   - No bullet may open with a back-reference or bare pronoun: not "It", "This", "That", "They", "Such", "Doing so", "Getting it", "Making it", "The same". A real failure this caused: bullet 1 read "Getting it reliable meant designing evaluations against real inbound…", which is fine after bullet 0 and meaningless when it leads, because "it" has no antecedent.
   - Every bullet must be a COMPLETE SENTENCE with a finite verb, naming its own subject. Re-read each bullet as if it were the FIRST thing the reader sees; if it depends on another bullet to make sense, rewrite it.
   - Do not reuse the same opening verb across the three bullets.
3. Write short LinkedIn pitch clauses for gold/silver/bronze variants (gold = lead on JD req #1, silver = req #2, bronze = req #3):
   - "li": a clause completing "I applied for the {role} role. {Li}." — <= 140 characters, JD-anchored, one proof point.
   - "liLeader": shorter (<= 95 chars), used in a tight leader message.

OUTPUT (only this JSON):
{"company":"${args.company}","role":"${args.role}","jd_reqs":["req1","req2","req3"],"bullets":["bullet0 (req1)","bullet1 (req2)","bullet2 (req3)"],"jd":{"gold":{"li":"...","liLeader":"..."},"silver":{"li":"...","liLeader":"..."},"bronze":{"li":"...","liLeader":"..."}},"provenance":["b0 <- ...","b1 <- ...","b2 <- ..."]}`;

console.log(`gen-bullets: ${args.company} — ${args.role} (claude -p)…`);
const res = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], { encoding: 'utf-8', timeout: 240000, maxBuffer: 10 * 1024 * 1024 });
if (res.status !== 0 || !res.stdout) { console.error('claude -p failed:', (res.stderr || '').slice(0, 300)); process.exit(1); }

// extract the JSON object from the model output (tolerate stray prose / fences)
function extractJson(s) {
  let t = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('{'); if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}
const jsonStr = extractJson(res.stdout);
let data;
try { data = JSON.parse(jsonStr); } catch (e) { console.error('could not parse JSON from claude output:\n', res.stdout.slice(0, 400)); process.exit(1); }

if (!Array.isArray(data.bullets) || data.bullets.length !== 3) { console.error('expected exactly 3 bullets, got:', JSON.stringify(data.bullets)); process.exit(1); }
// strip any em dashes the model slipped in (hard rule)
data.bullets = data.bullets.map(b => String(b).replace(/\s*—\s*/g, ': '));

// ORDER-INDEPENDENCE GUARD. The prompt asks for it; this verifies it, because the
// bullets are reordered per variant downstream and a back-reference that leads reads as
// a non-sequitur ("Getting it reliable meant…" as the FIRST bullet, shipped 2026-07-26).
// Fail loudly rather than writing a cache that poisons every future draft for this role:
// the cache is read by gen-outreach on every subsequent run.
const BACKREF = /^\s*(?:it|its|this|that|these|those|they|them|their|such|doing so|getting it|making it|keeping it|the same)\b/i;
const offenders = data.bullets
  .map((b, i) => ({ i, head: String(b).split(',')[0] }))
  .filter(x => BACKREF.test(x.head));
if (offenders.length) {
  console.error('✗ bullets are not order-independent — these open with a back-reference and would be meaningless when reordered to lead:');
  for (const o of offenders) console.error(`    b${o.i}: ${o.head}`);
  console.error('  Not writing the cache. Rerun; if it persists, tighten the JD requirements passed in.');
  process.exit(1);
}
for (const v of ['gold', 'silver', 'bronze']) {
  if (data.jd?.[v]?.li) data.jd[v].li = data.jd[v].li.replace(/\s*—\s*/g, ': ');
  if (data.jd?.[v]?.liLeader) data.jd[v].liLeader = data.jd[v].liLeader.replace(/\s*—\s*/g, ': ');
}

const out = { company: args.company, role: args.role, slug, jd_url: args['jd-url'] || null, generatedAt: new Date().toISOString(), ...data };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`✓ wrote ${OUT}`);
console.log('  JD reqs:', (data.jd_reqs || []).join(' | '));
data.bullets.forEach((b, i) => console.log(`  b${i}: ${b}`));
