#!/usr/bin/env node
/*
 * verify-stage.mjs — lightweight LLM verification at each important pipeline stage.
 *
 * WHAT: an auto-running, per-stage "judge" that adds the SEMANTIC checks the
 * deterministic gates can't do — JD-fit, truth-of-claim vs cv.md, archetype framing,
 * score-inflation. It runs AFTER the free deterministic gates (outreach-judge,
 * assertCvContract, reconcile, daily-quota), not instead of them.
 *
 * MODEL POLICY (modes/_profile.md, user-set 2026-06-28): verification/judging agents
 * use **Sonnet 4.6** by default ($3/$15 per 1M — ~40% cheaper than Opus, reliable enough
 * to judge). NEVER Opus for routine verification. This INTENTIONALLY overrides the global
 * "always Opus" instruction for verification agents ONLY — generation/scoring agents are
 * unaffected. Haiku is available behind --model haiku for purely mechanical checks, but the
 * global "never Haiku" rule means it stays opt-in. Distinct from the OPT-IN 6-Opus review
 * team (that stays the only Opus verification, triggered manually — see _profile.md).
 *
 * USAGE:
 *   node scripts/verify-stage.mjs --stage <score|outreach|resume|report> \
 *        --artifact <path|-> [--jd <path>] [--model sonnet|haiku|opus] [--json] [--dry-run]
 *
 * KILL-SWITCH: create data/VERIFY_OFF to disable (exits 0, verdict skipped).
 * EXIT: 0 = pass / skipped / judge-unavailable (skip-safe); 1 = HARD fail (severity high) for gating.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { requireTargets, areaLabel } from './targets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = ['score', 'outreach', 'resume', 'report'];
const MODEL_ALIASES = { sonnet: 'sonnet', haiku: 'haiku', opus: 'opus' }; // claude -p accepts aliases
const HARD = 'high';

// ---- args ----
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const stage = arg('stage');
const artifactArg = arg('artifact');
const jdArg = arg('jd');
const model = MODEL_ALIASES[arg('model', 'sonnet')] || 'sonnet'; // DEFAULT: sonnet (cost)
const asJson = has('json');
const dryRun = has('dry-run');

if (!stage || !STAGES.includes(stage)) {
  console.error(`verify-stage: --stage must be one of ${STAGES.join('|')}`);
  process.exit(2);
}
if (!artifactArg) {
  console.error('verify-stage: --artifact <path|-> is required');
  process.exit(2);
}

// ---- kill-switch ----
if (existsSync(resolve(ROOT, 'data/VERIFY_OFF'))) {
  console.error('verify-stage: OFF (data/VERIFY_OFF present) — skipping.');
  process.exit(0);
}

// ---- inputs ----
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s || '');
function readMaybe(p, n = 16000) {
  try { return clip(readFileSync(p.startsWith('/') ? p : resolve(ROOT, p), 'utf8'), n); }
  catch { return ''; }
}
function stripHtml(s) {
  return s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
          .replace(/&(nbsp|amp|lt|gt|quot|#\d+);/gi, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const ARTIFACT_CAP = 40000; // outreach HTML can be ~44k; strip tags + a generous cap so the judge sees ALL personas/channels
let artifactRaw = artifactArg === '-'
  ? (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })()
  : (() => { try { return readFileSync(artifactArg.startsWith('/') ? artifactArg : resolve(ROOT, artifactArg), 'utf8'); } catch { return ''; } })();
if (/\.html?$/i.test(artifactArg)) artifactRaw = stripHtml(artifactRaw); // strip to text so the judge isn't reading markup
const artifact = clip(artifactRaw, ARTIFACT_CAP);
if (!artifact) {
  console.error(`verify-stage: could not read artifact "${artifactArg}"`);
  process.exit(2);
}
const cv = readMaybe('cv.md', 8000);
const profile = readMaybe('modes/_profile.md', 6000);
const jd = jdArg ? (/^https?:\/\//.test(jdArg) ? `JD URL: ${jdArg}` : readMaybe(jdArg, 12000)) : '';

// ---- stage rubrics ----
const T = requireTargets();
const roleList = T.targets.roles.join(' / ');
const LOCATION_RULE = {
  onsite: `location must be onsite/hybrid within ${areaLabel()} (reject remote/anywhere/WFH/distributed)`,
  hybrid: `location must be onsite/hybrid within ${areaLabel()} (reject remote/anywhere/WFH/distributed)`,
  'remote-country': `location must be within ${areaLabel()} or remote inside ${T.location.country || 'the candidate\'s country'} (reject foreign-only remote)`,
  any: 'any location, including remote, is acceptable',
}[T.location.remote_policy] || `location must be within ${areaLabel()}`;
const RUBRICS = {
  score:
    `Re-verify the assigned score is NOT inflated. Check HARD GATES vs cv.md + _profile: ${LOCATION_RULE}; ` +
    'no unmet years-of-experience gate, clearance, named mandatory tech, or language gate. ' +
    `Confirm any score >=${T.pipeline.qualify_score} is justified by genuine JD<->cv fit and a correct target archetype (${roleList}). ` +
    `If a hard gate is unmet, or the fit is adjacent-domain-capped but scored >=${T.pipeline.qualify_score}, set severity=high and verdict=fail (inflation).`,
  outreach:
    'Judge the outreach drafts (deterministic gates already ran — you do JD-fit + truth + voice). ' +
    '(1) TRUTH: every $/% or numeric claim must appear in cv.md — any fabricated metric/employer/tool = severity high. ' +
    '(2) JD-ANCHOR: each variant must anchor on a DIFFERENT real JD requirement. ' +
    '(3) VOICE (semantic only): the deterministic outreach-judge ALREADY gates em-dashes, the <=300 cap, and the CTA — DO NOT re-flag those. Flag ONLY generic, templated openers with no company-specific hook. ' +
    '(4) CONTACTS: each recipient is plausibly on the hiring team (a "(TBD …)" placeholder is expected when LinkedIn is OFF — note it once, do not raise severity above medium for it).',
  resume:
    'Judge the tailored resume. Every line must trace to real cv.md content (select/reorder/reword only — NEVER invented; any fabricated metric/employer/tool = severity high). ' +
    'Ordering must be archetype-correct (leads with what the JD prioritizes). Tenure per employer and every number must match cv.md exactly.',
  report:
    'Judge the evaluation report. Blocks A–G present; every claim true to cv.md (no fabricated domain/tech/tenure); ' +
    'the Legitimacy tier and the A–F score rationale are internally consistent. Fabrication or a missing hard-gate check = severity high.',
};

// ---- prompt ----
const prompt = [
  `You are a careful, skeptical VERIFICATION judge for a job-search pipeline. Stage: ${stage}.`,
  `Default to flagging problems; a wrong "looks fine" is the costly failure. Be terse.`,
  ``,
  `RUBRIC:\n${RUBRICS[stage]}`,
  ``,
  `CANDIDATE (cv.md — the ONLY source of truth for claims):\n${cv}`,
  profile ? `\nTARGETING RULES (modes/_profile.md, excerpt):\n${profile}` : '',
  jd ? `\nJOB DESCRIPTION:\n${jd}` : '',
  ``,
  `ARTIFACT UNDER REVIEW (${stage}):\n${artifact}`,
  ``,
  `OUTPUT: respond with ONLY a single JSON object, no prose, no code fence:`,
  `{"stage":"${stage}","verdict":"pass"|"fail","severity":"none"|"low"|"medium"|"high",`,
  `"issues":[{"type":"...","detail":"...","fix":"..."}],"summary":"one line"}`,
  `Use verdict="fail"+severity="high" for any HARD violation (fabrication, unmet hard gate, score inflation, wrong CTA). Otherwise verdict="pass".`,
].filter(Boolean).join('\n');

// ---- dry run (no token spend) ----
if (dryRun) {
  console.error(`verify-stage: DRY RUN — stage=${stage} model=${model} promptChars=${prompt.length}`);
  console.log(prompt.slice(0, 1400) + (prompt.length > 1400 ? '\n…[prompt truncated for preview]' : ''));
  process.exit(0);
}

// ---- availability guard (skip-safe) ----
if (spawnSync('command', ['-v', 'claude'], { shell: true }).status !== 0) {
  console.error('verify-stage: `claude` CLI not found — skipping verification (exit 0, not a gate failure).');
  process.exit(0);
}

// ---- run the judge ----
const res = spawnSync('claude', ['-p', prompt, '--model', model, '--dangerously-skip-permissions'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (res.status !== 0 || !res.stdout) {
  console.error(`verify-stage: judge call failed (status ${res.status}) — skipping (exit 0).`);
  if (res.stderr) console.error(res.stderr.slice(0, 500));
  process.exit(0);
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const verdict = extractJson(res.stdout);
if (!verdict) {
  console.error('verify-stage: could not parse judge verdict — skipping (exit 0). Raw head:');
  console.error(res.stdout.slice(0, 400));
  process.exit(0);
}
verdict.stage = stage;
verdict.model = model;

// ---- persist scorecard ----
const outDir = resolve(ROOT, 'output/verify');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const slug = basename(artifactArg === '-' ? `stdin-${stage}` : artifactArg).replace(/\.[^.]+$/, '');
const outPath = resolve(outDir, `${stage}-${slug}-${stamp}.verify.json`);
writeFileSync(outPath, JSON.stringify(verdict, null, 2));

// ---- report ----
if (asJson) {
  console.log(JSON.stringify(verdict));
} else {
  const mark = verdict.verdict === 'pass' ? '✅' : '⚠️';
  console.log(`${mark} verify:${stage} [${verdict.severity}] ${verdict.summary || ''}  (${model})`);
  for (const it of verdict.issues || []) console.log(`   • ${it.type}: ${it.detail}${it.fix ? `  → ${it.fix}` : ''}`);
  console.log(`   scorecard: ${outPath.replace(ROOT + '/', '')}`);
}

// HARD fail gates the pipeline (exit 1); everything else exits 0.
process.exit(verdict.verdict === 'fail' && verdict.severity === HARD ? 1 : 0);
