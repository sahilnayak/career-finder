#!/usr/bin/env node

/**
 * update-system.mjs — intentionally a no-op in career-finder.
 *
 * career-finder is a standalone fork. Pulling the upstream career-ops system layer over it would
 * overwrite the role-agnostic, config-driven scripts with the upstream versions, so this command
 * never fetches anything. It keeps the same CLI and JSON shape so anything that calls it
 * (session-start checks, tests) still works.
 *
 *   node scripts/update-system.mjs check     -> {"status":"up-to-date", ...}
 *   node scripts/update-system.mjs apply     -> explains there is nothing to apply
 *   node scripts/update-system.mjs rollback  -> explains there is nothing to roll back
 *   node scripts/update-system.mjs dismiss   -> no-op
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_FILE = join(ROOT, 'VERSION');
const local = existsSync(VERSION_FILE) ? readFileSync(VERSION_FILE, 'utf-8').trim() : '0.0.0';
const cmd = process.argv[2] || 'check';

switch (cmd) {
  case 'check':
    console.log(JSON.stringify({ status: 'up-to-date', local, remote: local, note: 'career-finder does not pull upstream updates' }));
    break;
  case 'apply':
  case 'rollback':
    console.log(`career-finder is a standalone fork: there is no upstream to ${cmd}. Nothing changed.`);
    break;
  case 'dismiss':
    console.log(JSON.stringify({ status: 'dismissed' }));
    break;
  default:
    console.error('usage: update-system.mjs <check|apply|rollback|dismiss>');
    process.exit(1);
}
