#!/usr/bin/env node

/**
 * role-filters.mjs — shared pre-scoring filters for every role feed.
 *
 * Thin compatibility layer over targets.mjs. The exported names are kept so existing lanes keep
 * importing what they always imported, but every word and place now comes from
 * config/profile.yml (targets.* and location.*). Nothing role- or city-specific lives here.
 *
 * Legacy name mapping:
 *   SEARCH_KEYWORDS  -> targets.roles (lowercased): what keyword lanes ASK for
 *   TITLE_KEEP       -> positive regex (roles + title_keywords)
 *   TITLE_DROP       -> soft negatives (neutralized by a positive)
 *   LEADERSHIP_HARD  -> hard negatives ("!"-prefixed title_negatives; always drop)
 *   SE_FAMILY        -> PRIMARY_FAMILY: the primary_role regex (kept as an alias)
 *   BAY              -> LOCAL: the configured metro/city/cities regex (kept as an alias)
 *
 * The constants are resolved once at import. If the profile is missing they become
 * match-nothing regexes and an empty keyword list, so importing never crashes; CLI scripts must
 * call requireTargets() (re-exported here) at startup to fail with the onboarding message.
 */

import { readFileSync } from 'fs';
import {
  loadTargets, requireTargets, hasTargets, titleDropped as tDropped, titleMatches, isPrimaryRole,
  positiveRegex, negativeRegex, hardNegativeRegex, primaryRegex, remoteAllowed, classifyLocation,
  locationMatches, searchKeywords, areaLabel, workplaceAllowed, dealbreakerHit, yoeTooHigh, timezone,
  titleVariants,
} from './targets.mjs';

export {
  loadTargets, requireTargets, hasTargets, titleMatches, isPrimaryRole, classifyLocation, locationMatches, areaLabel,
  workplaceAllowed, dealbreakerHit, yoeTooHigh, timezone, titleVariants,
};

const NEVER = /(?!)/;
const ready = hasTargets();
const localRe = () => {
  const l = loadTargets().location;
  const keys = [...new Set([...l.cities, l.city, l.metro].map(s => s.toLowerCase().trim()).filter(Boolean))];
  return keys.length ? new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : NEVER;
};

export const REMOTE = /\b(remote|anywhere|distributed|work from home|wfh)\b/i;

export const SEARCH_KEYWORDS = Object.freeze(ready ? searchKeywords() : []);
export const TITLE_KEEP = ready ? positiveRegex() : NEVER;
export const TITLE_DROP = ready ? negativeRegex() : NEVER;
export const LEADERSHIP_HARD = ready ? hardNegativeRegex() : NEVER;
export const PRIMARY_FAMILY = ready ? primaryRegex() : NEVER;
export const SE_FAMILY = PRIMARY_FAMILY; // legacy alias
export const LOCAL = ready ? localRe() : NEVER;
export const BAY = LOCAL;               // legacy alias

/** Drop before scoring? Hard negatives always; soft negatives only without a positive. */
export function titleDropped(title) { return ready ? tDropped(title) : false; }

/**
 * May we keep this REMOTE posting? Callers test REMOTE first. Governed by
 * location.remote_policy; the title argument is kept for API compatibility and is scanned for
 * foreign-region markers ("... - EMEA").
 */
export function remoteOkFor(title, loc) {
  if (!ready) return false;
  if (titleDropped(title)) return false;
  return remoteAllowed(loc, title);
}

function loadList(file) {
  try {
    return readFileSync(file, 'utf-8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.toLowerCase());
  } catch { return []; }
}

/**
 * The shared employer blocklist. TWO files, ONE enforcement point.
 *   data/_speed-noise.txt   "not a real employer": staffing agency, relister, aggregator.
 *   data/_never-apply.txt   "a real employer the user does not want surfaced". Explicit only.
 * Every lane that names an employer must filter through loadNoise().
 */
export function loadNoise() {
  return [...loadList('data/_speed-noise.txt'), ...loadList('data/_never-apply.txt')];
}

/** Just the never-apply half, for anywhere that needs to explain WHY something was dropped. */
export function loadNeverApply() { return loadList('data/_never-apply.txt'); }
