// MCP protocol core (JSON-RPC 2.0). Shared by the HTTP and stdio transports.
// Implements: initialize, notifications/initialized, ping, tools/list, tools/call.

import { randomUUID } from 'node:crypto';
import { TOOL_NAMES, toolsList, callTool } from './tools.mjs';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = { name: 'spyglass', version: '0.1.0' };

/**
 * Handle one JSON-RPC message object. Returns a response object, or null for
 * notifications (no response expected).
 */
export async function handleMessage(session, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return jsonRpcError(msg && msg.id, -32600, 'Invalid Request');
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Drive the user\'s visible (non-headless) Chromium browser. Typical flow: ' +
          'browser_navigate -> browser_snapshot -> browser_click/browser_type with refs from the snapshot -> ' +
          'browser_read or browser_screenshot to inspect results. The user can watch the browser window live.',
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: toolsList() };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string') {
      return jsonRpcError(id, -32602, `Invalid arguments: tool name required. Known tools: ${TOOL_NAMES.join(', ')}`);
    }
    if (!TOOL_NAMES.includes(name)) {
      return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const result = await callTool(session, name, args);
    return { jsonrpc: '2.0', id, result };
  }

  if (method === 'resources/list' || method === 'prompts/list') {
    // Not supported; return empty so strict clients stay happy.
    return { jsonrpc: '2.0', id, result: method === 'resources/list' ? { resources: [] } : { prompts: [] } };
  }

  if (id === undefined || id === null) return null; // unknown notification
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle a batch (array) of messages. Returns array or null if all were notifications. */
export async function handleBatch(session, batch) {
  if (!Array.isArray(batch)) return handleMessage(session, batch);
  const responses = [];
  for (const item of batch) {
    const r = await handleMessage(session, item);
    if (r) responses.push(r);
  }
  return responses.length ? responses : null;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function newSessionId() {
  return randomUUID();
}
