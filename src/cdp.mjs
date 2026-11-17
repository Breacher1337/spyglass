// Minimal Chrome DevTools Protocol client. Zero dependencies: uses the
// Node.js built-in WebSocket (Node >= 22) and fetch.

import { EventEmitter } from 'node:events';

let nextId = 1;

/** Wrap a page target WebSocket with promise-based command sending. */
export class CdpConnection extends EventEmitter {
  /**
   * @param {string} wsUrl WebSocket debugger URL of a page target
   */
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.ws = null;
    this.pending = new Map(); // id -> {resolve, reject}
    this.closing = false;
  }

  get isOpen() {
    return this.ws && this.ws.readyState === 1; // OPEN
  }

  /** Open the WebSocket if needed. Resolves when ready. */
  async open(timeoutMs = 10000) {
    if (this.isOpen) return this;
    if (this.ws && this.ws.readyState === 0) {
      // still connecting; fall through and wait on the same socket
    } else {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('message', (ev) => this._onMessage(ev));
      this.ws.addEventListener('close', () => this._onClose());
      this.ws.addEventListener('error', () => {}); // surfaced via open timeout
    }
    await this._waitForOpen(timeoutMs);
    return this;
  }

  _waitForOpen(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (this.isOpen) return resolve();
        if (this.closing) return reject(new Error('CDP connection closed'));
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`Timed out connecting to ${this.wsUrl}. Is the browser still running?`));
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP ${msg.error.message || 'error'}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      this.emit('event', msg.method, msg.params ?? {});
    }
  }

  _onClose() {
    const err = new Error('CDP connection closed');
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    if (!this.closing) this.emit('disconnected');
  }

  /**
   * Send a CDP command and await its result.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, timeoutMs = 30000) {
    const id = nextId++;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error('CDP connection is not open'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Fire-and-forget notification (no id). */
  notify(method, params = {}) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ method, params }));
    }
  }

  async close() {
    this.closing = true;
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null;
  }
}

/** Base URL helper for the HTTP debugging endpoints. */
export const httpBase = (port) => `http://127.0.0.1:${port}`;

/** GET /json/version. Throws if nothing is listening. */
export async function getVersion(port, timeoutMs = 1500) {
  const res = await fetch(`${httpBase(port)}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Browser debugging endpoint returned HTTP ${res.status}`);
  return res.json();
}

/** GET /json/list, filtered to page targets. */
export async function listPages(port) {
  const res = await fetch(`${httpBase(port)}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`Browser debugging endpoint returned HTTP ${res.status}`);
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page');
}

/** Create a new tab (PUT on modern Chrome, GET fallback for older builds). */
export async function newTab(port, url) {
  const target = `${httpBase(port)}/json/new${url ? `?${encodeURIComponent(url)}` : ''}`;
  let res = await fetch(target, { method: 'PUT' }).catch(() => null);
  if (!res || !res.ok) res = await fetch(target).catch(() => null);
  if (!res || !res.ok) throw new Error('Could not create a new tab via the debugging endpoint');
  return res.json();
}

/** Bring a tab to the foreground. */
export async function activateTab(port, targetId) {
  await fetch(`${httpBase(port)}/json/activate/${targetId}`).catch(() => null);
}

/** Close a tab. */
export async function closeTab(port, targetId) {
  const res = await fetch(`${httpBase(port)}/json/close/${targetId}`).catch(() => null);
  if (!res || !res.ok) throw new Error('Could not close the tab via the debugging endpoint');
}

/** WebSocket debugger URL for a page target. */
export function pageWsUrl(port, targetId) {
  return `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
}
