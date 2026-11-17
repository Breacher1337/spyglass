// BrowserSession: one visible browser, a current tab, and serialized actions.
// All tool handlers go through session.run(...) so concurrent MCP calls never
// interleave mouse/keyboard events.

import { CdpConnection, getVersion, listPages, newTab, activateTab, closeTab, pageWsUrl } from './cdp.mjs';
import { ensureBrowser } from './chrome.mjs';
import {
  snapshotScript, readScript, locateScript, pageStateScript, scrollScript,
} from './page-scripts.mjs';

const NAV_TIMEOUT_MS = 30000;

export class BrowserSession {
  constructor(opts = {}) {
    this.browserPort = opts.browserPort ?? 9222;
    this.chromePath = opts.chromePath ?? null;
    this.profileDir = opts.profileDir ?? null;
    this.headless = !!opts.headless;
    this.noLaunch = !!opts.noLaunch;
    this.logger = opts.logger ?? null;

    this.currentTargetId = null; // page target currently driven
    this.conn = null;             // CdpConnection to the current target
    this.launchedByUs = false;
    this.attached = false;

    this._queue = Promise.resolve();
    this._navigationBusy = false;
  }

  log(...args) {
    if (this.logger) this.logger(...args);
  }

  /** Serialize an action against the queue. */
  run(fn) {
    const p = this._queue.then(fn, fn);
    // keep the queue alive even if an action rejects
    this._queue = p.catch(() => {});
    return p;
  }

  /** Make sure a browser with a debugging endpoint exists. */
  async ensureBrowser() {
    const info = await ensureBrowser({
      port: this.browserPort,
      chromePath: this.chromePath,
      profileDir: this.profileDir,
      headless: this.headless,
      noLaunch: this.noLaunch,
      logger: this.log,
    });
    this.launchedByUs = !info.attached;
    this.attached = true;
  }

  /** Ensure the current tab is valid; pick/repair when needed. */
  async ensureTab() {
    await this.ensureBrowser();
    const pages = await listPages(this.browserPort);
    if (this.currentTargetId) {
      const still = pages.find((p) => p.id === this.currentTargetId);
      if (still) return;
    }
    if (pages.length > 0) {
      this.currentTargetId = pages[0].id;
      this.conn = null;
      return;
    }
    const created = await newTab(this.browserPort);
    this.currentTargetId = created.id;
    this.conn = null;
  }

  /** Live CDP connection to the current tab (reconnects when closed). */
  async connection() {
    await this.ensureTab();
    if (!this.conn || !this.conn.isOpen) {
      this.conn = new CdpConnection(pageWsUrl(this.browserPort, this.currentTargetId));
      this.conn.on('disconnected', () => { /* reconnected lazily on next use */ });
      await this.conn.open();
      await this.conn.send('Page.enable').catch(() => {});
      await this.conn.send('Runtime.enable').catch(() => {});
    }
    return this.conn;
  }

  /** Evaluate an expression in the current tab; value must be JSON-serializable. */
  async evaluate(expression, { awaitPromise = false } = {}) {
    const conn = await this.connection();
    const res = await conn.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'page error';
      throw new Error(`Page JavaScript error: ${String(msg).split('\n')[0]}`);
    }
    return res.result?.value;
  }

  async pageState() {
    return this.evaluate(pageStateScript());
  }

  /** Wait for readyState === complete after a navigation. */
  async waitForLoad(extraMs = 400) {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = await this.pageState().catch(() => null);
      if (st && st.readyState === 'complete') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, extraMs));
  }

  /** Normalize and validate a URL. */
  normalizeUrl(input) {
    let url = String(input ?? '').trim();
    if (!url) throw new Error('A URL is required.');
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    const parsed = new URL(url);
    if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) {
      throw new Error(`Scheme "${parsed.protocol}" is not allowed. Use http, https, file or about.`);
    }
    return parsed.href;
  }

  // ---------------------------------------------------------------- actions

  async navigate({ url, newTab: openNewTab = false }) {
    return this.run(async () => {
      const target = this.normalizeUrl(url);
      await this.ensureTab();
      if (openNewTab) {
        const t = await newTab(this.browserPort, target);
        this.currentTargetId = t.id;
        this.conn = null;
      } else {
        const conn = await this.connection();
        this._navigationBusy = true;
        try {
          const res = await conn.send('Page.navigate', { url: target });
          if (res && res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
        } finally {
          this._navigationBusy = false;
        }
      }
      await this.waitForLoad();
      const st = await this.pageState();
      return `Navigated to ${st.url}\nTitle: ${st.title || '(none)'}`;
    });
  }

  async snapshot({ maxElements } = {}) {
    return this.run(async () => {
      await this.ensureTab();
      const st = await this.pageState();
      const tree = await this.evaluate(snapshotScript(maxElements));
      const header = `Page: ${st.url}\nTitle: ${st.title || '(none)'}\n`;
      return header + (tree || '(no interactive elements found)');
    });
  }

  async read({ maxChars } = {}) {
    return this.run(async () => {
      await this.ensureTab();
      const limit = Math.min(Math.max(Number(maxChars) || 12000, 500), 60000);
      const st = await this.pageState();
      let text = (await this.evaluate(readScript())) || '(empty page)';
      let truncated = false;
      if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
      }
      return `Page: ${st.url}\nTitle: ${st.title || '(none)'}\n\n${text}` + (truncated ? `\n\n… [truncated at ${limit} chars; pass a larger maxChars]` : '');
    });
  }

  /** Focus+center an element by ref, then return coordinates. */
  async locateElement(ref) {
    const info = await this.evaluate(locateScript(ref));
    if (!info || info.ok !== true) {
      throw new Error((info && info.error) || `Could not locate ref "${ref}".`);
    }
    return info;
  }

  /** Real mouse press/release at CSS-pixel viewport coordinates. */
  async mouseClick(x, y) {
    const conn = await this.connection();
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }

  async click({ ref }) {
    return this.run(async () => {
      if (!ref) throw new Error('A ref is required, e.g. "e5". Take a browser_snapshot first.');
      await this.ensureTab();
      const { x, y } = await this.locateElement(ref);
      await this.mouseClick(x, y);
      await new Promise((r) => setTimeout(r, 350)); // let handlers run / navigation start
      const st = await this.pageState();
      return `Clicked [ref=${ref}]. Now at ${st.url}`;
    });
  }

  async type({ ref, text, pressEnter = false }) {
    return this.run(async () => {
      if (typeof text !== 'string' || text.length === 0) throw new Error('text is required.');
      await this.ensureTab();
      if (ref) {
        const { x, y } = await this.locateElement(ref);
        await this.mouseClick(x, y);
        await new Promise((r) => setTimeout(r, 150));
      }
      const conn = await this.connection();
      // insertText behaves like real typed input for most fields and triggers
      // input/change events.
      await conn.send('Input.insertText', { text });
      if (pressEnter) {
        await this.pressKeyEvent(conn, { key: 'Enter' });
        await new Promise((r) => setTimeout(r, 400));
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
      const st = await this.pageState();
      return `Typed "${text}"${ref ? ` into [ref=${ref}]` : ' into the focused element'}${pressEnter ? ' and pressed Enter' : ''}. Now at ${st.url}`;
    });
  }

  /** Dispatch one key event with correct virtual key codes. */
  async pressKeyEvent(conn, { key, modifiers = 0 }) {
    const KEYS = {
      Enter: { code: 'Enter', vk: 13 },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      Delete: { code: 'Delete', vk: 46 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
      Home: { code: 'Home', vk: 36 },
      End: { code: 'End', vk: 35 },
      PageUp: { code: 'PageUp', vk: 33 },
      PageDown: { code: 'PageDown', vk: 34 },
      Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
    };
    const spec = KEYS[key] || (key.length === 1 ? { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!spec) throw new Error(`Unsupported key "${key}". Use a single character or one of: ${Object.keys(KEYS).join(', ')}.`);
    const payload = {
      key: spec.key || key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      modifiers,
      ...(spec.text ? { type: 'char', text: spec.text } : {}),
    };
    await conn.send('Input.dispatchKeyEvent', { ...payload, type: 'keyDown' });
    if (spec.text) await conn.send('Input.dispatchKeyEvent', { ...payload, type: 'char' });
    await conn.send('Input.dispatchKeyEvent', { ...payload, type: 'keyUp' });
  }

  async pressKey({ key }) {
    return this.run(async () => {
      if (!key) throw new Error('key is required, e.g. "Enter", "a", "Control+A".');
      await this.ensureTab();
      const conn = await this.connection();
      const parts = String(key).split('+').map((s) => s.trim()).filter(Boolean);
      const MOD = { Control: 2, Ctrl: 2, Shift: 8, Alt: 1, Meta: 4, Cmd: 4, Command: 4 };
      const mods = parts.slice(0, -1);
      const main = parts[parts.length - 1];
      const bitmask = mods.reduce((acc, m) => acc | (MOD[m] ?? 0), 0);
      // press each modifier down
      for (const m of mods) {
        const code = m === 'Ctrl' ? 'Control' : m === 'Cmd' ? 'Meta' : m;
        const vk = code === 'Control' ? 17 : code === 'Shift' ? 16 : code === 'Alt' ? 18 : 91;
        await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', key: code, code: code + 'Left', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 });
      }
      await this.pressKeyEvent(conn, { key: main, modifiers: bitmask });
      for (const m of [...mods].reverse()) {
        const code = m === 'Ctrl' ? 'Control' : m === 'Cmd' ? 'Meta' : m;
        const vk = code === 'Control' ? 17 : code === 'Shift' ? 16 : code === 'Alt' ? 18 : 91;
        await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: code, code: code + 'Left', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 });
      }
      return `Pressed ${key}.`;
    });
  }

  async scroll({ direction = 'down', amount = 800 }) {
    return this.run(async () => {
      if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
        throw new Error('direction must be one of: up, down, top, bottom.');
      }
      await this.ensureTab();
      await this.evaluate(scrollScript(direction, amount));
      const st = await this.pageState();
      const pos = `scroll position: ${st.scrollY}px / ${st.scrollHeight}px`;
      return `Scrolled ${direction}${direction === 'up' || direction === 'down' ? ` by ${Math.abs(amount)}px` : ''}; ${pos}`;
    });
  }

  async goHistory(delta) {
    return this.run(async () => {
      await this.ensureTab();
      const conn = await this.connection();
      const hist = await conn.send('Page.getNavigationHistory', {});
      const target = hist.currentIndex + delta;
      if (target < 0 || target >= hist.entries.length) {
        return delta < 0 ? 'No back history to go to.' : 'No forward history to go to.';
      }
      await conn.send('Page.navigateToHistoryEntry', { entryId: hist.entries[target].id });
      await this.waitForLoad();
      const st = await this.pageState();
      return `Now at ${st.url}`;
    });
  }

  async screenshot({ fullPage = false, format = 'png', quality = 80 } = {}) {
    return this.run(async () => {
      await this.ensureTab();
      const conn = await this.connection();
      if (!['png', 'jpeg'].includes(format)) throw new Error('format must be "png" or "jpeg".');
      const params = {
        format,
        ...(format === 'jpeg' ? { quality: Math.min(Math.max(Number(quality) || 80, 0), 100) } : {}),
        ...(fullPage ? { captureBeyondViewport: true } : {}),
      };
      const res = await conn.send('Page.captureScreenshot', params);
      return { mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', data: res.data };
    });
  }

  async tabList() {
    return this.run(async () => {
      await this.ensureBrowser();
      const pages = await listPages(this.browserPort);
      const lines = pages.map((p, i) => {
        const mark = p.id === this.currentTargetId ? ' (current)' : '';
        return `${i}: ${p.title || '(no title)'}${mark}\n   ${p.url}`;
      });
      return lines.length ? lines.join('\n') : 'No open tabs.';
    });
  }

  async tabNew({ url } = {}) {
    return this.run(async () => {
      const target = url ? this.normalizeUrl(url) : null;
      await this.ensureTab();
      const t = await newTab(this.browserPort, target);
      this.currentTargetId = t.id;
      this.conn = null;
      if (!target) await this.waitForLoad();
      const st = await this.pageState();
      return `Opened a new tab, now current: ${st.url}`;
    });
  }

  async tabSelect({ index }) {
    return this.run(async () => {
      await this.ensureBrowser();
      const pages = await listPages(this.browserPort);
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
        throw new Error(`index must be between 0 and ${pages.length - 1}. Use browser_tab_list to see tabs.`);
      }
      const page = pages[i];
      this.currentTargetId = page.id;
      this.conn = null;
      await activateTab(this.browserPort, page.id);
      const st = await this.pageState();
      return `Switched to tab ${i}: ${st.url}`;
    });
  }

  async tabClose({ index } = {}) {
    return this.run(async () => {
      await this.ensureBrowser();
      const pages = await listPages(this.browserPort);
      let target;
      if (index === undefined || index === null) {
        await this.ensureTab();
        target = pages.find((p) => p.id === this.currentTargetId);
        if (!target) throw new Error('No current tab to close.');
      } else {
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
          throw new Error(`index must be between 0 and ${pages.length - 1}.`);
        }
        target = pages[i];
      }
      await closeTab(this.browserPort, target.id);
      this.currentTargetId = null;
      this.conn = null;
      // keep a valid current tab afterwards
      const remaining = await listPages(this.browserPort).catch(() => []);
      if (remaining.length) {
        this.currentTargetId = remaining[0].id;
      }
      return `Closed tab: ${target.title || target.url}`;
    });
  }

  async status() {
    return this.run(async () => {
      await this.ensureBrowser();
      const version = await getVersion(this.browserPort);
      await this.ensureTab();
      const st = await this.pageState();
      return [
        'Browser: ' + (version.Browser || 'Chromium'),
        `Debugging endpoint: 127.0.0.1:${this.browserPort} (loopback only)`,
        `Mode: ${this.headless ? 'headless' : 'non-headless (visible window)'}; ${this.launchedByUs ? 'launched by spyglass' : 'attached to an existing browser'}`,
        `Current tab: ${st.url}`,
        `Title: ${st.title || '(none)'}`,
      ].join('\n');
    });
  }

  async evaluateExpression({ expression }) {
    return this.run(async () => {
      if (typeof expression !== 'string' || !expression.trim()) throw new Error('expression is required.');
      await this.ensureTab();
      const value = await this.evaluate(`(async () => { ${expression.includes('return') || expression.includes('await') ? expression : 'return (' + expression + ')'} })()`, { awaitPromise: true });
      if (value === undefined) return '(undefined)';
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    });
  }

  async wait({ ms }) {
    const t = Math.min(Math.max(Number(ms) || 1000, 100), 10000);
    await new Promise((r) => setTimeout(r, t));
    return `Waited ${t}ms.`;
  }
}
