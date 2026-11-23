#!/usr/bin/env node
// 测试用的假 agent：按启动参数扮演 agy（acp）、codex（app-server）或 Claude Code（-p），不调用任何模型。
// 回答按 MOCHI_HOME/fake-script.json 里 { 成员名: [第 1 次的回答, 第 2 次的回答…] } 依次给，没有就答“名字#次数”。
// 回答里的特殊词：SLOW 一直不结束直到被取消；PERM 先申请一次权限，再答 perm=allow / perm=deny。
// 每次收到的输入记在 MOCHI_HOME/fake-log.jsonl；会话状态记在 fake-state.json，进程重启后能恢复。
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = process.env.MOCHI_HOME;
const STATE = join(HOME, 'fake-state.json');
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { sessions: {}, counts: {} }; } };
const save = (s) => writeFileSync(STATE, JSON.stringify(s));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const argv = process.argv.slice(2);
const mode = argv[0] === 'acp' ? 'agy' : argv[0] === 'app-server' ? 'codex' : argv.includes('-p') ? 'claude' : null;
if (!mode) { console.error('fake agent: unknown mode'); process.exit(2); }

// 取下一句回答，并把这次输入记下来。
function next(session, prompt, extra) {
  const s = load();
  const rec = (s.sessions[session] ??= { name: null });
  rec.name ??= prompt.match(/名字是 (\S+?)。/)?.[1] ?? '?';
  const n = (s.counts[rec.name] = (s.counts[rec.name] ?? 0) + 1);
  save(s);
  appendFileSync(join(HOME, 'fake-log.jsonl'), JSON.stringify({ kind: mode, name: rec.name, session, prompt, cwd: process.cwd(), ...extra }) + '\n');
  let script = {};
  try { script = JSON.parse(readFileSync(join(HOME, 'fake-script.json'), 'utf8')); } catch { /* 没有脚本 */ }
  return script[rec.name]?.[n - 1] ?? `${rec.name}#${n}`;
}
const known = (session) => load().sessions[session] !== undefined;
const touch = (session) => { const s = load(); s.sessions[session] ??= { name: null }; save(s); };

const waiting = new Map(); // 发给对方的请求编号 -> 回调
const hanging = new Map(); // 会话 -> 结束 SLOW 那一轮的函数
let rid = 5000;
const lines = (fn) => createInterface({ input: process.stdin }).on('line', (l) => fn(JSON.parse(l)));

// ---------- agy ----------
if (mode === 'agy') {
  const models = new Map();
  const chunk = (sessionId, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  const prompt = async (id, { sessionId, prompt }) => {
    const done = (stopReason = 'end_turn') => out({ jsonrpc: '2.0', id, result: { stopReason } });
    let reply = next(sessionId, prompt.map((p) => p.text).join(''), { model: models.get(sessionId) ?? null });
    if (reply === 'SLOW') { hanging.set(sessionId, () => done('cancelled')); return; }
    if (reply === 'PERM') {
      const r = rid++;
      out({ jsonrpc: '2.0', id: r, method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'call_1', title: 'rm -rf build', kind: 'execute' },
        options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
      } });
      const o = await new Promise((res) => waiting.set(r, res));
      if (o?.outcome?.optionId !== 'yes') return done('cancelled');
      reply = 'perm=allow';
    }
    chunk(sessionId, reply);
    done();
  };
  lines((m) => {
    if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
    const ok = (result) => out({ jsonrpc: '2.0', id: m.id, result });
    const fail = (message) => out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } });
    switch (m.method) {
      case 'initialize': return ok({ protocolVersion: 1, agentInfo: { name: 'Fake agy' } });
      case 'session/new': { const sessionId = randomUUID(); touch(sessionId); return ok({ sessionId, models: { currentModelId: 'g-default', availableModels: [{ modelId: 'g-default', name: 'G Default' }, { modelId: 'g-fast', name: 'G Fast' }] } }); }
      case 'session/load': if (!known(m.params.sessionId)) return fail('no such session'); chunk(m.params.sessionId, 'REPLAYED'); return ok({});
      case 'session/set_model': models.set(m.params.sessionId, m.params.modelId); return ok({});
      case 'session/prompt': return void prompt(m.id, m.params);
      case 'session/cancel': { const f = hanging.get(m.params.sessionId); hanging.delete(m.params.sessionId); f?.(); return; }
      default: if (m.id !== undefined) fail('method not found');
    }
  });
}

// ---------- codex ----------
if (mode === 'codex') {
  const threads = new Map(); // 线程 -> { model, sandbox, approvalPolicy }
  let turnSeq = 0;
  const turn = async (threadId, text) => {
    const cfg = threads.get(threadId);
    const turnId = `turn-${++turnSeq}`;
    const note = (method, params) => out({ method, params: { threadId, turnId, ...params } });
    note('turn/started', { turn: { id: turnId } });
    const end = (status) => note('turn/completed', { turn: { id: turnId, status, error: null } });
    let reply = next(threadId, text, cfg);
    if (reply === 'SLOW') { hanging.set(threadId, () => end('interrupted')); return; }
    if (reply === 'PERM') {
      if (cfg.approvalPolicy === 'never') reply = `perm=${cfg.sandbox === 'danger-full-access' ? 'allow' : 'deny'}`;
      else {
        const r = rid++;
        out({ id: r, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'exec-1', command: 'rm -rf build' } });
        const o = await new Promise((res) => waiting.set(r, res));
        reply = `perm=${o?.decision === 'accept' ? 'allow' : 'deny'}`;
      }
    }
    // 先说一句过程话，再给正式回答：团队中心只应把正式回答发到群里。
    note('item/started', { item: { type: 'agentMessage', id: `c-${turnId}`, phase: 'commentary' } });
    note('item/agentMessage/delta', { itemId: `c-${turnId}`, delta: '（思考中）' });
    note('item/started', { item: { type: 'agentMessage', id: `f-${turnId}`, phase: 'final_answer' } });
    note('item/agentMessage/delta', { itemId: `f-${turnId}`, delta: reply });
    note('item/completed', { item: { type: 'agentMessage', id: `f-${turnId}`, phase: 'final_answer', text: reply } });
    end('completed');
  };
  lines((m) => {
    if (m.jsonrpc !== undefined) { console.error('codex 的消息不应带 jsonrpc 字段'); process.exit(3); }
    if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
    const ok = (result) => out({ id: m.id, result });
    const p = m.params ?? {};
    const cfg = { model: p.model ?? null, sandbox: p.sandbox, approvalPolicy: p.approvalPolicy };
    switch (m.method) {
      case 'initialize': return ok({ userAgent: 'fake-codex' });
      case 'initialized': return;
      case 'thread/start': { const id = randomUUID(); touch(id); threads.set(id, cfg); return ok({ thread: { id } }); }
      case 'thread/resume': if (!known(p.threadId)) return out({ id: m.id, error: { code: -32000, message: 'no such thread' } }); if (!threads.has(p.threadId)) threads.set(p.threadId, { ...cfg, resumed: true }); return ok({ thread: { id: p.threadId } });
      case 'turn/start': {
        // 每一轮带来的权限和模型覆盖开线程时的。
        const cur = threads.get(p.threadId);
        if (p.sandboxPolicy) cur.sandbox = { dangerFullAccess: 'danger-full-access', readOnly: 'read-only' }[p.sandboxPolicy.type];
        if (p.approvalPolicy) cur.approvalPolicy = p.approvalPolicy;
        if (p.model) cur.model = p.model;
        ok({ turn: { id: null } });
        return void turn(p.threadId, p.input.map((x) => x.text).join(''));
      }
      case 'turn/interrupt': { const f = hanging.get(p.threadId); hanging.delete(p.threadId); f?.(); return ok({}); }
      case 'model/list': return ok({ data: [{ id: 'gpt-x', displayName: 'GPT X', isDefault: true }, { id: 'gpt-x-mini', displayName: 'GPT X mini' }] });
      default: if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'method not found' } });
    }
  });
}

// ---------- Claude Code ----------
if (mode === 'claude') {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const resumed = arg('--resume');
  if (resumed && !known(resumed)) { console.error('No conversation found with session ID'); process.exit(1); }
  const session = resumed ?? randomUUID();
  touch(session);
  // 真的 claude 收到结束信号后要过一会儿才退出：改权限、换模型时旧进程的退出不能误伤新进程的那一轮。
  process.on('SIGTERM', () => setTimeout(() => process.exit(143), 300));
  const cfg = { model: arg('--model'), mode: arg('--permission-mode'), promptTool: arg('--permission-prompt-tool'), disallowed: argv.includes('--disallowedTools'), resumed: !!resumed };
  lines(async (m) => {
    if (m.type === 'control_response') { waiting.get(m.response.request_id)?.(m.response.response); waiting.delete(m.response.request_id); return; }
    if (m.type === 'control_request' && m.request.subtype === 'interrupt') { const f = hanging.get(session); hanging.delete(session); f?.(); return; }
    if (m.type !== 'user') return;
    out({ type: 'system', subtype: 'init', session_id: session });
    let reply = next(session, m.message.content.map((c) => c.text).join(''), cfg);
    if (reply === 'SLOW') { hanging.set(session, () => out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session })); return; }
    if (reply === 'PERM') {
      if (cfg.mode === 'bypassPermissions') reply = 'perm=allow';
      else if (cfg.promptTool !== 'stdio') reply = 'perm=deny';
      else {
        const request_id = `req-${rid++}`;
        out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } } });
        const r = await new Promise((res) => waiting.set(request_id, res));
        reply = `perm=${r?.behavior === 'allow' ? 'allow' : 'deny'}`;
      }
    }
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session });
  });
}
