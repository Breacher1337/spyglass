// Smoke tests for everything that does not need a real browser:
// - syntax of every module (node --check)
// - syntax of the in-page injected scripts (new Function)
// - MCP stdio transport end-to-end (initialize, tools/list, tools/call)
// - MCP Streamable HTTP transport end-to-end (initialize, tools/list,
//   tools/call, 401 auth, 405 GET, notifications -> 202)
// In this sandbox no Chrome exists, so browser-dependent calls must return a
// graceful isError result rather than crash. On a machine with Chrome, the
// same suite can additionally exercise real navigation (see README).

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, 'server.mjs');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ' - ' + detail : ''}`); }
};

// 1. Syntax: node --check every JS file ------------------------------------
console.log('\n[1] Syntax check (node --check)');
for (const f of ['server.mjs', 'src/cdp.mjs', 'src/chrome.mjs', 'src/page-scripts.mjs',
  'src/session.mjs', 'src/tools.mjs', 'src/mcp.mjs', 'src/http-transport.mjs',
  'src/stdio-transport.mjs']) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, f)]);
  check(`${f}`, r.status === 0, r.stderr?.toString().trim());
}

// 2. Injected page scripts parse as valid JS -------------------------------
console.log('\n[2] In-page script syntax');
{
  const mod = await import(path.join(root, 'src/page-scripts.mjs'));
  const scripts = [mod.snapshotScript(), mod.readScript(), mod.locateScript('e7'),
    mod.pageStateScript(), mod.scrollScript('down', 800), mod.scrollScript('top')];
  let ok = true;
  for (const s of scripts) {
    try { new Function('return (' + s + ')'); } catch (e) { ok = false; console.log('    parse fail:', e.message); }
  }
  check('all injected scripts parse', ok);
}

// 3. MCP over stdio ----------------------------------------------------------
console.log('\n[3] stdio transport');
{
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const got = [];
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const nextReply = async () => {
    const deadline = Date.now() + 15000;
    while (got.length === 0 && Date.now() < deadline) await sleep(30);
    return got.shift();
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) got.push(JSON.parse(line));
    }
  });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await nextReply();
  check('initialize responds', init?.id === 1 && init?.result?.protocolVersion === '2025-06-18', JSON.stringify(init));
  check('serverInfo present', init?.result?.serverInfo?.name === 'spyglass');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await nextReply();
  const names = list?.result?.tools?.map((t) => t.name) ?? [];
  check('tools/list has 17 tools', names.length === 17, `got ${names.length}`);
  check('read tools carry readOnlyHint', ['browser_snapshot', 'browser_read', 'browser_screenshot', 'browser_status']
    .every((n) => list.result.tools.find((t) => t.name === n)?.annotations?.readOnlyHint === true));
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_status', arguments: {} } });
  const status = await nextReply();
  check('browser_status returns graceful isError (no Chrome here)',
    status?.result?.isError === true && /browser|Chrome|Chromium/i.test(status?.result?.content?.[0]?.text ?? ''), JSON.stringify(status).slice(0, 140));
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_evaluate', arguments: { expression: '1+1' } } });
  const ev = await nextReply();
  check('browser_evaluate also fails gracefully', ev?.result?.isError === true);
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  const unknown = await nextReply();
  check('unknown tool -> JSON-RPC error -32602', unknown?.error?.code === -32602);
  send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  const pong = await nextReply();
  check('ping works', pong?.result && Object.keys(pong.result).length === 0);
  child.kill();
}

// 4. MCP over Streamable HTTP ------------------------------------------------
console.log('\n[4] Streamable HTTP transport');
{
  const { BrowserSession } = await import(path.join(root, 'src/session.mjs'));
  const { startHttpServer } = await import(path.join(root, 'src/http-transport.mjs'));
  const session = new BrowserSession({ noLaunch: false, logger: () => {} });
  const TOKEN = 'test-token-123';
  const server = await startHttpServer(session, { port: 18765, host: '127.0.0.1', token: TOKEN });
  const base = 'http://127.0.0.1:18765';
  const j = (r) => r.json();

  // auth enforced
  let res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  check('no token -> 401 + WWW-Authenticate', res.status === 401 && res.headers.get('www-authenticate')?.startsWith('Bearer'), `status ${res.status}`);
  res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' });
  check('wrong token -> 401', res.status === 401);

  // initialize
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN };
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) });
  const init = await j(res);
  check('HTTP initialize ok', res.status === 200 && init.result?.protocolVersion === '2025-06-18');
  check('Mcp-Session-Id header returned', !!res.headers.get('mcp-session-id'));
  check('content-type application/json', (res.headers.get('content-type') ?? '').startsWith('application/json'));

  // GET -> 405, DELETE -> 204
  res = await fetch(base + '/mcp', { method: 'GET', headers: H });
  check('GET /mcp -> 405', res.status === 405);
  res = await fetch(base + '/mcp', { method: 'DELETE', headers: H });
  check('DELETE /mcp -> 204', res.status === 204);

  // notification -> 202
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('notification -> 202', res.status === 202);

  // tools/list
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }) });
  const list = await j(res);
  check('HTTP tools/list ok', list.result?.tools?.length === 17, `got ${list.result?.tools?.length}`);

  // tools/call graceful failure without Chrome
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'example.com' } } }) });
  const nav = await j(res);
  check('browser_navigate fails gracefully (no Chrome here)', nav.result?.isError === true, JSON.stringify(nav).slice(0, 160));

  // batch support
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: JSON.stringify([
    { jsonrpc: '2.0', id: 20, method: 'tools/list' },
    { jsonrpc: '2.0', id: 21, method: 'ping' },
  ]) });
  const batch = await j(res);
  check('batch of 2 -> 2 responses', Array.isArray(batch) && batch.length === 2 && batch[1].result);

  // invalid JSON -> -32700
  res = await fetch(base + '/mcp', { method: 'POST', headers: H, body: 'not-json' });
  const parseErr = await j(res);
  check('bad JSON -> -32700', parseErr.error?.code === -32700);

  // non-/mcp path -> 404
  res = await fetch(base + '/', { headers: H });
  check('GET / -> 404 text hint', res.status === 404);

  // 5. CLI one-shot ---------------------------------------------------------
  console.log('\n[5] CLI one-shot');
  const cli = spawnSync(process.execPath, [serverPath, 'status'], { encoding: 'utf8' });
  check('CLI status exits non-zero with clear error (no Chrome here)',
    cli.status === 1 && /browser/i.test(cli.stderr + cli.stdout), cli.stderr.trim().slice(0, 120));
  const help = spawnSync(process.execPath, [serverPath, '--help'], { encoding: 'utf8' });
  check('--help works', help.status === 0 && /Streamable|stdio|navigate/.test(help.stdout));

  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
