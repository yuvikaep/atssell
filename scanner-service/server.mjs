// A small HTTPS-facing front for ClamAV, for API hosts (such as Vercel) that cannot reach clamd's plain
// TCP port safely. POST /scan with "Authorization: Bearer <SCANNER_TOKEN>" and the file as the body;
// the answer is {"status":"clean"} or {"status":"infected"}. Anything it cannot decide is a 5xx, which
// the API treats as a failed scan (the file is not served). No dependencies.
//
// Environment: SCANNER_TOKEN (required, 16+ chars), PORT (8080), CLAMD_HOST (127.0.0.1), CLAMD_PORT (3310),
// MAX_BYTES (26214400). Put it behind HTTPS (the hosting platform's TLS, or a reverse proxy).
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.SCANNER_TOKEN ?? '';
if (TOKEN.length < 16) { console.error('SCANNER_TOKEN must be set (16+ characters)'); process.exit(1); }
const PORT = Number(process.env.PORT ?? 8080);
const CLAMD_HOST = process.env.CLAMD_HOST ?? '127.0.0.1';
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 26_214_400);

function clamd(data) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: CLAMD_HOST, port: CLAMD_PORT });
    let reply = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; socket.destroy(); resolve(v); } };
    socket.setTimeout(30_000, () => finish('failed'));
    socket.on('error', () => finish('failed'));
    socket.on('data', (d) => { reply += d.toString('utf8'); });
    socket.on('end', () => {
      const t = reply.replace(/\0/g, '').trim();
      finish(/^stream: OK$/.test(t) ? 'clean' : /FOUND$/.test(t) ? 'infected' : 'failed');
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 65536) {
        const chunk = data.subarray(i, i + 65536);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

const authorised = (h) => {
  const given = Buffer.from(h?.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
};
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/scan') return send(res, 404, { error: 'not found' });
  if (!authorised(req.headers.authorization)) return send(res, 401, { error: 'unauthorised' });
  const parts = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) { send(res, 413, { error: 'too large' }); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    const verdict = await clamd(Buffer.concat(parts));
    if (verdict === 'failed') return send(res, 503, { error: 'scanner unavailable' });
    send(res, 200, { status: verdict });
  });
}).listen(PORT, () => console.log(`scanner-service listening on ${PORT}`));
