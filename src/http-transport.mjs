// Streamable HTTP transport (MCP spec 2025-06-18): POST /mcp with JSON
// request -> JSON response. Bearer-token auth protects it. Binds 127.0.0.1
// by default; pair with an HTTPS tunnel (e.g. cloudflared) to reach it from
// Vibe web without ever opening a public port yourself.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { handleBatch, newSessionId } from './mcp.mjs';

const MAX_BODY = 5 * 1024 * 1024; // 5 MB; screenshots flow the other way

function tokensMatch(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * @param {import('./session.mjs').BrowserSession} session
 */
export function startHttpServer(session, opts = {}) {
  const port = opts.port ?? 8765;
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? null; // null = no auth (only with --no-auth)

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'OPTIONS') {
        setCors(res);
        res.writeHead(204);
        return res.end();
      }

      // Every path other than /mcp: tiny human-friendly landing page.
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('spyglass MCP server. MCP endpoint: POST /mcp');
      }

      // --- auth (all methods on /mcp) ---
      if (token) {
        const auth = req.headers.authorization || '';
        const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
        if (!presented || !tokensMatch(presented, token)) {
          res.writeHead(401, {
            'WWW-Authenticate': 'Bearer realm="spyglass"',
            'Content-Type': 'application/json',
          });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid bearer token' } }));
        }
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        // No server-initiated SSE stream is offered; MCP allows 405 here.
        res.writeHead(405, { Allow: 'POST, DELETE' });
        return res.end();
      }

      if (req.method === 'DELETE') {
        // Session teardown: accept and confirm.
        res.writeHead(204);
        return res.end();
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST, DELETE' });
        return res.end();
      }

      // --- POST: parse JSON-RPC ---
      const body = await readBody(req);
      let msg;
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }

      const isInitialize = !Array.isArray(msg) && msg.method === 'initialize';
      const response = await handleBatch(session, msg);
      if (!response) {
        // Pure notifications: 202 Accepted, no body.
        res.writeHead(202);
        return res.end();
      }
      setCors(res);
      const headers = { 'Content-Type': 'application/json' };
      if (isInitialize) headers['Mcp-Session-Id'] = newSessionId();
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
    } catch (err) {
      session.log(`HTTP handler error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      session.log(`MCP (Streamable HTTP) listening on http://${host}:${port}/mcp`);
      resolve(server);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function setCors(res) {
  // Useful for MCP Inspector (browser-based); auth still gates /mcp.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}
