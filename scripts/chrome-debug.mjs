#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CAREER_FINDER_CDP_PORT) || 9222;
const PROFILE_DIR = process.env.CAREER_FINDER_CHROME_PROFILE || join(homedir(), ".career-finder-chrome");
const CHROME_APP = "/Applications/Google Chrome.app";
const CHROME_BIN = `${CHROME_APP}/Contents/MacOS/Google Chrome`;

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
      `pgrep -f "Google Chrome.*--user-data-dir=${PROFILE_DIR}"`,
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
  if (!existsSync(CHROME_BIN)) {
    console.error(JSON.stringify({ status: "error", reason: "chrome-not-found", path: CHROME_BIN }));
    process.exit(1);
  }
  // Launch through `open -g` rather than spawning the binary: a directly-spawned GUI app
  // activates itself and pulls macOS focus off whatever the user is working in. `-g` keeps it
  // behind, `-n` forces a separate instance from the user's everyday Chrome. `open` exits
  // immediately, but the port poll below is what actually confirms the browser came up, and
  // stop()/status() find the process by profile path — neither ever needed the child PID.
  const child = spawn(
    "open",
    [
      "-g",
      "-n",
      "-a", CHROME_APP,
      "--args",
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
    ],
    { detached: true, stdio: "ignore" },
  );
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

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") stop();
else if (cmd === "status") await status();
else {
  console.error("usage: chrome-debug.mjs <start|stop|status>");
  process.exit(2);
}
