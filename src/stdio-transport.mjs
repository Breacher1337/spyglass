// stdio transport: newline-delimited JSON-RPC on stdin/stdout, logs on stderr.
// This is the transport the Vibe CLI uses via `vibe mcp add --transport stdio`.

import { createInterface } from 'node:readline';
import { handleBatch } from './mcp.mjs';

export function startStdioServer(session) {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n');
      return;
    }
    try {
      const response = await handleBatch(session, msg);
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) {
      session.log(`stdio handler error: ${err.message}`);
    }
  });

  rl.on('close', () => {
    session.log('stdin closed; shutting down.');
    process.exit(0);
  });

  session.log('spyglass MCP server running on stdio.');
  return rl;
}
