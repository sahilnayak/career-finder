/**
 * paths.mjs — the ONE place that knows where the mode files and the user narrative live.
 *
 * The mode playbooks are bundled inside the career-finder skill
 * (.claude/skills/career-finder/modes/). The user's filled narrative (archetypes, proof points,
 * scoring overrides) is user-layer and lives in config/narrative.md. Older installs kept it at
 * modes/_profile.md; resolveNarrative() still finds it there until doctor.mjs migrates it.
 *
 * All exported paths are repo-relative strings (claude -p prompts run from the repo root);
 * use abs() when a script needs an absolute path regardless of cwd.
 */
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const abs = p => join(ROOT, p);

export const MODES_DIR = '.claude/skills/career-finder/modes';
export const modeFile = m => `${MODES_DIR}/${m}.md`;
export const SHARED_MD = modeFile('_shared');
export const PROFILE_TEMPLATE = modeFile('_profile.template');
export const NARRATIVE_MD = 'config/narrative.md';
export const LEGACY_NARRATIVE_MD = 'modes/_profile.md';
export const SCAN_WEB_LEARNINGS = 'data/scan-web-learnings.md';

/** Repo-relative path of the user's narrative, or null if onboarding has not written one. */
export function resolveNarrative() {
  if (existsSync(abs(NARRATIVE_MD))) return NARRATIVE_MD;
  if (existsSync(abs(LEGACY_NARRATIVE_MD))) return LEGACY_NARRATIVE_MD;
  return null;
}

/** language.modes_dir accepts a bare code ('de') or the legacy 'modes/de'. */
export function langDir(v) {
  return `${MODES_DIR}/${String(v).replace(/^\.?\/?modes\//, '').replace(/\/+$/, '')}`;
}

const LEARNINGS_HEADER = `# scan-web learnings (append-only, newest first)
<!-- User/runtime data. \`feedback-outcomes.mjs --learn\`, \`speed-metrics.mjs\` and each scan-web
     iteration prepend dated one-line learnings below (yield per source, title families that respond,
     pre-filter rules). Format: \`- YYYY-MM-DD: <learning>. <what changes in step 2 or §Sources>.\` -->
## Learnings (append-only — each iteration adds one; newest first)
`;

/** Repo-relative path of the learnings file, created with its insertion marker if absent. */
export function ensureLearnings() {
  if (!existsSync(abs(SCAN_WEB_LEARNINGS))) {
    mkdirSync(abs('data'), { recursive: true });
    writeFileSync(abs(SCAN_WEB_LEARNINGS), LEARNINGS_HEADER);
  }
  return SCAN_WEB_LEARNINGS;
}
