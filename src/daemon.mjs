#!/usr/bin/env node
// 常驻程序：握着一个 agy acp 子进程和一个本机 socket。agyc 命令每次连上来发一个请求。
import net from 'node:net';
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcpClient } from './acp.mjs';
import { HOME, SOCK, SESSIONS_FILE, LOG_DIR } from './paths.mjs';

const AGY_BIN = process.env.AGYC_AGY_BIN || 'agy';
const IDLE_MS = Number(process.env.AGYC_IDLE_HOURS ?? 12) * 3600 * 1000;
// 不需要问就放行的操作种类（ACP 的 toolCall.kind）；其余要在 ask 时用 --allow 打开。
const SAFE_KINDS = new Set(['read', 'search', 'think', 'fetch']);
const PRIMER =
  '[协作说明] 你正在通过一座桥与另一个编程智能体 Claude Code 协作，之后的消息都来自它，它代表同一位用户。约定：\n' +
  '1. 有疑问、或需要对方做决定时，直接把问题写在回答里并结束这一轮，对方会在下一条消息里回答。不要使用交互式提问工具，这里没有人应答。\n' +
  '2. 回答先给结论，保持简洁。\n' +
  '3. 某个操作被拒绝时不要反复重试，说明你需要什么权限。\n\n';

mkdirSync(LOG_DIR, { recursive: true });
const stamp = () => new Date().toLocaleString('sv-SE'); // 本地时间，形如 2026-11-22 18:37:00
const slog = (name, line) => appendFileSync(join(LOG_DIR, `${name}.log`), `[${stamp()}] ${line}\n`);

// ---------- agy 进程与会话 ----------
const sessions = new Map(); // 名字 -> { id, cwd, primed, live, busy }
const turns = new Map(); // ACP 会话 id -> 正在进行的这一轮
let acp = null;
let acpReady = null;
let agentInfo = null;

try {
  for (const [n, r] of Object.entries(JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')))) sessions.set(n, { ...r, live: false, busy: false });
} catch { /* 第一次运行 */ }
function saveSessions() {
  const o = {};
  for (const [n, r] of sessions) o[n] = { id: r.id, cwd: r.cwd, primed: r.primed };
  writeFileSync(SESSIONS_FILE, JSON.stringify(o, null, 2));
}
const nameOf = (id) => { for (const [n, r] of sessions) if (r.id === id) return n; return 'unknown'; };

function ensureAgy() {
  if (acpReady) return acpReady;
  // 继承来的 Gemini API key 会让 agy 改用 key 认证而被模型拒绝（Orca 源码里的注释），所以去掉。
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  const c = new AcpClient({
    bin: AGY_BIN, args: ['acp'], cwd: HOME, env,
    onNotify, onRequest,
    onExit: () => {
      if (acp === c) { acp = null; acpReady = null; }
      for (const r of sessions.values()) r.live = false;
    },
  });
  acp = c;
  const ready = (async () => {
    c.start();
    const r = await c.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'claude-agy-bridge', version: '0.1.0' },
    });
    agentInfo = r.agentInfo ?? null;
    return c;
  })();
  acpReady = ready;
  ready.catch(() => { if (acpReady === ready) { acp = null; acpReady = null; } c.kill(); });
  return ready;
}

let gate = Promise.resolve();
const serial = (fn) => { const p = gate.then(fn); gate = p.catch(() => {}); return p; };

// 取得可用的会话：进程里还活着就直接用；常驻程序或 agy 重启过就按编号从磁盘恢复；恢复不了就新建。
function ensureSession(name, cwd) {
  return serial(async () => {
    const c = await ensureAgy();
    let rec = sessions.get(name);
    let note = '';
    if (rec?.live) return { c, rec, note };
    if (rec) {
      try {
        await c.call('session/load', { sessionId: rec.id, cwd: rec.cwd, mcpServers: [] });
        rec.live = true;
        note = 'restored';
      } catch (e) {
        slog(name, `恢复会话 ${rec.id} 失败：${e.message}`);
        sessions.delete(name);
        rec = null;
        note = 'lost';
      }
    }
    if (!rec) {
      const r = await c.call('session/new', { cwd, mcpServers: [] });
      rec = { id: r.sessionId, cwd, primed: false, live: true, busy: false };
      sessions.set(name, rec);
      slog(name, `新会话 ${rec.id}，工作目录 ${cwd}`);
    }
    saveSessions();
    return { c, rec, note };
  });
}

function onNotify(method, params) {
  if (method !== 'session/update') return;
  const turn = turns.get(params?.sessionId);
  if (!turn) return; // 恢复会话时回放的历史，不属于任何一轮
  const u = params.update ?? {};
  if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') turn.chunks.push(u.content.text);
  else if (u.sessionUpdate === 'tool_call') slog(turn.name, `    工具 ${u.kind ?? '?'}：${u.title ?? u.toolCallId}`);
}

function onRequest(method, params, respond) {
  if (method !== 'session/request_permission') return respond(undefined, { code: -32601, message: 'not supported by claude-agy-bridge' });
  const turn = turns.get(params?.sessionId);
  const tc = params?.toolCall ?? {};
  const options = params?.options ?? [];
  const title = tc.title ?? tc.toolCallId ?? '?';
  const name = turn?.name ?? nameOf(params?.sessionId);
  // agy 的交互式提问只接受预设选项，这里没有人选，取消它；约定里已要求它把问题写在回答里。
  if (String(tc.toolCallId ?? '').startsWith('interaction_')) {
    slog(name, `    取消交互式提问：${title}`);
    turn?.perms.push({ title, kind: 'question', allowed: false });
    return respond({ outcome: { outcome: 'cancelled' } });
  }
  const kind = tc.kind ?? 'other';
  const allowed = SAFE_KINDS.has(kind) || !!turn?.allow.has('all') || !!turn?.allow.has(kind);
  const pick = (prefix) => options.find((o) => o.kind === `${prefix}_once`) ?? options.find((o) => String(o.kind).startsWith(prefix));
  const opt = pick(allowed ? 'allow' : 'reject');
  slog(name, `    权限 ${kind}：${title} → ${allowed ? '放行' : '拒绝'}`);
  turn?.perms.push({ title, kind, allowed });
  respond(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
}

async function handleAsk(req, conn) {
  const name = req.session || 'main';
  const { c, rec, note } = await ensureSession(name, req.cwd || HOME);
  if (rec.busy) throw new Error(`会话 ${name} 还在处理上一条消息。等它结束，或运行 agyc cancel -s ${name}`);
  rec.busy = true;
  const turn = { name, chunks: [], allow: new Set(req.allow ?? []), perms: [], cancelled: null };
  turns.set(rec.id, turn);
  const t0 = Date.now();
  slog(name, `>>> Claude：${req.prompt}`);
  const cancel = (why) => { if (!turn.cancelled) { turn.cancelled = why; c.notify('session/cancel', { sessionId: rec.id }); } };
  const timer = req.timeoutS > 0 ? setTimeout(() => cancel('timeout'), req.timeoutS * 1000) : null;
  conn.onClose = () => cancel('client-gone');
  rec.cancel = cancel;
  try {
    const text = (rec.primed ? '' : PRIMER) + req.prompt;
    const r = await c.call('session/prompt', { sessionId: rec.id, prompt: [{ type: 'text', text }] });
    rec.primed = true;
    saveSessions();
    const answer = turn.chunks.join('');
    slog(name, `<<< agy（${r?.stopReason}${turn.cancelled ? '，' + turn.cancelled : ''}）：${answer}`);
    return {
      ok: true, text: answer, stopReason: r?.stopReason, seconds: +((Date.now() - t0) / 1000).toFixed(1),
      session: name, cwd: rec.cwd, note, perms: turn.perms, cancelled: turn.cancelled,
    };
  } catch (e) {
    slog(name, `!!! 出错：${e.message}`);
    throw e;
  } finally {
    clearTimeout(timer);
    rec.busy = false;
    rec.cancel = null;
    turns.delete(rec.id);
    conn.onClose = null;
  }
}

// ---------- 外面的 agy 主动找 Claude：tell / wait / reply ----------
const inbox = []; // 等 Claude 处理的来信
let waiter = null; // 正在等来信的那条 agyc wait
let seq = 0;

function pump() {
  if (!waiter) return;
  const msg = inbox.find((m) => !m.delivered);
  if (!msg) return;
  msg.delivered = true;
  const w = waiter;
  waiter = null;
  slog('inbox', `${msg.id} 已交给 Claude`);
  w({ ok: true, id: msg.id, from: msg.from, text: msg.text });
}

function handleTell(req, conn) {
  return new Promise((resolve) => {
    const id = `m${++seq}`;
    const timeoutS = req.timeoutS > 0 ? req.timeoutS : 600;
    const msg = { id, from: req.from || 'agy', text: String(req.text ?? ''), delivered: false };
    const drop = () => { const i = inbox.indexOf(msg); if (i >= 0) inbox.splice(i, 1); };
    const timer = setTimeout(() => {
      drop();
      resolve({ ok: false, error: `等了 ${timeoutS} 秒没有收到 Claude 的回复（消息 ${id}，${msg.delivered ? '已交给 Claude' : 'Claude 没在监听，未送达'}）` });
    }, timeoutS * 1000);
    msg.finish = (o) => { clearTimeout(timer); drop(); resolve(o); };
    conn.onClose = () => { clearTimeout(timer); drop(); };
    inbox.push(msg);
    slog('inbox', `${id} 来自 ${msg.from}：${msg.text}`);
    pump();
  });
}

function handleWait(req, conn) {
  return new Promise((resolve) => {
    if (waiter) waiter({ ok: false, superseded: true, error: '已有新的 agyc wait 接替了这一条' });
    waiter = resolve;
    conn.onClose = () => { if (waiter === resolve) waiter = null; };
    pump();
  });
}

function handleReply(req) {
  const msg = inbox.find((m) => m.id === req.id);
  if (!msg) throw new Error(`没有在等回复的消息 ${req.id}（可能已超时、已回复，或对方已退出）`);
  slog('inbox', `${msg.id} Claude 回复：${req.text}`);
  msg.finish({ ok: true, text: String(req.text ?? '') });
  return { ok: true };
}

// ---------- 请求分发 ----------
function handleStatus() {
  return {
    ok: true, pid: process.pid, home: HOME, agy: agentInfo, agyPid: acp?.pid ?? null,
    sessions: [...sessions].map(([name, r]) => ({ name, id: r.id, cwd: r.cwd, busy: r.busy, live: r.live })),
    listening: !!waiter, inbox: inbox.map((m) => ({ id: m.id, from: m.from, delivered: m.delivered })),
  };
}

async function dispatch(req, conn) {
  switch (req.cmd) {
    case 'ask': return handleAsk(req, conn);
    case 'tell': return handleTell(req, conn);
    case 'wait': return handleWait(req, conn);
    case 'reply': return handleReply(req);
    case 'status': return handleStatus();
    case 'cancel': {
      const rec = sessions.get(req.session || 'main');
      if (!rec?.busy) return { ok: true, cancelled: false };
      rec.cancel?.('cancelled-by-user');
      return { ok: true, cancelled: true };
    }
    case 'new': {
      const name = req.session || 'main';
      const rec = sessions.get(name);
      if (rec?.busy) throw new Error(`会话 ${name} 正在运行，先 agyc cancel -s ${name}`);
      const had = sessions.delete(name);
      saveSessions();
      if (had) slog(name, '会话已重置，下次 ask 新建');
      return { ok: true, removed: had };
    }
    case 'stop':
      // 先撤掉 socket 再回话：紧跟着的下一条命令会启动新的常驻程序，不会连到正在退出的这一个。
      removeSocket();
      setTimeout(shutdown, 50);
      return { ok: true };
    default: throw new Error(`未知命令 ${req.cmd}`);
  }
}

let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  if (!(IDLE_MS > 0)) return;
  idleTimer = setTimeout(() => {
    const busy = waiter || inbox.length || [...sessions.values()].some((r) => r.busy);
    if (busy) touch(); else shutdown();
  }, IDLE_MS);
  idleTimer.unref?.();
}

const server = net.createServer((sock) => {
  const conn = { onClose: null, done: false, started: false };
  let buf = '';
  const end = (o) => { conn.done = true; if (!sock.destroyed) sock.end(JSON.stringify(o) + '\n'); };
  sock.on('data', (d) => {
    if (conn.started) return;
    buf += d;
    const i = buf.indexOf('\n');
    if (i < 0) return;
    conn.started = true;
    let req;
    try { req = JSON.parse(buf.slice(0, i)); } catch { return end({ ok: false, error: '请求不是合法 JSON' }); }
    touch();
    dispatch(req, conn).then(end, (e) => end({ ok: false, error: e.message }));
  });
  sock.on('close', () => { if (!conn.done) conn.onClose?.(); });
  sock.on('error', () => {});
});

// 只撤一次：撤掉之后同一路径可能已经属于新的常驻程序，不能再删。
let socketRemoved = false;
function removeSocket() {
  if (socketRemoved) return;
  socketRemoved = true;
  server.close();
  try { unlinkSync(SOCK); } catch { /* 已经删掉 */ }
}
function shutdown() {
  try { acp?.kill(); } catch { /* 已经退出 */ }
  removeSocket();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 已有常驻程序在跑就让位；socket 文件是上次留下的就删掉。
function start() {
  if (!existsSync(SOCK)) return listen();
  const probe = net.connect(SOCK);
  probe.on('connect', () => { probe.destroy(); process.exit(0); });
  probe.on('error', () => { try { unlinkSync(SOCK); } catch { /* 被别人删了 */ } listen(); });
}
function listen() {
  server.listen(SOCK, () => {
    touch();
    // socket 文件被删就没人连得上了，自行退出，不留孤儿进程。
    setInterval(() => { if (!socketRemoved && !existsSync(SOCK)) { socketRemoved = true; shutdown(); } }, 30000).unref();
  });
  server.on('error', (e) => { console.error(`监听 ${SOCK} 失败：${e.message}`); process.exit(1); });
}
start();
