// 三种 agent 的接入后端。对外是同一个形状的“会话”：
//   send(text, io) -> { text, status }   io: { onDelta(text), onTool(title), ask({ title, kind }) -> Promise<boolean> }
//   cancel()  setModel(m)  setPermission(p)  reset()  close()  id
// 权限三档：full（全部放行）、readonly（不改文件、不跑命令）、ask（每次改动问用户）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AcpClient } from '../acp.mjs';

const BIN = {
  claude: process.env.PEER_CLAUDE_BIN || 'claude',
  codex: process.env.PEER_CODEX_BIN || 'codex',
  agy: process.env.PEER_AGY_BIN || 'agy',
};
export const KINDS = ['claude', 'codex', 'agy'];
export const PERMISSIONS = ['full', 'readonly', 'ask'];

// 共用一个子进程的后端（agy、codex）：进程挂了就清掉，下次用到再起。
class Host {
  client = null;
  ready = null;
  sessions = new Map(); // 后端的会话编号 -> 会话对象
  ensure() {
    if (this.ready) return this.ready;
    const c = this.spawn();
    this.client = c;
    const ready = (async () => { c.start(); await this.handshake(c); return c; })();
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.down(); c.kill(); });
    return ready;
  }
  down() {
    this.client = null;
    this.ready = null;
    for (const s of this.sessions.values()) s.live = false;
  }
  kill() { try { this.client?.kill(); } catch { /* 已经退出 */ } this.down(); }
}

// ---------- agy（ACP） ----------
const AGY_SAFE = new Set(['read', 'search', 'think', 'fetch']);

class AgyHost extends Host {
  models = null;
  spawn() {
    // 继承来的 Gemini API key 会让 agy 改用 key 认证而被模型拒绝，所以去掉。
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    const c = new AcpClient({
      bin: BIN.agy, args: ['acp'], cwd: process.env.HOME, env, label: 'agy',
      onNotify: (method, p) => { if (method === 'session/update') this.sessions.get(p?.sessionId)?.onUpdate(p.update ?? {}); },
      onRequest: (method, p, respond) => {
        const s = this.sessions.get(p?.sessionId);
        if (method !== 'session/request_permission' || !s) return respond(undefined, { code: -32601, message: 'not supported' });
        s.onPermission(p, respond);
      },
      onExit: () => { if (this.client === c) this.down(); },
    });
    return c;
  }
  handshake(c) {
    return c.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'peer', version: '0.2.0' },
    });
  }
}

class AgySession {
  live = false;
  turn = null;
  appliedModel = null;
  constructor(host, o) { this.host = host; this.id = o.sessionId ?? null; this.cwd = o.cwd; this.model = o.model ?? null; this.permission = o.permission; }

  async #open() {
    const c = await this.host.ensure();
    if (!this.live && this.id) {
      this.host.sessions.set(this.id, this); // 恢复时会回放历史，没有进行中的一轮就会被丢掉
      try { await c.call('session/load', { sessionId: this.id, cwd: this.cwd, mcpServers: [] }); this.live = true; this.appliedModel = null; }
      catch { this.host.sessions.delete(this.id); this.id = null; }
    }
    if (!this.id) {
      const r = await c.call('session/new', { cwd: this.cwd, mcpServers: [] });
      this.id = r.sessionId;
      this.live = true;
      this.appliedModel = r.models?.currentModelId ?? null;
      if (r.models?.availableModels) this.host.models = r.models.availableModels.map((m) => ({ id: m.modelId, name: m.name }));
      this.host.sessions.set(this.id, this);
    }
    if (this.model && this.model !== this.appliedModel) {
      await c.call('session/set_model', { sessionId: this.id, modelId: this.model });
      this.appliedModel = this.model;
    }
    return c;
  }

  onUpdate(u) {
    const t = this.turn;
    if (!t) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { t.chunks.push(u.content.text); t.io.onDelta?.(u.content.text); }
    else if (u.sessionUpdate === 'tool_call') t.io.onTool?.(u.title ?? u.kind ?? '工具');
  }

  async onPermission(p, respond) {
    const tc = p?.toolCall ?? {};
    const options = p?.options ?? [];
    // agy 的交互式提问只接受预设选项，这里没有人选，取消它；群规里已要求把问题写在回答里。
    if (String(tc.toolCallId ?? '').startsWith('interaction_')) return respond({ outcome: { outcome: 'cancelled' } });
    const kind = tc.kind ?? 'other';
    let allowed = this.permission === 'full' || AGY_SAFE.has(kind);
    if (!allowed && this.permission === 'ask' && this.turn) allowed = await this.turn.io.ask({ title: tc.title ?? kind, kind }).catch(() => false);
    const pick = (prefix) => options.find((o) => o.kind === `${prefix}_once`) ?? options.find((o) => String(o.kind).startsWith(prefix));
    const opt = pick(allowed ? 'allow' : 'reject');
    if (!allowed) this.turn?.denied.push(tc.title ?? kind);
    respond(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  async send(text, io) {
    const c = await this.#open();
    const t = (this.turn = { chunks: [], denied: [], io });
    try {
      const r = await c.call('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] });
      // agy 的操作被拒绝后常常整轮不再说话，把被拒绝的操作带回去，群里才看得出原因。
      return { text: t.chunks.join(''), status: r?.stopReason === 'cancelled' && !t.denied.length ? 'cancelled' : 'ok', denied: t.denied };
    } finally { this.turn = null; }
  }
  cancel() { if (this.turn && this.id) this.host.client?.notify('session/cancel', { sessionId: this.id }); }
  setModel(m) { this.model = m; }
  setPermission(p) { this.permission = p; }
  reset() { this.close(); this.id = null; this.live = false; }
  close() { if (this.id) this.host.sessions.delete(this.id); }
}

// ---------- codex（app-server） ----------
// sandbox 是开线程时的写法，sandboxPolicy 是每一轮的写法，两处都要给：
// 对已经打开的线程，thread/resume 带的新权限不生效（实测），只有 turn/start 带的才算数。
const CODEX_POLICY = {
  full: { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never' },
  readonly: { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' },
  ask: { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'untrusted' },
};

class CodexHost extends Host {
  spawn() {
    const c = new AcpClient({
      bin: BIN.codex, args: ['app-server'], cwd: process.env.HOME, env: process.env, label: 'codex', bare: true,
      onNotify: (method, p) => this.sessions.get(p?.threadId)?.onNotify(method, p),
      onRequest: (method, p, respond) => {
        const s = this.sessions.get(p?.threadId);
        if (!s || !/\/requestApproval$/.test(method)) return respond(undefined, { code: -32601, message: 'not supported' });
        s.onApproval(method, p, respond);
      },
      onExit: () => { if (this.client === c) this.down(); },
    });
    return c;
  }
  async handshake(c) {
    await c.call('initialize', { clientInfo: { name: 'peer', title: 'peer', version: '0.2.0' }, capabilities: null });
    c.notify('initialized', {});
  }
}

class CodexSession {
  _live = false;
  turn = null;
  constructor(host, o) { this.host = host; this.id = o.sessionId ?? null; this.cwd = o.cwd; this.model = o.model ?? null; this.permission = o.permission; }

  async #open() {
    const c = await this.host.ensure();
    if (this.live) return c;
    const { sandbox, approvalPolicy } = CODEX_POLICY[this.permission];
    const base = { cwd: this.cwd, sandbox, approvalPolicy, ...(this.model ? { model: this.model } : {}) };
    if (this.id) {
      try { await c.call('thread/resume', { threadId: this.id, excludeTurns: true, ...base }); }
      catch { this.host.sessions.delete(this.id); this.id = null; }
    }
    if (!this.id) this.id = (await c.call('thread/start', base)).thread.id;
    this.host.sessions.set(this.id, this);
    this.live = true;
    return c;
  }

  onNotify(method, p) {
    const t = this.turn;
    if (!t) return;
    const item = p?.item;
    if (method === 'turn/started') t.turnId = p.turn?.id;
    else if (method === 'item/started' && item?.type === 'agentMessage') t.items.set(item.id, { phase: item.phase, text: '' });
    else if (method === 'item/started' && item?.type === 'commandExecution') t.io.onTool?.(`执行 ${item.command}`);
    else if (method === 'item/started' && item?.type === 'fileChange') t.io.onTool?.(`改文件 ${(item.changes ?? []).map((x) => x.path).join('、')}`);
    else if (method === 'item/agentMessage/delta') {
      const it = t.items.get(p.itemId);
      if (it) { it.text += p.delta; if (it.phase === 'final_answer') t.io.onDelta?.(p.delta); }
    } else if (method === 'item/completed' && item?.type === 'agentMessage') t.items.set(item.id, { phase: item.phase, text: item.text ?? '' });
    else if (method === 'error') t.error = p?.error?.message ?? t.error;
    else if (method === 'turn/completed') t.done({ status: p.turn?.status, error: p.turn?.error?.message });
  }

  async onApproval(method, p, respond) {
    let ok = this.permission === 'full';
    if (!ok && this.permission === 'ask' && this.turn) {
      const title = p.command ? `执行 ${p.command}` : `改文件${p.reason ? `：${p.reason}` : ''}`;
      ok = await this.turn.io.ask({ title, kind: p.command ? 'execute' : 'edit' }).catch(() => false);
    }
    respond({ decision: ok ? 'accept' : 'decline' });
  }

  async send(text, io) {
    const c = await this.#open();
    const t = (this.turn = { items: new Map(), io, turnId: null, error: null });
    const finished = new Promise((resolve) => { t.done = resolve; });
    try {
      const { sandboxPolicy, approvalPolicy } = CODEX_POLICY[this.permission];
      const r = await c.call('turn/start', {
        threadId: this.id, input: [{ type: 'text', text, text_elements: [] }],
        sandboxPolicy, approvalPolicy, ...(this.model ? { model: this.model } : {}),
      });
      t.turnId ??= r?.turn?.id ?? null;
      const end = await Promise.race([finished, new Promise((_, rej) => { t.fail = rej; })]);
      const all = [...t.items.values()];
      const finals = all.filter((i) => i.phase === 'final_answer');
      const out = (finals.length ? finals : all).map((i) => i.text).join('\n\n').trim();
      if (end.status === 'failed') throw new Error(end.error ?? t.error ?? 'codex 这一轮失败了');
      return { text: out, status: end.status === 'interrupted' ? 'cancelled' : 'ok' };
    } finally { this.turn = null; }
  }
  // 进程挂掉时，正在进行的这一轮要立刻失败，不能一直等。
  set live(v) { this._live = v; if (!v) this.turn?.fail?.(new Error('codex 进程已退出')); }
  get live() { return this._live; }
  cancel() { const t = this.turn; if (t?.turnId) this.host.client?.call('turn/interrupt', { threadId: this.id, turnId: t.turnId }).catch(() => {}); }
  setModel(m) { this.model = m; }
  setPermission(p) { this.permission = p; }
  reset() { this.close(); this.id = null; this.live = false; }
  close() { if (this.id) this.host.sessions.delete(this.id); }
}

// ---------- Claude Code（无界面，逐行 JSON） ----------
const CLAUDE_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

class ClaudeSession {
  child = null;
  turn = null;
  constructor(o) { this.id = o.sessionId ?? null; this.cwd = o.cwd; this.model = o.model ?? null; this.permission = o.permission; }

  #spawn() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (this.permission === 'full') args.push('--permission-mode', 'bypassPermissions');
    else if (this.permission === 'readonly') args.push('--permission-mode', 'default', '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit');
    else args.push('--permission-mode', 'default', '--permission-prompt-tool', 'stdio');
    if (this.model) args.push('--model', this.model);
    if (this.id) args.push('--resume', this.id);
    const env = { ...process.env };
    delete env.CLAUDECODE; // 不让它以为自己是嵌在另一个 Claude Code 里
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = (this.child = spawn(BIN.claude, args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-800); });
    child.stdin.on('error', () => {});
    const gone = (why) => {
      if (this.child !== child) return; // 是被我们自己换掉的旧进程，和当前这一轮无关
      this.child = null;
      this.turn?.fail(new Error(errTail.trim() ? `${why}\n${errTail.trim()}` : why));
    };
    child.on('error', (e) => gone(`无法启动 claude：${e.message}`));
    child.on('exit', (code) => gone(`claude 进程已退出（code=${code}）`));
    createInterface({ input: child.stdout }).on('line', (l) => { if (this.child === child) this.#line(l); });
  }

  #write(o) { this.child?.stdin.write(JSON.stringify(o) + '\n'); }

  #line(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.session_id && m.type === 'system' && m.subtype === 'init') this.id = m.session_id;
    const t = this.turn;
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') return this.#permission(m);
    if (!t) return;
    if (m.type === 'stream_event') {
      const d = m.event?.delta;
      if (m.event?.type === 'content_block_delta' && d?.type === 'text_delta') t.io.onDelta?.(d.text);
    } else if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b.type === 'tool_use') t.io.onTool?.(toolTitle(b));
    } else if (m.type === 'result') {
      if (m.is_error && !t.cancelled) t.fail(new Error(String(m.result ?? m.subtype ?? 'claude 这一轮出错了')));
      else t.done({ text: String(m.result ?? ''), status: t.cancelled ? 'cancelled' : 'ok' });
    }
  }

  async #permission(m) {
    const r = m.request;
    const ok = this.turn ? await this.turn.io.ask({ title: toolTitle({ name: r.tool_name, input: r.input }), kind: r.tool_name }).catch(() => false) : false;
    const response = ok ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: '用户没有批准这个操作' };
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  }

  send(text, io) {
    if (!this.child) this.#spawn();
    return new Promise((resolve, reject) => {
      const end = (fn) => (v) => { clearTimeout(this.turn?.killTimer); this.turn = null; fn(v); };
      this.turn = { io, done: end(resolve), fail: end(reject), cancelled: false, killTimer: null };
      this.#write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    });
  }
  cancel() {
    const t = this.turn;
    if (!t || t.cancelled) return;
    t.cancelled = true;
    this.#write({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } });
    // 中断没生效就直接结束进程；会话在磁盘上，下一轮带着编号接回来。
    t.killTimer = setTimeout(() => { const c = this.child; this.child = null; c?.kill(); t.done({ text: '', status: 'cancelled' }); }, 5000);
  }
  #restart() { const c = this.child; this.child = null; c?.kill(); }
  // 模型和权限是启动参数，改了就结束进程，下一轮带着会话编号重新启动。
  setModel(m) { this.model = m; this.#restart(); }
  setPermission(p) { this.permission = p; this.#restart(); }
  reset() { this.#restart(); this.id = null; }
  close() { this.#restart(); }
}

function toolTitle(b) {
  const i = b.input ?? {};
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? '';
  return `${b.name}${detail ? ` ${String(detail).slice(0, 120)}` : ''}`;
}

// ---------- 对外 ----------
const hosts = { agy: new AgyHost(), codex: new CodexHost() };

export function createSession(kind, o) {
  if (kind === 'claude') return new ClaudeSession(o);
  if (kind === 'codex') return new CodexSession(hosts.codex, o);
  if (kind === 'agy') return new AgySession(hosts.agy, o);
  throw new Error(`不认识的 agent 类型 ${kind}（可用：${KINDS.join('、')}）`);
}

export async function listModels(kind) {
  if (kind === 'claude') return CLAUDE_MODELS.map((id) => ({ id, name: id }));
  if (kind === 'codex') {
    const c = await hosts.codex.ensure();
    const r = await c.call('model/list', { limit: 100 });
    return (r.data ?? []).map((m) => ({ id: m.id ?? m.model, name: m.displayName ?? m.id, isDefault: !!m.isDefault }));
  }
  if (kind === 'agy') {
    if (!hosts.agy.models) {
      // agy 只在新建会话时给出模型表，这里开一个不用的会话取一次。
      const c = await hosts.agy.ensure();
      const r = await c.call('session/new', { cwd: process.env.HOME, mcpServers: [] });
      hosts.agy.models = (r.models?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name }));
    }
    return hosts.agy.models;
  }
  throw new Error(`不认识的 agent 类型 ${kind}`);
}

export function shutdownBackends() { hosts.agy.kill(); hosts.codex.kill(); }
