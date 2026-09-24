import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { Room } from './lib/room.mjs';
import { SearchQueue } from './lib/search.mjs';
import { VideoParts } from './lib/video-parts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.KTV_DATA_DIR || path.join(root, 'data');
mkdirSync(data, { recursive: true });
// Home rooms are open by default. Legacy generated keys do not enable authentication.
const key = (process.env.KTV_ROOM_KEY || '').trim();
const statePath = path.join(data, 'room.json');
let saved = {};
if (existsSync(statePath)) saved = JSON.parse(readFileSync(statePath, 'utf8'));
const room = new Room(saved, state => {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${statePath}.tmp`, statePath);
});
const assets = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']]
]);
const searches = new SearchQueue();
const videoParts = new VideoParts();
const failCounts = new Map();
let streams = 0;
function auth(req) {
  if (!key) return true;
  const ip = req.socket.remoteAddress;
  const record = failCounts.get(ip);
  if (record && record.until > Date.now() && record.count >= 20) return false;
  const token = Buffer.from(String(req.headers['x-room-key'] || ''));
  const expected = Buffer.from(key);
  const valid = token.length === expected.length && timingSafeEqual(token, expected);
  if (!valid) {
    if (failCounts.size > 1000) failCounts.clear();
    const count = record && record.until > Date.now() ? record.count + 1 : 1;
    failCounts.set(ip, { count, until: Date.now() + 60000 });
  } else failCounts.delete(ip);
  return valid;
}
const server = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!pathname.startsWith('/api/')) {
      const asset = assets.get(pathname);
      if (!asset || req.method !== 'GET') return send(404, { error: '不存在' });
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://*.hdslb.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(readFileSync(path.join(root, asset[0])));
    }
    // No permissive CORS: phones use the same origin; extensions use host permissions.
    if (req.method === 'GET' && pathname === '/api/info') return send(200, { keyRequired: !!key });
    if (!auth(req)) return send(401, { error: '房间口令不正确，或尝试次数过多，请稍后重试' });
    if (req.method === 'GET' && pathname === '/api/ticks') {
      if (streams >= 20) return send(429, { error: '连接过多，请关闭多余控制台' });
      streams++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('data: tick\n\n');
      const timer = setInterval(() => { if (!res.write('data: tick\n\n')) res.destroy(); }, 1000);
      res.on('close', () => { clearInterval(timer); streams--; });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/state') return send(200, room.snapshot());
    if (req.method === 'GET' && pathname.startsWith('/api/search/')) return send(200, searches.get(pathname.slice('/api/search/'.length)));
    if (req.method !== 'POST') return send(405, { error: '请求方法不支持' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, { error: '需要JSON' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send(413, { error: '请求过大' }); }
    const body = JSON.parse(raw);
    if (pathname === '/api/video/parts') return send(200, await videoParts.get(body.url));
    if (pathname === '/api/search') return send(200, searches.create(body, room.snapshot().hostOnline));
    if (pathname === '/api/search/claim') { room.requireHost(body.hostId); return send(200, { job: searches.claim(body.hostId) }); }
    if (pathname === '/api/search/result') { room.requireHost(body.hostId); return send(200, searches.finish(body, body.hostId)); }
    if (pathname === '/api/action') return send(200, room.action(body));
    if (pathname === '/api/host') return send(200, room.claim(body.hostId));
    if (pathname === '/api/report') {
      room.requireHost(body.hostId);
      if (body.id === room.state.current?.id) room.status = { message: String(body.message || '').slice(0, 200), ...(Number.isFinite(body.time) ? { time: Math.max(0, body.time) } : {}), duration: Math.max(0, Number(body.duration) || 0), at: Date.now() };
      return send(200, room.snapshot());
    }
    if (pathname === '/api/release') {
      room.requireHost(body.hostId); room.host = null; room.status = { message: '主机已停止接管' };
      return send(200, room.snapshot());
    }
    send(404, { error: '不存在' });
  } catch (error) { send(400, { error: error.message }); }
});
server.requestTimeout = 10000;
const port = Number(process.env.PORT || 3210);
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '0.0.0.0', () => {
  console.log(`\nHomeKTV 已启动\n本机：http://127.0.0.1:${server.address().port}\n${key ? `房间口令：${key}` : '家庭模式：免口令，打开页面即可点歌'}\n`);
  for (const list of Object.values(os.networkInterfaces())) for (const address of list || []) if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) console.log(`手机 / 另一台电脑：http://${address.address}:${server.address().port}`);
  console.log('\n保持此窗口运行。按 Ctrl+C 停止。只在信任的家庭局域网使用。');
});
