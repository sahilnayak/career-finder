#!/usr/bin/env node
/**
 * outreach-review-hook.mjs — PostToolUse hook (matcher: Bash).
 *
 * Goal: have an agent review every generated outreach draft BEFORE it is emailed.
 * When a Bash command runs `gen-outreach.mjs` (i.e. an outreach HTML was just
 * (re)generated), this injects a reminder so the agent runs the `outreach-review`
 * skill on the fresh file. Silent for every other command (negligible overhead).
 *
 * It stays silent when the command carries OUTREACH_REVIEW_REGEN=1 — the review
 * skill sets that on its own regenerate step (SKILL.md §6), so the nudge does not
 * re-fire on review-driven regens.
 *
 * Reads the PostToolUse JSON on stdin; emits
 *   {hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:"..."}}
 * which Claude Code surfaces as context for the next step.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve from this file, not the cwd: hooks fire with the user's shell dir.
const OUTREACH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'output', 'outreach');
const FRESH_MS = 3 * 60 * 1000; // HTMLs touched within 3 min == this generation

let cmd = '';
try {
  const payload = JSON.parse(readFileSync(0, 'utf-8'));
  cmd = (payload.tool_input && payload.tool_input.command) || '';
} catch {
  process.exit(0); // not parseable -> do nothing
}

// Fire only when gen-outreach is actually EXECUTED (node ... gen-outreach.mjs), not when the
// path is merely referenced as an argument to git/grep/cat/etc. (a `git diff scripts/gen-outreach.mjs`
// must NOT trigger a review). Also skip the review skill's own regenerate step.
const executed = /node\b[^;&|]*gen-outreach\.mjs/.test(cmd);
if (!executed || /OUTREACH_REVIEW_REGEN=1|--no-review/.test(cmd)) {
  process.exit(0);
}

// Which HTMLs were just written? (mtime within the freshness window, newest first.)
let fresh = [];
try {
  const now = Date.now();
  fresh = readdirSync(OUTREACH_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => ({ f, m: statSync(`${OUTREACH_DIR}/${f}`).mtimeMs }))
    .filter(x => now - x.m < FRESH_MS)
    .sort((a, b) => b.m - a.m)
    .map(x => `output/outreach/${x.f}`);
} catch { /* dir missing -> fall through to generic pointer */ }

const files = fresh.length ? fresh.join(', ') : 'the newest output/outreach/*.html';

const msg =
  `Outreach was just generated (${files}). The user's standing rule: an agent must review the output BEFORE it is emailed. ` +
  `Run the outreach-review skill now (Skill tool: outreach-review). It audits every email + LinkedIn draft against the house writing rules ` +
  `(em-dash ban, LinkedIn <=300, exact CTA per persona, no company funding), truth-checks each claim against cv.md / the eval report, ` +
  `verifies the contacts, and ASKS the user clarifying questions on anything unverifiable, then fixes at the SOURCE JSON (spec + bullets) ` +
  `and regenerates. Draft-only: never send. If you are already inside an outreach-review run (regenerating after applying fixes), just ` +
  `re-verify the new file; do not start a second review.`;

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }) + '\n'
);
