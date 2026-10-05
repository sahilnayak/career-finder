#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CAREER_FINDER_CDP_PORT) || 9222;
const PROFILE_DIR = process.env.CAREER_FINDER_CHROME_PROFILE || join(homedir(), ".career-finder-chrome");
const CHROME_APP = "/Applications/Google Chrome.app";
const DARWIN_BIN = `${CHROME_APP}/Contents/MacOS/Google Chrome`;
const PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/**
 * Find a Chrome/Chromium binary (item #25). Order: CAREER_FINDER_CHROME env -> the macOS app
 * bundle -> google-chrome / chromium / chromium-browser on PATH. Returns null when none resolves;
 * callers treat that as "linkedin: SKIPPED (no Chrome)", never as a failure.
 */
export function resolveChromeBin(env = process.env, platform = process.platform) {
  const override = env.CAREER_FINDER_CHROME;
  if (override) return existsSync(override) ? override : null;
  if (platform === "darwin" && existsSync(DARWIN_BIN)) return DARWIN_BIN;
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of PATH_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

async function portOpen() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pidsForProfile() {
  try {
    const out = execSync(
      `pgrep -f -- "--user-data-dir=${PROFILE_DIR}"`,
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function start() {
  if (await portOpen()) {
    console.log(JSON.stringify({ status: "already-running", port: PORT }));
    return;
  }
  if (!existsSync(PROFILE_DIR)) mkdirSync(PROFILE_DIR, { recursive: true });
  const CHROME_BIN = resolveChromeBin();
  if (!CHROME_BIN) {
    console.error(JSON.stringify({ status: "error", reason: "chrome-not-found", hint: "set CAREER_FINDER_CHROME or install google-chrome/chromium" }));
    console.error("linkedin: SKIPPED (no Chrome)");
    process.exit(1);
  }
  // Launch through `open -g` rather than spawning the binary: a directly-spawned GUI app
  // activates itself and pulls macOS focus off whatever the user is working in. `-g` keeps it
  // behind, `-n` forces a separate instance from the user's everyday Chrome. `open` exits
  // immediately, but the port poll below is what actually confirms the browser came up, and
  // stop()/status() find the process by profile path — neither ever needed the child PID.
  const flags = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      // cdp.mjs opens every tab in the background so it never steals focus. Chrome throttles
      // timers and rAF in backgrounded renderers by default, which would stall exactly the
      // JS-rendered pages the crawl exists to read. These three keep it at full speed.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
  ];
  // On macOS the app bundle goes through `open` (focus reasons above); anywhere else, or with an
  // env override pointing at a raw binary, spawn it directly.
  const viaOpen = process.platform === "darwin" && CHROME_BIN === DARWIN_BIN;
  const child = viaOpen
    ? spawn("open", ["-g", "-n", "-a", CHROME_APP, "--args", ...flags], { detached: true, stdio: "ignore" })
    : spawn(CHROME_BIN, flags, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await portOpen()) {
      console.log(JSON.stringify({ status: "started", port: PORT, profile: PROFILE_DIR }));
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(JSON.stringify({ status: "error", reason: "timeout-waiting-for-port" }));
  process.exit(1);
}

function stop() {
  const pids = pidsForProfile();
  if (pids.length === 0) {
    console.log(JSON.stringify({ status: "not-running" }));
    return;
  }
  for (const pid of pids) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
  console.log(JSON.stringify({ status: "stopped", killed: pids }));
}

async function status() {
  const open = await portOpen();
  const pids = pidsForProfile();
  console.log(JSON.stringify({ port_open: open, port: PORT, pids, profile: PROFILE_DIR }));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "start") await start();
  else if (cmd === "stop") stop();
  else if (cmd === "status") await status();
  else if (cmd === "resolve") {
    const bin = resolveChromeBin();
    console.log(JSON.stringify({ chrome: bin }));
    process.exit(bin ? 0 : 1);
  } else {
    console.error("usage: chrome-debug.mjs <start|stop|status|resolve>");
    process.exit(2);
  }
}
