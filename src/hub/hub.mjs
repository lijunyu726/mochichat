#!/usr/bin/env node
// 团队中心：常驻的本机 HTTP 服务。peer 命令和群聊室网页都通过它收发。
// 只听 127.0.0.1，每个请求都要带口令（成员默认是最高权限，不能让别的网页随便调）。
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Rooms } from './rooms.mjs';
import { listModels, shutdownBackends, KINDS, PERMISSIONS } from './backends.mjs';
import { PEER_HOME, PEER_PORT, TOKEN_FILE, HUB_FILE } from './paths.mjs';

// 团队中心是从某个终端里启动的，会继承那个终端的标识。成员进程带着这些标识时，
// 用户给终端配的钩子（iTerm2、Orca 的状态上报和提醒）会把成员的每一轮当成用户自己的会话来播报，所以去掉。
for (const k of Object.keys(process.env)) if (/^(ITERM|ORCA_|TERM_PROGRAM|TERM_SESSION_ID|LC_TERMINAL)/.test(k)) delete process.env[k];

mkdirSync(PEER_HOME, { recursive: true, mode: 0o700 });
let token;
try { token = readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* 第一次运行 */ }
if (!token) { token = randomBytes(24).toString('hex'); writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 }); }

const streams = new Set(); // 正在收事件的连接
const emit = (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const s of streams) s.write(line); };
const rooms = new Rooms(PEER_HOME, emit);

function authed(req, url) {
  // Host 必须是本机：挡住把别的域名解析到 127.0.0.1 的网页。
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return false;
  const given = Buffer.from(String(req.headers['x-peer-token'] ?? url.searchParams.get('token') ?? ''));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 2e6) reject(new Error('请求太大')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('请求不是合法 JSON')); } });
    req.on('error', reject);
  });
}

async function route(req, url) {
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const [, a, id, b, name, c] = seg;
  const M = req.method;
  if (a === 'state' && M === 'GET') return { teams: rooms.state(), kinds: KINDS, permissions: PERMISSIONS, pid: process.pid };
  if (a === 'models' && M === 'GET') return { models: await listModels(id) };
  if (a === 'shutdown' && M === 'POST') { setTimeout(shutdown, 50); return {}; }
  if (a !== 'teams') throw notFound();
  if (!id) {
    if (M === 'POST') return { team: rooms.view(rooms.createTeam(await body(req))) };
    throw notFound();
  }
  const t = rooms.team(id);
  if (!b) {
    if (M === 'GET') return { team: rooms.view(t) };
    if (M === 'PATCH') return { team: rooms.view(rooms.updateTeam(t.id, await body(req))) };
    if (M === 'DELETE') { rooms.removeTeam(t.id); return {}; }
  }
  if (b === 'messages') {
    if (M === 'GET') return { messages: rooms.messages(t.id, Number(url.searchParams.get('after') ?? 0)) };
    if (M === 'POST') return rooms.say(t.id, (await body(req)).text);
  }
  if (b === 'stop' && M === 'POST') { rooms.stop(t); return {}; }
  if (b === 'continue' && M === 'POST') { rooms.resume(t); return {}; }
  if (b === 'asks' && name && M === 'POST') { rooms.answerAsk(t.id, name, (await body(req)).allow); return {}; }
  if (b === 'members') {
    if (!name && M === 'POST') { rooms.addMember(t.id, await body(req)); return { team: rooms.view(t) }; }
    if (name && c === 'clear' && M === 'POST') { rooms.clearMember(t.id, name); return {}; }
    if (name && !c && M === 'PATCH') { rooms.updateMember(t.id, name, await body(req)); return { team: rooms.view(t) }; }
    if (name && !c && M === 'DELETE') { rooms.removeMember(t.id, name); return { team: rooms.view(t) }; }
  }
  throw notFound();
}
function notFound() { const e = new Error('没有这个接口'); e.status = 404; return e; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (!url.pathname.startsWith('/api/')) return json(404, { ok: false, error: '群聊室网页还没有做' });
  if (!authed(req, url)) return json(401, { ok: false, error: '口令不对' });
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  try { json(200, { ok: true, ...(await route(req, url)) }); }
  catch (e) { json(e.status ?? 400, { ok: false, error: e.message }); }
});

function shutdown() {
  rooms.shutdown();
  shutdownBackends();
  rmSync(HUB_FILE, { force: true });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.on('error', (e) => { console.error(`团队中心启动失败（端口 ${PEER_PORT}）：${e.message}`); process.exit(1); });
server.listen(PEER_PORT, '127.0.0.1', () => {
  writeFileSync(HUB_FILE, JSON.stringify({ port: PEER_PORT, pid: process.pid }) + '\n');
  // 数据目录被删就没人找得到它了，自行退出，不留孤儿进程。
  setInterval(() => { if (!existsSync(HUB_FILE)) shutdown(); }, 30000).unref();
});
