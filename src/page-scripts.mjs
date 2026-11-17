// JavaScript snippets injected into the page via Runtime.evaluate.
// Each function returns an expression string; the page returns JSON
// (returnByValue: true) so nothing complex crosses the wire.
//
// Element references work through an in-page registry: browser_snapshot
// assigns each interactive element a ref ("e1", "e2", ...). Actions look
// the element up live at click time, so coordinates are always fresh.

/** Build the interactive-element snapshot. Returns a text tree string. */
export function snapshotScript(maxElements = 400) {
  return `(() => {
  const registry = (window.__sglRegistry || (window.__sglRegistry = new Map()));
  const MAX = ${Math.max(1, Math.floor(maxElements))};
  const lines = [];
  let n = 0;

  const clip = (s, len) => {
    s = (s || '').replace(/\\s+/g, ' ').trim();
    return s.length > len ? s.slice(0, len) + '…' : s;
  };

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);
  const ROLES = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option', LABEL: 'label' };

  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return ROLES[t] || t.toLowerCase();
  };

  const labelOf = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const txt = labelledby.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => n.innerText || n.textContent || '').join(' ').trim();
      if (txt) return txt;
    }
    const label = el.getAttribute('aria-label');
    if (label) return label;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const id = el.id;
      if (id) {
        const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return lab.innerText || lab.textContent || '';
      }
      const ph = el.getAttribute('placeholder');
      if (ph) return ph;
      if (el.type !== 'password' && el.type !== 'hidden' && el.value) return el.value;
    }
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    return el.innerText || el.textContent || el.title || '';
  };

  const visible = (el) => {
    if (!el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('input,button,a[aria-hidden="false"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const walk = (el) => {
    if (n >= MAX) return;
    if (el.matches('script, style, noscript, template, svg, link, meta, iframe')) return;

    if (visible(el)) {
      const t = el.tagName;
      const interactive = INTERACTIVE.has(t)
        || el.getAttribute('role')
        || el.getAttribute('onclick') !== null
        || el.getAttribute('tabindex') !== null
        || el.getAttribute('contenteditable') === 'true';

      if (interactive) {
        n += 1;
        const ref = 'e' + n;
        registry.set(ref, el);
        const name = clip(labelOf(el), 100);
        let line = '- ' + roleOf(el) + (name ? ' "' + name + '"' : '') + ' [ref=' + ref + ']';
        if (t === 'A') {
          const href = el.getAttribute('href');
          if (href) line += ' -> ' + clip(href, 60);
        }
        if (t === 'INPUT') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'checkbox' || type === 'radio') line += el.checked ? ' [checked]' : ' [unchecked]';
          if (type === 'hidden') line += ' [hidden]';
        }
        if (t === 'SELECT') {
          const sel = el.selectedOptions && el.selectedOptions[0];
          if (sel) line += ' (selected: ' + clip(sel.label || sel.value, 60) + ')';
        }
        lines.push(line);
      } else if (t === 'IMG') {
        lines.push('- img "' + clip(el.getAttribute('alt') || '', 80) + '"');
      } else if (/^H[1-6]$/.test(t)) {
        const txt = clip(el.innerText || '', 100);
        if (txt) lines.push('- heading: ' + txt);
      }
    }
    for (const child of el.children) walk(child);
  };

  walk(document.body);
  if (n >= MAX) lines.push('… truncated at ' + MAX + ' interactive elements; use browser_read or narrow the view');
  return lines.join('\\n');
})()`;
}

/** Extract readable page text. */
export function readScript() {
  return `(() => {
  const root = document.querySelector('main')
    || document.querySelector('[role="main"]')
    || document.querySelector('article')
    || document.body;
  let text = root.innerText || root.textContent || '';
  text = text.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+$/gm, '').trim();
  return text;
})()`;
}

/** Look up a snapshot ref, scroll it into view, and return its center. */
export function locateScript(ref) {
  return `(() => {
  const el = window.__sglRegistry && window.__sglRegistry.get(${JSON.stringify(ref)});
  if (!el) return { ok: false, error: 'Unknown ref "' + ${JSON.stringify(ref)} + '". Take a new browser_snapshot first.' };
  if (!el.isConnected) return { ok: false, error: 'That element is no longer part of the page (the page probably changed). Take a new browser_snapshot.' };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, error: 'Element has no visible area.' };
  return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
}

/** Page state: url, title, readyState, scroll position. */
export function pageStateScript() {
  return `(() => ({
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }))()`;
}

/** Scroll helper: by pixels, or to top/bottom. */
export function scrollScript(direction, amount) {
  if (direction === 'top') return `window.scrollTo(0, 0), 'ok'`;
  if (direction === 'bottom') return `window.scrollTo(0, document.documentElement.scrollHeight), 'ok'`;
  const dy = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
  return `window.scrollBy(0, ${Math.floor(dy)}), 'ok'`;
}
