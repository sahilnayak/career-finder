#!/usr/bin/env node
/**
 * gen-jd-pdfs.mjs — render every local JD snapshot in data/jds/*.md to a PDF in output/jds/.
 *
 * WHY. data/jds/ is the durable record of a posting as it read at scoring time (an employer can
 * edit or pull a req: a Mixpanel role flipped Hybrid to Remote three hours after being scored).
 * Markdown is fine for the dashboard's built-in viewer, but it is not what you attach to an email,
 * hand to someone reviewing your pipeline, or archive as evidence of what the posting said. A PDF
 * is portable, prints, and cannot be silently edited.
 *
 * Styling deliberately matches templates/resume-style-guide.md (Arial, navy #1b3a5c accent) so a
 * JD and the resume tailored for it read as one set.
 *
 * IDEMPOTENT. Skips any JD whose PDF exists and is newer than the source .md, so it is safe on
 * every pipeline cycle. Use --force to re-render.
 *
 * Usage:
 *   node scripts/gen-jd-pdfs.mjs                  # render everything missing or stale
 *   node scripts/gen-jd-pdfs.mjs --only roadrunner,afresh
 *   node scripts/gen-jd-pdfs.mjs --qualifiers     # only JDs for jobs currently >= pipeline.qualify_score
 *   node scripts/gen-jd-pdfs.mjs --force
 *   node scripts/gen-jd-pdfs.mjs --dry-run
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { loadTargets } from './targets.mjs';
const QUALIFY = (() => { try { return loadTargets().pipeline.qualify_score; } catch { return 4.3; } })();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'data/jds');
const OUT = resolve(ROOT, 'output/jds');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const FORCE = has('--force'), DRY = has('--dry-run');
const ONLY = val('--only').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline: links first (so their text is not mangled), then bold, then code, then bare URLs.
function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, a, b) => `<a href="${b}">${a}</a>`);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, p, u) => `${p}<a href="${u}">${u}</a>`);
  return t;
}

function mdToHtml(md) {
  const out = [];
  let inList = false, inTable = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); closeTable(); continue; }
    if (/^---+$/.test(line.trim())) { closeList(); closeTable(); out.push('<hr>'); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); closeTable(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    // pipe table
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;              // separator row
      if (!inTable) { closeList(); out.push('<table><tbody>'); inTable = true; }
      out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join('\n');
}

const CSS = `
  @page { margin: 14mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #222; margin: 0; }
  h1 { font-size: 17pt; color: #1b3a5c; margin: 0 0 4pt; }
  h2 { font-size: 12pt; color: #1b3a5c; margin: 14pt 0 5pt; border-bottom: 1px solid #d6dde5; padding-bottom: 2pt; }
  h3 { font-size: 11pt; color: #1b3a5c; margin: 11pt 0 4pt; }
  p { margin: 0 0 6pt; }
  ul { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin-bottom: 3pt; }
  a { color: #1155cc; text-decoration: none; word-break: break-word; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 9.5pt; background: #f3f5f7; padding: 0 3px; border-radius: 2px; }
  hr { border: none; border-top: 1px solid #d6dde5; margin: 10pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 8pt; }
  td { border: 1px solid #d6dde5; padding: 4pt 6pt; vertical-align: top; font-size: 10pt; }
  tr:first-child td { background: #f3f5f7; font-weight: bold; }
  .meta { font-size: 8.5pt; color: #6b7785; margin-top: 12pt; border-top: 1px solid #d6dde5; padding-top: 5pt; }
`;

mkdirSync(OUT, { recursive: true });
let files = readdirSync(SRC).filter(f => f.endsWith('.md'));
if (ONLY.length) files = files.filter(f => ONLY.some(o => f.toLowerCase().includes(o)));

if (has('--qualifiers')) {
  const scored = readFileSync(resolve(ROOT, 'data/scored-jobs.tsv'), 'utf8').split('\n')
    .map(l => l.split('\t')).filter(c => parseFloat(c[3]) >= QUALIFY);
  const slugs = new Set(scored.map(c => `${c[1]} ${c[2]}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')));
  files = files.filter(f => [...slugs].some(s => s && f.toLowerCase().startsWith(s.split('-').slice(0, 2).join('-'))));
}

const todo = files.filter(f => {
  if (FORCE) return true;
  const pdf = resolve(OUT, f.replace(/\.md$/, '.pdf'));
  if (!existsSync(pdf)) return true;
  return statSync(resolve(SRC, f)).mtimeMs > statSync(pdf).mtimeMs;   // source newer => stale
});

console.log(`jd-pdfs: ${files.length} snapshot(s) in scope, ${todo.length} to render` + (DRY ? ' (dry run)' : ''));
if (DRY || !todo.length) { todo.slice(0, 12).forEach(f => console.log('  would render', f)); process.exit(0); }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let n = 0, failed = 0;
for (const f of todo) {
  try {
    const md = readFileSync(resolve(SRC, f), 'utf8');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
      ${mdToHtml(md)}
      <div class="meta">Snapshot rendered ${new Date().toISOString().slice(0, 10)} from data/jds/${esc(f)} . This is the posting as captured at scoring time; the live req may since have changed.</div>
    </body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({ path: resolve(OUT, f.replace(/\.md$/, '.pdf')), format: 'letter', printBackground: true });
    n++;
    if (n % 25 === 0) console.log(`  ...${n}/${todo.length}`);
  } catch (e) { failed++; console.log(`  ! ${f}: ${e.message.slice(0, 80)}`); }
}
await browser.close();
console.log(`jd-pdfs: rendered ${n}, failed ${failed} -> output/jds/`);
