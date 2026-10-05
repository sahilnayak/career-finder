#!/usr/bin/env node
// render-outreach.mjs
// Read a drafts JSON file produced by the `outreach` mode and render it to HTML.
// Usage: node scripts/render-outreach.mjs <path-to-drafts.json> [--out <html-path>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'outreach-template.html');

function die(msg, code = 1) {
  process.stderr.write(`render-outreach: ${msg}\n`);
  process.exit(code);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function classifyCharCount(count, limit) {
  if (limit == null) return '';
  if (count > limit) return 'over';
  if (count > limit - 20) return 'warn';
  return 'ok';
}

function renderProvenance(items) {
  if (!items || !items.length) return '';
  const lis = items.map(i => `    <li>${escapeHtml(i)}</li>`).join('\n');
  return `      <div class="provenance">
        <span class="label">Provenance</span>
        <ul>
${lis}
        </ul>
      </div>`;
}

function renderCopyBlock(id, label, raw) {
  const safe = escapeHtml(raw || '');
  const safeRaw = escapeAttr(raw || '');
  return `        <div class="copy-block">
          <span class="label">${escapeHtml(label)}</span>
          <button class="copy-btn" data-target="${id}">Copy</button>
          <div id="${id}" data-raw="${safeRaw}">${safe}</div>
        </div>`;
}

function renderPick(pick, channel, idxBase) {
  const medalLabel = pick.rank ? pick.rank.toUpperCase() : 'PICK';
  const cssRank = (pick.rank || 'gold').toLowerCase();

  const charLimit = channel.char_limit ?? null;
  const count = pick.char_count ?? (pick.body ? pick.body.length : 0);
  const charClass = classifyCharCount(count, charLimit);
  const charBadge = charLimit
    ? `<span class="charcount ${charClass}">${count}/${charLimit}</span>`
    : '';

  const subjectBlock = pick.subject
    ? renderCopyBlock(`${idxBase}-subject`, 'Subject', pick.subject)
    : '';
  const bodyBlock = renderCopyBlock(`${idxBase}-body`, 'Body', pick.body || '');

  const why = pick.why_picked
    ? `      <p class="why">${escapeHtml(pick.why_picked)}</p>`
    : '';

  const provenance = renderProvenance(pick.provenance);

  return `    <div class="pick ${cssRank}">
      <span class="medal">${escapeHtml(medalLabel)}</span>${charBadge}
${why}
${subjectBlock}
${bodyBlock}
${provenance}
    </div>`;
}

function renderChannel(channel, channelIdx, personaIdx) {
  const labelMap = {
    email: 'Email',
    linkedin_connection: 'LinkedIn -- connection request (≤300 chars)',
    linkedin_dm: 'LinkedIn -- direct message (≤300 chars)',
  };
  const label = labelMap[channel.channel] || channel.channel;
  const picks = (channel.picks || [])
    .map((p, i) => renderPick(p, channel, `p${personaIdx}-c${channelIdx}-r${i}`))
    .join('\n');
  return `  <div class="channel">
    <h3>${escapeHtml(label)}</h3>
${picks}
  </div>`;
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) return '';
  const lis = warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
  return `  <div class="warnings"><strong>Notes:</strong><ul>${lis}</ul></div>`;
}

function renderPersona(persona, personaIdx) {
  const target = persona.target || {};
  const targetLine = [
    target.name && `<a href="${escapeAttr(target.linkedin_url || '#')}">${escapeHtml(target.name)}</a>`,
    target.headline && escapeHtml(target.headline),
    target.tenure && escapeHtml(target.tenure),
  ].filter(Boolean).join(' -- ');
  const emailLine = target.email
    ? `<p class="target">Email: <a href="mailto:${escapeAttr(target.email)}">${escapeHtml(target.email)}</a>${target.email_confidence ? ` <em>(${escapeHtml(target.email_confidence)})</em>` : ''}</p>`
    : `<p class="target">Email: <em>none verified (LinkedIn only)</em></p>`;
  // Badge whether the observation is genuinely person-specific or the shared company
  // line. The card used to label every observation "Observation evidence" regardless,
  // which asserted personalization that often was not there.
  const SOURCE_LABEL = {
    'hiring-post': 'personalized (their hiring post)',
    'recent-post': 'personalized (their recent post)',
    'company-template': 'TEMPLATE (shared company line, not person-specific)',
    'spec-provided': 'hand-written in the spec',
  };
  const srcLabel = SOURCE_LABEL[target.observation_source] || 'source unrecorded';
  const observation = target.observation_evidence
    ? `<p class="observation"><strong>${escapeHtml(srcLabel)}</strong> &mdash; ${escapeHtml(target.observation_evidence)}</p>`
    : '';
  const warnings = renderWarnings(persona.warnings);
  const channels = (persona.channels || [])
    .map((c, i) => renderChannel(c, i, personaIdx))
    .join('\n');
  const sendNote = persona.send_recommendation
    ? `<p class="target"><em>${escapeHtml(persona.send_recommendation)}</em></p>`
    : '';
  return `<section class="persona">
  <h2>${escapeHtml(persona.persona || 'Persona')}</h2>
  <p class="target">${targetLine}</p>
  ${emailLine}
  ${sendNote}
  ${observation}
  ${warnings}
${channels}
</section>`;
}

function renderChecklistItems(personas) {
  const items = [];
  personas.forEach((p) => {
    (p.channels || []).forEach((c) => {
      const labelMap = {
        email: 'Email',
        linkedin_connection: 'LinkedIn connect',
        linkedin_dm: 'LinkedIn DM',
      };
      const channelLabel = labelMap[c.channel] || c.channel;
      const personaLabel = p.persona || 'Persona';
      items.push(`<li><label><input type="checkbox"> Sent ${escapeHtml(personaLabel)} -- ${escapeHtml(channelLabel)}</label></li>`);
    });
  });
  return items.join('\n');
}

function renderBanner(header) {
  if (header.report_path) return '';
  return `<div class="banner"><strong>Note:</strong> No evaluation report was found at <code>reports/</code>. Bullets are pulled from <code>cv.md</code> + <code>config/profile.yml</code> only and may be weaker. Consider running <code>/career-finder offer</code> first to generate Block B (CV match) and Block F (STAR proof points).</div>`;
}

function reportLink(header) {
  if (!header.report_path) return '';
  return ` -- <a href="../../${escapeAttr(header.report_path)}">report</a>`;
}

function render(drafts) {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const header = drafts.header || {};
  const candidate = drafts.candidate || {};
  const personas = drafts.personas || [];

  const personasHtml = personas.map((p, i) => renderPersona(p, i)).join('\n');
  const checklistItems = renderChecklistItems(personas);
  const banner = renderBanner(header);

  return tpl
    .replaceAll('{{COMPANY}}', escapeHtml(header.company || ''))
    .replaceAll('{{ROLE}}', escapeHtml(header.role || ''))
    .replaceAll('{{DATE}}', escapeHtml(header.date || ''))
    .replaceAll('{{JD_URL}}', escapeAttr(header.jd_url || '#'))
    .replaceAll('{{CANDIDATE_NAME}}', escapeHtml(candidate.name || ''))
    .replaceAll('{{REPORT_LINK}}', reportLink(header))
    .replaceAll('{{BANNER}}', banner)
    .replaceAll('{{SEND_ORDER}}', escapeHtml(drafts.send_order || 'Send HM channels first, recruiter same day, peer day 2, leader as escalation.'))
    .replaceAll('{{CHECKLIST_ITEMS}}', checklistItems)
    .replaceAll('{{PERSONAS_HTML}}', personasHtml);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = args._[0];
  if (!inPath) die('missing input. usage: render-outreach.mjs <drafts.json> [--out <html-path>]');
  if (!fs.existsSync(inPath)) die(`input not found: ${inPath}`);

  let drafts;
  try {
    drafts = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  } catch (e) {
    die(`failed to parse JSON: ${e.message}`);
  }

  const header = drafts.header || {};
  const company = slugify(header.company || 'company');
  const role = slugify(header.role || 'role');
  const date = header.date || new Date().toISOString().slice(0, 10);
  const defaultName = `${company}-${role}-${date}.html`;
  const outDir = path.join(ROOT, 'output', 'outreach');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = args.out || path.join(outDir, defaultName);

  const html = render(drafts);
  fs.writeFileSync(outPath, html, 'utf8');
  process.stdout.write(`${outPath}\n`);
}

main();
