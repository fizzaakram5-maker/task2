// MV3 service worker: sets up (or ensures) an offscreen document to keep a persistent WebSocket.
// Routes commands from the offscreen doc to the correct tab and injects DOM actions.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const SESSION_KEY = 'ws_dom_ctrl.lastTabId'; // stored in chrome.storage.session

// Ensure offscreen document exists
async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Maintain a persistent WebSocket to receive automation commands.'
    });
    console.log('[background] Offscreen document created.');
  } catch (err) {
    console.log('[background] Offscreen doc check:', err?.message || err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});

// Utility: get or set the last controlled tab id (session-scoped)
async function getStoredTabId() {
  const { [SESSION_KEY]: id } = await chrome.storage.session.get(SESSION_KEY);
  return id ?? null;
}
async function setStoredTabId(tabId) {
  await chrome.storage.session.set({ [SESSION_KEY]: tabId });
}

// Utility: pick a target tab
async function resolveTargetTabId(preferredId) {
  if (Number.isInteger(preferredId)) return preferredId;

  const stored = await getStoredTabId();
  if (Number.isInteger(stored)) {
    try {
      const tab = await chrome.tabs.get(stored);
      if (tab && !tab.discarded) return stored;
    } catch { /* tab might be gone */ }
  }

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id) {
    await setStoredTabId(active.id);
    return active.id;
  }

  // As a fallback, create a new blank tab.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  await setStoredTabId(tab.id);
  return tab.id;
}

// Wait for a tab to finish loading (status === 'complete')
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function onUpdated(id, info, tab) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    const t = setInterval(async () => {
      if (Date.now() - start > timeoutMs) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearInterval(t);
        reject(new Error('Timeout waiting for tab to load'));
      } else {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearInterval(t);
            resolve(tab);
          }
        } catch {
          // ignore
        }
      }
    }, 250);
  });
}

// Inject a function into the page
async function runInPage(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result;
}

// Command handlers
const handlers = {
  // { url?: string, reuse?: boolean }
  async nav(payload) {
    const { url, reuse = true } = payload || {};
    let tabId;

    if (reuse) {
      const maybe = await resolveTargetTabId();
      tabId = maybe;
      await chrome.tabs.update(tabId, { url: url || 'about:blank', active: true });
    } else {
      const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
      tabId = tab.id;
    }
    await setStoredTabId(tabId);
    await waitForTabLoad(tabId);

    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url || url || null, ok: true };
  },

  // { selector: string, index?: number, timeout_ms?: number }
  async click(payload, tabId) {
    return await runInPage(tabId, async ({ selector, index = 0, timeout_ms = 2000 }) => {
      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
      async function find(sel, idx, timeout) {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const list = document.querySelectorAll(sel);
          if (list.length > idx) return list[idx];
          await sleep(100);
        }
        return null;
      }
      const el = await find(selector, index, timeout_ms);
      if (!el) throw new Error(`Element not found: ${selector}[${index}]`);
      el.scrollIntoView({ block: 'center', inline: 'center' });

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: centerX, clientY: centerY }));
      });

      return { clicked: true };
    }, [payload]);
  },

  // { selector: string, text: string, clear?: boolean, enter?: boolean, index?: number, timeout_ms?: number }
  async type(payload, tabId) {
    return await runInPage(tabId, async ({ selector, text, clear = true, enter = false, index = 0, timeout_ms = 2000 }) => {
      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
      async function find(sel, idx, timeout) {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const list = document.querySelectorAll(sel);
          if (list.length > idx) return list[idx];
          await sleep(100);
        }
        return null;
      }
      const el = await find(selector, index, timeout_ms);
      if (!el) throw new Error(`Element not found: ${selector}[${index}]`);

      el.focus();
      if (clear && 'value' in el) el.value = '';

      for (const ch of text) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        if ('value' in el) el.value += ch;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await sleep(5);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));

      if (enter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }

      return { typed: true, length: text.length };
    }, [payload]);
  },

  // { selector: string, value: string, attr?: string, index?: number }
  async set(payload, tabId) {
    return await runInPage(tabId, ({ selector, value, attr, index = 0 }) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) throw new Error(`Element not found: ${selector}[${index}]`);
      if (attr) {
        el.setAttribute(attr, value);
      } else if ('value' in el) {
        el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = value;
      }
      return { set: true };
    }, [payload]);
  },

  // { selector: string, index?: number }
  async exists(payload, tabId) {
    return await runInPage(tabId, ({ selector, index = 0 }) => {
      const ok = document.querySelectorAll(selector).length > index;
      return { exists: ok };
    }, [payload]);
  },

  // { selector?: string, max_len?: number }
  async get_html(payload, tabId) {
    return await runInPage(tabId, ({ selector = null, max_len = 500000 }) => {
      const html = selector
        ? (document.querySelector(selector)?.outerHTML ?? '')
        : document.documentElement.outerHTML;
      const truncated = html.length > max_len;
      const out = truncated ? html.slice(0, max_len) : html;
      return { html: out, truncated, length: html.length };
    }, [payload]);
  },

  // { js: string }
  async exec_js(payload, tabId) {
    return await runInPage(tabId, ({ js }) => {
      try {
        const fn = new Function('"use strict"; return (' + js + ')');
        const result = fn();
        try {
          return { result: JSON.parse(JSON.stringify(result)) };
        } catch {
          return { result: String(result) };
        }
      } catch (e) {
        throw new Error('exec_js error: ' + (e?.message || String(e)));
      }
    }, [payload]);
  },
    // NEW: XPath lookup & actions
  // { expr: string, action?: 'list'|'click'|'exists'|'count'|'getAttribute'|'getHTML'|'getText'|'setValue'|'type',
  //   index?: number, timeout_ms?: number, attr?: string, text?: string, clear?: boolean, enter?: boolean,
  //   max?: number, includeHTML?: boolean, max_len?: number }
  async xpath(payload, tabId) {
    return await runInPage(
      tabId,
      async (p) => {
        const {
          expr,
          action = 'list',
          index = 0,
          timeout_ms = 2000,
          attr,
          text = '',
          clear = true,
          enter = false,
          max = 10,
          includeHTML = false,
          max_len = 500000
        } = p || {};

        if (!expr || typeof expr !== 'string') {
          throw new Error('xpath: missing "expr"');
        }

        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        function evalSnapshot(xp) {
          try {
            return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          } catch (e) {
            throw new Error('Invalid XPath: ' + e.message);
          }
        }

        async function waitForIndex(xp, idx, timeout) {
          const start = performance.now();
          while (performance.now() - start < timeout) {
            const snap = evalSnapshot(xp);
            if (snap.snapshotLength > idx) return snap;
            await sleep(100);
          }
          return evalSnapshot(xp);
        }

        function summarizeNode(node) {
          try {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              const rect = el.getBoundingClientRect();
              const html = includeHTML ? (el.outerHTML || '') : undefined;
              const truncated = includeHTML && html.length > max_len;
              return {
                nodeType: 'element',
                tag: el.tagName,
                id: el.id || null,
                classes: el.className || null,
                name: el.getAttribute('name') || null,
                value: ('value' in el) ? el.value : null,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                html: includeHTML ? (truncated ? html.slice(0, max_len) : html) : undefined,
                html_truncated: includeHTML ? truncated : undefined
              };
            }
            if (node.nodeType === Node.TEXT_NODE) {
              const t = node.nodeValue || '';
              return { nodeType: 'text', text: t.slice(0, 200) };
            }
            return { nodeType: 'other', nodeName: node.nodeName };
          } catch {
            return { nodeType: 'unknown' };
          }
        }

        // Resolve snapshot (wait if needed for actions that target a specific index)
        const needsIndex = ['click', 'getAttribute', 'getHTML', 'getText', 'setValue', 'type'].includes(action);
        const snap = needsIndex ? await waitForIndex(expr, index, timeout_ms) : evalSnapshot(expr);
        const count = snap.snapshotLength;

        // Helpers
        function nth(idx) {
          if (idx >= count) return null;
          return snap.snapshotItem(idx);
        }
        function ensureElement(node) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) throw new Error('Target is not an element node');
          return node;
        }

        switch (action) {
          case 'list': {
            const out = [];
            const n = Math.min(count, Math.max(0, max));
            for (let i = 0; i < n; i++) out.push(summarizeNode(snap.snapshotItem(i)));
            return { count, nodes: out };
          }
          case 'exists':
            return { exists: count > 0 };
          case 'count':
            return { count };
          case 'click': {
            const node = ensureElement(nth(index));
            node.scrollIntoView({ block: 'center', inline: 'center' });
            const r = node.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(type => {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy }));
            });
            return { clicked: true };
          }
          case 'getAttribute': {
            if (!attr) throw new Error('getAttribute requires "attr"');
            const node = ensureElement(nth(index));
            return { value: node.getAttribute(attr) };
          }
          case 'getHTML': {
            const node = ensureElement(nth(index));
            const html = node.outerHTML || {};
            const truncated = html.length > max_len;
            return { html: truncated ? html.slice(0, max_len) : html, truncated, length: html.length };
          }
          case 'getText': {
            const node = nth(index);
            if (!node) throw new Error('No node at index');
            const txt = node.textContent || '';
            return { text: txt, length: txt.length };
          }
          case 'setValue': {
            const node = nth(index);
            if (!node) throw new Error('No node at index');
            if (node.nodeType === Node.ELEMENT_NODE && 'value' in node) {
              node.value = text;
              node.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
              return { set: true };
            } else {
              node.textContent = text;
              return { set: true };
            }
          }
          case 'type': {
            const node = ensureElement(nth(index));
            node.focus();
            if (clear && 'value' in node) node.value = '';
            for (const ch of text) {
              node.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
              if ('value' in node) node.value += ch;
              node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
              node.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
              node.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
              await sleep(5);
            }
            node.dispatchEvent(new Event('change', { bubbles: true }));
            if (enter) {
              node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            }
            return { typed: true, length: text.length };
          }
          default:
            throw new Error('Unknown xpath action: ' + action);
        }
      },
      [payload]
    );
  }
};

// Message bridge with offscreen document
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'cmd') return; // ignore others
  (async () => {
    const { id, cmd, payload } = msg;
    try {
      if (!handlers[cmd]) throw new Error(`Unknown cmd: ${cmd}`);
      let tabId = await resolveTargetTabId(payload?.tabId);
      if (cmd === 'nav') {
        const res = await handlers.nav(payload);
        tabId = res.tabId;
        sendResponse({ id, ok: true, result: res });
        return;
      }
      const res = await handlers[cmd](payload, tabId);
      sendResponse({ id, ok: true, result: { tabId, ...res } });
    } catch (e) {
      sendResponse({ id: msg.id, ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async response
});
