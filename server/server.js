import { WebSocketServer } from 'ws';
import readline from 'node:readline';

const PORT = 8765;
const wss = new WebSocketServer({ port: PORT });

console.log(`[server] Listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[server] Extension connected.');

  // Print all responses
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      console.log('[server] <-', JSON.stringify(msg, null, 2));
    } catch {
      console.log('[server] <- (raw)', String(data));
    }
  });

  // Demo script: open example.org, check for <h1>, fetch its HTML, then run a tiny JS
  const id = () => Math.random().toString(36).slice(2);

  const demo = [
    { id: id(), cmd: 'nav', url: 'https://example.org' },
    { id: id(), cmd: 'exists', selector: 'h1' },
    { id: id(), cmd: 'get_html', selector: 'h1' },
    { id: id(), cmd: 'exec_js', js: 'document.title' }
  ];

  let delay = 0;
  for (const step of demo) {
    setTimeout(() => {
      console.log('[server] ->', JSON.stringify(step));
      ws.send(JSON.stringify(step));
    }, delay);
    delay += 1000;
  }

  // Interactive CLI: type a JSON object (one line) and press Enter
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n[server] Type a JSON command and press Enter. Examples:');
  console.log('  {\"cmd\":\"nav\",\"url\":\"https://google.com\"}');
  console.log('  {\"cmd\":\"type\",\"selector\":\"input[name=q]\",\"text\":\"hello\", \"enter\":true}');
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      if (!obj.id) obj.id = id();
      ws.send(JSON.stringify(obj));
      console.log('[server] ->', JSON.stringify(obj));
    } catch (e) {
      console.log('[server] Invalid JSON:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[server] Extension disconnected.');
  });
});
