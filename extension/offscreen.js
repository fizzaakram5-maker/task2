// Runs in an offscreen document so the WebSocket stays alive in MV3.
// For simplicity, edit WS_URL if you want a different endpoint.

const WS_URL = 'ws://localhost:8765';
let ws = null;
let reconnectTimer = null;

function log(...args) {
  console.log('[offscreen]', ...args);
}

function connect() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      log('WebSocket connected to', WS_URL);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws.send(JSON.stringify({ id: crypto.randomUUID(), ok: true, hello: 'ws-dom-controller-online' }));
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        ws.send(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON received' }));
        return;
      }

      const id = msg.id || crypto.randomUUID();
      const cmd = msg.cmd;
      const payload = msg;

      if (cmd === 'ping') {
        ws.send(JSON.stringify({ id, ok: true, result: 'pong' }));
        return;
      }

      chrome.runtime.sendMessage({ type: 'cmd', id, cmd, payload }, (response) => {
        if (chrome.runtime.lastError) {
          ws.send(JSON.stringify({ id, ok: false, error: chrome.runtime.lastError.message }));
        } else {
          ws.send(JSON.stringify(response));
        }
      });
    };

    ws.onclose = () => {
      log('WebSocket closed; reconnecting in 2s…');
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = (e) => {
      log('WebSocket error:', e?.message || e);
      try { ws.close(); } catch {}
    };
  } catch (e) {
    log('Connect error:', e?.message || e);
    reconnectTimer = setTimeout(connect, 2000);
  }
}

connect();
