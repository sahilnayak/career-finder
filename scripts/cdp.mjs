#!/usr/bin/env node

/**
 * cdp.mjs — minimal Chrome DevTools Protocol client. No Playwright, no dependencies.
 *
 * WHY THIS EXISTS (2026-08-06). Chrome auto-updated to 150 and Playwright 1.59.1 can no
 * longer attach to the debug browser:
 *
 *     browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior):
 *     Browser context management is not supported.
 *
 * Playwright issues browser-context commands on connect that a CDP-attached Chrome 150
 * refuses. `linkedin-crawl.mjs` exited 1 on every run from that moment, and because the
 * cron step ends in `|| true` the failure was INVISIBLE: the pipeline reported a quiet
 * market instead of a dead crawler. Measured cost: LinkedIn wrote its last row 2026-08-04
 * and nobody noticed for two days.
 *
 * The fix is to stop asking for the feature we never used. The crawl needs exactly four
 * things — open a tab, navigate, read the rendered text, close the tab — all of which are
 * plain CDP domains (Page, Runtime, Network) that Chrome 150 serves happily. Node 24 ships
 * a global WebSocket, so this costs zero dependencies and cannot drift out of sync with a
 * browser release again. This is the same protocol the chrome-devtools MCP speaks; the
 * difference is that a cron-run script can speak it directly, and MCP tools are only
 * available to an interactive agent.
 *
 * Usage:
 *   import { cdpAlive, newPage } from './cdp.mjs';
 *   if (!(await cdpAlive())) throw new Error('no debug Chrome');
 *   const page = await newPage();
 *   const { status, url } = await page.navigate('https://example.com');
 *   const title = await page.evaluate(() => document.title);
 *   await page.close();
 */

// CAREER_FINDER_CDP_PORT overrides the debug port for every script that goes through cdp.mjs.
export const DEFAULT_PORT = Number(process.env.CAREER_FINDER_CDP_PORT) || 9222;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Is the debug browser listening? Cheap, no WebSocket. */
export async function cdpAlive(port = DEFAULT_PORT, timeoutMs = 4000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * Ask the browser target for a tab that is NOT brought to the front. One command on its own
 * socket, closed straight away — the page gets its own socket below.
 */
async function createBackgroundTarget(port, openTimeout) {
  const ver = await cdpAlive(port, openTimeout);
  if (!ver?.webSocketDebuggerUrl) throw new Error('cdp: no browser socket');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp: browser socket open timeout')), openTimeout);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = e => { clearTimeout(t); reject(new Error(`cdp: browser socket error ${e?.message || ''}`)); };
    });
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp: timeout on Target.createTarget')), openTimeout);
      ws.onmessage = ev => {
        clearTimeout(t);
        let m; try { m = JSON.parse(ev.data); } catch { return reject(new Error('cdp: unparseable createTarget reply')); }
        if (m.error) return reject(new Error(m.error.message));
        if (!m.result?.targetId) return reject(new Error('cdp: createTarget returned no targetId'));
        resolve(m.result.targetId);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', background: true } }));
    });
  } finally { try { ws.close(); } catch { /* already gone */ } }
}

/**
 * Open a fresh tab and attach to it.
 *
 * The tab is created in the BACKGROUND by default (2026-08-24). `/json/new` can only produce a
 * FOREGROUND tab, and on macOS that raises the Chrome window and yanks focus out of whatever the
 * user is typing in — once per newPage(), so a crawl that opens a tab per card steals focus once
 * per card. There is no query param for it: `background` is a `Target.createTarget` flag, which
 * means going through a browser-level socket. Measured against Chrome 151: a background tab
 * navigates, renders and evaluates exactly like a foreground one, and focus never moves.
 *
 * Pair this with the anti-throttling flags in `chrome-debug.mjs` — Chrome slows timers in
 * backgrounded renderers by default, which would otherwise stall JS-rendered pages.
 *
 * Pass `{ background: false }` when you actually want to watch the tab work.
 *
 * Chrome's /json/new flipped from GET to PUT around M111 and older builds still answer GET, so
 * the fallback tries PUT then GET — a version check here would be one more thing to break.
 */
export async function newPage({ port = DEFAULT_PORT, openTimeout = 15000, background = true } = {}) {
  let targetId = null;
  let wsUrl = null;

  if (background) {
    try {
      targetId = await createBackgroundTarget(port, openTimeout);
      wsUrl = `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
    } catch (e) {
      targetId = null; wsUrl = null;             // a visible tab beats no tab at all
      // Say so. The fallback below can ONLY make a foreground tab, so this is the exact moment
      // the browser starts stealing macOS focus from whatever the user is typing in — once per
      // newPage(). Swallowing it silently made that behaviour unexplainable from the logs.
      console.warn(`cdp: background target failed (${e.message}) — falling back to a FOREGROUND tab, which will steal focus`);
    }
  }

  if (!wsUrl) {
    for (const method of ['PUT', 'GET']) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method });
        if (r.ok) { const t = await r.json(); targetId = t.id; wsUrl = t.webSocketDebuggerUrl; break; }
      } catch { /* try the other verb */ }
    }
  }
  if (!wsUrl) throw new Error(`cdp: could not open a tab on :${port}`);

  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();          // method -> Set<fn>

  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(timer);
      m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : resolve(m.result);
      return;
    }
    if (m.method && listeners.has(m.method)) for (const fn of listeners.get(m.method)) { try { fn(m.params); } catch { /* a listener must never kill the socket */ } }
  };

  const closedErr = new Error('cdp: socket closed');
  ws.onclose = () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(closedErr); } pending.clear(); };

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cdp: websocket open timeout')), openTimeout);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = e => { clearTimeout(t); reject(new Error(`cdp: websocket error ${e?.message || ''}`)); };
  });

  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp: timeout on ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
  });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };

  await send('Page.enable');
  await send('Network.enable');

  // Track the status of the MAIN DOCUMENT response. LinkedIn answers a throttled client
  // with HTTP 999 (its own non-standard code) or 429, and the crawl must trip a cooldown
  // rather than retry — so the status has to be observable, not inferred from page text.
  let mainFrameId = null;
  let lastDocStatus = null;
  on('Page.frameNavigated', p => { if (!p.frame?.parentId) mainFrameId = p.frame.id; });
  on('Network.responseReceived', p => {
    if (p.type !== 'Document') return;
    if (mainFrameId && p.frameId && p.frameId !== mainFrameId) return;
    lastDocStatus = p.response?.status ?? null;
  });

  const page = {
    targetId,

    /** Navigate and settle. Returns the main-document HTTP status and the final URL. */
    async navigate(url, { waitMs = 3500, loadTimeout = 45000 } = {}) {
      lastDocStatus = null;
      const loaded = new Promise(resolve => {
        const off = on('Page.loadEventFired', () => { off(); resolve(true); });
        setTimeout(() => { off(); resolve(false); }, loadTimeout);
      });
      const nav = await send('Page.navigate', { url }, loadTimeout);
      if (nav?.errorText) throw new Error(`cdp: navigation failed — ${nav.errorText}`);
      await loaded;
      if (waitMs) await sleep(waitMs);
      return { status: lastDocStatus, url: await page.url() };
    },

    /** Run a function in the page. Async functions are awaited; the result must be JSON-safe. */
    async evaluate(fn, { timeoutMs = 90000 } = {}) {
      const expression = typeof fn === 'string' ? fn : `(${fn.toString()})()`;
      const r = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
      }, timeoutMs);
      if (r.exceptionDetails) {
        throw new Error(`cdp: page exception — ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      return r.result?.value;
    },

    async url() {
      try { return await page.evaluate(() => location.href); } catch { return ''; }
    },

    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`); } catch { /* best effort */ }
    },
  };

  return page;
}

export { sleep };
