
# WS DOM Controller

A Chrome (MV3) extension that opens a persistent WebSocket and performs DOM actions on the current page: **nav**, **click**, **type**, **set**, **exists**, **get_html**, **exec_js**. Includes a tiny Node WebSocket server to drive it.

## Folder layout
```
ws-dom-controller/
├─ extension/
│  ├─ manifest.json
│  ├─ background.js
│  ├─ offscreen.html
│  └─ offscreen.js
└─ server/
   ├─ package.json
   └─ server.js
```

## Super-simple steps
1. Open a terminal and run the server:
   ```bash
   cd server
   npm install
   npm start
   ```
   You should see: `Listening on ws://localhost:8765`

2. Load the extension:
   - Open Chrome and go to `chrome://extensions`
   - Turn on **Developer mode**
   - Click **Load unpacked** and choose the `extension` folder

3. Watch it work:
   - The server prints messages it sends, and replies it receives
   - A small demo runs: visit example.org, check `<h1>`, get its HTML, read the title

4. Try your own commands (type a JSON line in the server terminal):
   ```
   {"cmd":"nav","url":"https://google.com"}
   {"cmd":"type","selector":"input[name=q]","text":"federated learning","enter":true}
   {"cmd":"click","selector":"a h3","index":0,"timeout_ms":3000}
   {"cmd":"exists","selector":"footer"}
   {"cmd":"get_html"}
   {"cmd":"exec_js","js":"document.title"}
   ```

## Command schema
- `nav`: `{ "cmd":"nav", "url":"https://site.com", "reuse":true }`
- `click`: `{ "cmd":"click", "selector":"#login", "index":0, "timeout_ms":2000 }`
- `type`: `{ "cmd":"type", "selector":"input[name=q]", "text":"hi", "clear":true, "enter":true }`
- `set`: `{ "cmd":"set", "selector":"#age", "value":"42" }` or `{ "cmd":"set", "selector":"#img", "attr":"src", "value":"/pic.png" }`
- `exists`: `{ "cmd":"exists", "selector":".result" }`
- `get_html`: `{ "cmd":"get_html", "selector":".content", "max_len":500000 }` (omit `selector` for full page)
- `exec_js`: `{ "cmd":"exec_js", "js":"document.title" }`

Responses:
```json
{ "id": "...", "ok": true, "result": { ... } }
{ "id": "...", "ok": false, "error": "message" }
```

## Notes
- Requires Chrome MV3. WebSocket is kept alive via an **offscreen document**.
- Needs `host_permissions: ["<all_urls>"]` to work across sites.
- Some pages (Chrome Web Store, internal pages) are off-limits by design.
