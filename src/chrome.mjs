// Find, launch and attach to a NON-HEADLESS Chromium-based browser.
// The debugging endpoint is always bound to 127.0.0.1 (loopback only).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getVersion } from './cdp.mjs';

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ],
};

/** Locate a Chromium-based browser binary. Returns null when none found. */
export function findBrowserBinary(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Browser binary not found at --chrome-path: ${explicitPath}`);
    }
    return explicitPath;
  }
  for (const p of CANDIDATES[process.platform] ?? []) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function defaultProfileDir() {
  return path.join(homedir(), '.spyglass', 'profile');
}

/**
 * True when a browser with a live debugging endpoint is already listening
 * on the port (ours from a previous run, or one the user started).
 */
export async function isDebuggerLive(port) {
  try {
    await getVersion(port);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch a visible (non-headless) browser and wait for its debugging endpoint.
 * @returns {Promise<{browserProcess: object|null, binary: string, attached: boolean}>}
 */
export async function ensureBrowser({ port, chromePath, profileDir, headless = false, noLaunch = false, logger }) {
  const log = (...a) => { if (logger) logger(...a); };

  if (await isDebuggerLive(port)) {
    log(`Attaching to a browser already listening on 127.0.0.1:${port}`);
    return { browserProcess: null, binary: null, attached: true };
  }

  if (noLaunch) {
    throw new Error(
      `No browser is listening on 127.0.0.1:${port} and --no-launch is set. ` +
      'Start your browser with --remote-debugging-port=' + port + ' or remove --no-launch.'
    );
  }

  const binary = findBrowserBinary(chromePath);
  if (!binary) {
    throw new Error(
      'No Chromium-based browser found in the usual locations. ' +
      'Install Google Chrome/Chromium/Edge/Brave, or pass --chrome-path /SPYGLASS_CHROME_PATH pointing at the binary.'
    );
  }

  const dir = profileDir || defaultProfileDir();
  mkdirSync(dir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    // Chrome 136+ refuses remote debugging on the default profile; a dedicated
    // dir is also cleaner: your normal Chrome windows are never touched.
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new'); // off by default: the point is a visible browser

  log(`Launching ${binary} (visible window) with debugging on 127.0.0.1:${port}`);
  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false, // we WANT the window
  });
  child.on('error', (err) => log(`Browser process error: ${err.message}`));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The browser exited immediately (code ${child.exitCode}). Another Chrome instance may be using the profile at ${dir}.`);
    }
    if (await isDebuggerLive(port)) {
      log('Browser is up and ready.');
      return { browserProcess: child, binary, attached: false };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try { child.kill(); } catch {}
  throw new Error(`The browser did not expose its debugging endpoint on 127.0.0.1:${port} within 20s.`);
}
