// MCP tool definitions and dispatch. readOnlyHint lets Vibe classify
// read vs write functions for its per-function "Always allow" permissions.

import { BrowserSession } from './session.mjs';

const sc = (type, description, extra = {}) => ({ type, description, ...extra });
const obj = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const DEFS = {
  browser_status: {
    description: 'Report the browser state: which browser, current tab URL and title, mode (non-headless visible window), and how many tabs are open. Safe and cheap; call this first if unsure whether the browser is connected.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true },
    run: (s) => s.status(),
  },
  browser_navigate: {
    description: 'Navigate the current tab to a URL (http/https/file). Adds "https://" when no scheme is given, waits for the page to load, and returns the final URL and title. Set newTab=true to open the URL in a new tab instead.',
    inputSchema: obj({ url: sc('string', 'URL to open, e.g. "example.com" or "https://example.com/path".'), newTab: sc('boolean', 'Open in a new tab (default false).') }, ['url']),
    annotations: {},
    run: (s, a) => s.navigate(a),
  },
  browser_snapshot: {
    description: 'Capture a compact tree of the current page: title, URL, headings, and every interactive element (links, buttons, inputs, selects) each with a stable ref like [ref=e12]. Use the refs with browser_click / browser_type. Call this whenever you need to know what is on the page or what to act on. Does not include page screenshots.',
    inputSchema: obj({ maxElements: sc('number', 'Maximum interactive elements to list (default 400).') }),
    annotations: { readOnlyHint: true },
    run: (s, a) => s.snapshot(a),
  },
  browser_read: {
    description: 'Read the readable text content of the current page (prefers <main>/<article> over whole body). Returns URL, title and the text. Use this for content; use browser_snapshot for clickable refs.',
    inputSchema: obj({ maxChars: sc('number', 'Maximum characters to return (default 12000, max 60000).') }),
    annotations: { readOnlyHint: true },
    run: (s, a) => s.read(a),
  },
  browser_click: {
    description: 'Click an element identified by its ref from a recent browser_snapshot (e.g. "e12"). Scrolls the element into view first, then dispatches a real mouse press at its center.',
    inputSchema: obj({ ref: sc('string', 'The ref from browser_snapshot, e.g. "e12".') }, ['ref']),
    annotations: {},
    run: (s, a) => s.click(a),
  },
  browser_type: {
    description: 'Type text into an input element. Provide ref (from browser_snapshot) to focus that field first, or omit ref to type into whatever is currently focused. Set pressEnter=true to send Enter afterwards (e.g. submit a search).',
    inputSchema: obj({ ref: sc('string', 'Target element ref, e.g. "e5". Optional: omit to type into the focused element.'), text: sc('string', 'Text to type.'), pressEnter: sc('boolean', 'Press Enter after typing (default false).') }, ['text']),
    annotations: {},
    run: (s, a) => s.type(a),
  },
  browser_press_key: {
    description: 'Press a key or a simple combo, e.g. "Enter", "Tab", "Escape", "ArrowDown", "a", "Control+A", "Shift+Tab". Acts on the focused element.',
    inputSchema: obj({ key: sc('string', 'Key name or combo, e.g. "Enter" or "Control+A".') }, ['key']),
    annotations: {},
    run: (s, a) => s.pressKey(a),
  },
  browser_scroll: {
    description: 'Scroll the current page: direction "down"/"up" by amount pixels (default 800), or "top"/"bottom".',
    inputSchema: obj({ direction: sc('string', 'One of: down, up, top, bottom.', { enum: ['down', 'up', 'top', 'bottom'] }), amount: sc('number', 'Pixels to scroll for up/down (default 800).') }),
    annotations: {},
    run: (s, a) => s.scroll(a),
  },
  browser_back: {
    description: 'Go back one step in the current tab history.',
    inputSchema: obj(),
    annotations: {},
    run: (s) => s.goHistory(-1),
  },
  browser_forward: {
    description: 'Go forward one step in the current tab history.',
    inputSchema: obj(),
    annotations: {},
    run: (s) => s.goHistory(1),
  },
  browser_screenshot: {
    description: 'Take a screenshot of the current tab and return it as an image. fullPage=true captures the whole scrollable page (large; prefer jpeg then). format: "png" (default) or "jpeg".',
    inputSchema: obj({ fullPage: sc('boolean', 'Capture the entire scrollable page (default false: viewport only).'), format: sc('string', 'Image format: "png" or "jpeg".', { enum: ['png', 'jpeg'] }), quality: sc('number', 'JPEG quality 0-100 (default 80).') }),
    annotations: { readOnlyHint: true },
    run: (s, a) => s.screenshot(a),
  },
  browser_tab_list: {
    description: 'List all open tabs with index, title and URL. The current tab is marked.',
    inputSchema: obj(),
    annotations: { readOnlyHint: true },
    run: (s) => s.tabList(),
  },
  browser_tab_new: {
    description: 'Open a new tab, optionally navigating straight to a URL, and make it the current tab.',
    inputSchema: obj({ url: sc('string', 'Optional URL to open in the new tab.') }),
    annotations: {},
    run: (s, a) => s.tabNew(a),
  },
  browser_tab_select: {
    description: 'Switch the current tab by its index (from browser_tab_list).',
    inputSchema: obj({ index: sc('number', 'Tab index from browser_tab_list, starting at 0.') }, ['index']),
    annotations: {},
    run: (s, a) => s.tabSelect(a),
  },
  browser_tab_close: {
    description: 'Close a tab by index, or the current tab when no index is given.',
    inputSchema: obj({ index: sc('number', 'Tab index to close; omit to close the current tab.') }),
    annotations: {},
    run: (s, a) => s.tabClose(a),
  },
  browser_wait: {
    description: 'Wait for a number of milliseconds (100-10000) before the next step, e.g. for animations, overlays or lazy loading.',
    inputSchema: obj({ ms: sc('number', 'Milliseconds to wait (default 1000, max 10000).') }),
    annotations: { readOnlyHint: true },
    run: (s, a) => s.wait(a),
  },
  browser_evaluate: {
    description: 'Run a JavaScript expression in the current page and return its JSON result. Powerful escape hatch for anything the dedicated tools cannot do; may be a statement with return/await.',
    inputSchema: obj({ expression: sc('string', "JavaScript expression, e.g. `document.querySelectorAll('a').length` or `return await fetch('/').then(r => r.status)`.") }, ['expression']),
    annotations: {},
    run: (s, a) => s.evaluateExpression(a),
  },
};

export const TOOL_NAMES = Object.keys(DEFS);

/** Tools/list payload. */
export function toolsList() {
  return {
    tools: Object.entries(DEFS).map(([name, d]) => ({
      name,
      description: d.description,
      inputSchema: d.inputSchema,
      annotations: d.annotations,
    })),
  };
}

/**
 * Execute a tools/call. Never throws: failures become isError results so the
 * model sees the message and can recover.
 */
export async function callTool(session, name, args = {}) {
  const def = DEFS[name];
  if (!def) {
    return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  }
  try {
    const result = await def.run(session, args ?? {});
    if (result && typeof result === 'object' && result.mimeType && result.data) {
      return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] };
    }
    return { content: [{ type: 'text', text: String(result) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

export { BrowserSession };
