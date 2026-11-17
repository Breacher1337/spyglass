#!/usr/bin/env node
// spyglass: drive a visible (non-headless) Chromium for Vibe.
//
//   MCP on stdio (for the Vibe CLI):   node server.mjs
//   MCP over Streamable HTTP (Vibe web connector): node server.mjs --http [--port 8765] [--token-file ~/secret]
//   Direct CLI:                        node server.mjs navigate example.com
//                                      node server.mjs snapshot | read | screenshot out.png | status | eval "1+1"
//
// Zero dependencies. Requires Node >= 22.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserSession } from './src/session.mjs';
import { startHttpServer } from './src/http-transport.mjs';
import { startStdioServer } from './src/stdio-transport.mjs';
import { callTool } from './src/tools.mjs';
import { randomBytes } from 'node:crypto';

const HELP = `spyglass - non-headless Chromium automation for Vibe (MCP + CLI)

Usage:
  node server.mjs                                   MCP server on stdio (Vibe CLI)
  node server.mjs --http                            MCP server on http://127.0.0.1:8765/mcp
  node server.mjs <command> [args]                  one-shot CLI command

Commands:
  status                browser + current tab state
  navigate <url>        open a URL
  snapshot              interactive-element tree with refs
  read [--max N]        readable page text
  click <ref>           click ref from snapshot
  type <ref> <text>     type text into element (append \\n to press Enter)
  press <key>           press a key, e.g. Enter or Control+A
  scroll down|up|top|bottom
  screenshot <file.png> [--full] [--jpeg]
  tabs | tab-new <url?> | tab-select <i> | tab-close <i?>
  eval "<js expression>"
  back | forward

Options:
  --http                run MCP over Streamable HTTP instead of stdio
  --port N              HTTP port (default 8765)
  --host H              HTTP bind host (default 127.0.0.1; loopback only is safest)
  --token T             require HTTP bearer token T
  --token-file F        read the HTTP bearer token from file F (recommended)
  --no-auth             allow HTTP without a token (insecure; local tests only)
  --browser-port N      Chrome debugging port (default 9222)
  --chrome-path P       explicit browser binary
  --profile-dir D       browser profile dir (default ~/.spyglass/profile)
  --headless            run headless instead of visible (defeats the purpose, for CI)
  --no-launch           attach only; never start a browser
  -h | --help           this help

Environment: SPYGLASS_PORT, SPYGLASS_HTTP_PORT, SPYGLASS_HOST,
SPYGLASS_TOKEN, SPYGLASS_CHROME_PATH, SPYGLASS_HEADLESS, SPYGLASS_NO_LAUNCH`;

// ------------------------------------------------------------------ parsing

function parseArgs(argv) {
  const opts = {
    http: false, port: null, host: null, token: null, tokenFile: null, noAuth: false,
    browserPort: 9222, chromePath: null, profileDir: null, headless: false, noLaunch: false,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--http': opts.http = true; break;
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = argv[++i]; break;
      case '--token': opts.token = argv[++i]; break;
      case '--token-file': opts.tokenFile = argv[++i]; break;
      case '--no-auth': opts.noAuth = true; break;
      case '--browser-port': opts.browserPort = Number(argv[++i]); break;
      case '--chrome-path': opts.chromePath = argv[++i]; break;
      case '--profile-dir': opts.profileDir = argv[++i]; break;
      case '--headless': opts.headless = true; break;
      case '--no-launch': opts.noLaunch = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) { fail(`Unknown option: ${a}\n\n${HELP}`); }
        positional.push(a);
    }
  }
  return { opts, positional };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const { opts, positional } = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

// env fallbacks
opts.browserPort = opts.browserPort || num(process.env.SPYGLASS_PORT) || 9222;
opts.port = opts.port ?? num(process.env.SPYGLASS_HTTP_PORT) ?? 8765;
opts.host = opts.host ?? process.env.SPYGLASS_HOST ?? '127.0.0.1';
opts.token = opts.token ?? process.env.SPYGLASS_TOKEN ?? null;
opts.chromePath = opts.chromePath ?? process.env.SPYGLASS_CHROME_PATH ?? null;
if (process.env.SPYGLASS_HEADLESS === '1') opts.headless = true;
if (process.env.SPYGLASS_NO_LAUNCH === '1') opts.noLaunch = true;

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// ------------------------------------------------------------------ session

const stdioMode = !opts.http && positional.length === 0;
const quiet = stdioMode; // never write logs to stdout in stdio MCP mode
const logger = quiet ? (...a) => console.error('[spyglass]', ...a) : (...a) => console.error('[spyglass]', ...a);

const session = new BrowserSession({
  browserPort: opts.browserPort,
  chromePath: opts.chromePath,
  profileDir: opts.profileDir,
  headless: opts.headless,
  noLaunch: opts.noLaunch,
  logger,
});

// ------------------------------------------------------------------ modes

if (opts.http) {
  let token = opts.token;
  if (!token && opts.tokenFile) {
    if (!existsSync(opts.tokenFile)) fail(`Token file not found: ${opts.tokenFile}`);
    token = readFileSync(opts.tokenFile, 'utf8').trim();
  }
  let insecure = false;
  if (!token) {
    if (opts.noAuth) {
      insecure = true;
      token = null;
    } else {
      token = randomBytes(24).toString('base64url');
      const generated = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.spyglass', 'token');
      try {
        const dir = path.dirname(generated);
        if (!existsSync(dir)) {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(generated, token + '\n', { mode: 0o600 });
      } catch {}
      console.error('\n[spyglass] Generated a bearer token and saved it to ~/.spyglass/token');
      console.error(`[spyglass] Token: ${token}\n`);
    }
  }
  await startHttpServer(session, { port: opts.port, host: opts.host, token });
  const displayHost = opts.host === '0.0.0.0' ? opts.host : opts.host;
  console.error(`[spyglass] Endpoint: http://${displayHost}:${opts.port}/mcp  (auth: ${insecure ? 'DISABLED (--no-auth)' : 'bearer token'})`);
  if (insecure) {
    console.error('[spyglass] WARNING: running without authentication. Anyone who can reach this port can drive your browser.');
  }
  console.error('[spyglass] For the Vibe web connector, expose it over HTTPS (e.g. `cloudflared tunnel --url http://127.0.0.1:' + opts.port + '`) and add the URL with the token.');
  process.on('SIGINT', () => { console.error('\n[spyglass] Shutting down.'); process.exit(0); });
} else if (positional.length === 0) {
  startStdioServer(session);
} else {
  // ---------------------------------------------------------- one-shot CLI
  const cmd = positional[0];
  let result;
  try {
    switch (cmd) {
      case 'status': result = await callTool(session, 'browser_status', {}); break;
      case 'navigate': case 'open':
        result = await callTool(session, 'browser_navigate', { url: positional[1] }); break;
      case 'snapshot':
        result = await callTool(session, 'browser_snapshot', {}); break;
      case 'read':
        result = await callTool(session, 'browser_read', {}); break;
      case 'click':
        result = await callTool(session, 'browser_click', { ref: positional[1] }); break;
      case 'type': {
        const text = positional.slice(2).join(' ');
        result = await callTool(session, 'browser_type', { ref: positional[1], text: text.replace(/\\n$/, ''), pressEnter: text.endsWith('\\n') });
        break;
      }
      case 'press':
        result = await callTool(session, 'browser_press_key', { key: positional[1] }); break;
      case 'scroll':
        result = await callTool(session, 'browser_scroll', { direction: positional[1] || 'down' }); break;
      case 'back': result = await callTool(session, 'browser_back', {}); break;
      case 'forward': result = await callTool(session, 'browser_forward', {}); break;
      case 'tabs': result = await callTool(session, 'browser_tab_list', {}); break;
      case 'tab-new':
        result = await callTool(session, 'browser_tab_new', positional[1] ? { url: positional[1] } : {}); break;
      case 'tab-select':
        result = await callTool(session, 'browser_tab_select', { index: Number(positional[1]) }); break;
      case 'tab-close':
        result = await callTool(session, 'browser_tab_close', positional[1] !== undefined ? { index: Number(positional[1]) } : {}); break;
      case 'eval':
        result = await callTool(session, 'browser_evaluate', { expression: positional[1] }); break;
      case 'screenshot': {
        const file = positional[1] || 'screenshot.png';
        const jpeg = /\.(jpe?g)$/i.test(file) || positional.includes('--jpeg');
        const full = positional.includes('--full');
        const shot = await callTool(session, 'browser_screenshot', { format: jpeg ? 'jpeg' : 'png', fullPage: full });
        const img = shot.content?.[0];
        if (shot.isError || !img || img.type !== 'image') fail(img?.text || 'Screenshot failed.');
        writeFileSync(file, Buffer.from(img.data, 'base64'));
        console.log(`Saved ${file}`);
        result = null;
        break;
      }
      default:
        fail(`Unknown command: ${cmd}\n\n${HELP}`);
    }
  } catch (err) {
    fail(`Error: ${err.message}`);
  }
  if (result) {
    const text = result.content?.[0]?.text ?? JSON.stringify(result);
    console.log(text);
    if (result.isError) process.exitCode = 1;
  }
}
