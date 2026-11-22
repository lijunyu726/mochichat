#!/usr/bin/env node
// 测试用的假 agy：只实现桥用到的 ACP 方法，不调用任何模型。
// 会话的轮数写在 AGYC_HOME/fake-state.json，所以进程重启后 session/load 能恢复。
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (process.argv[2] !== 'acp') { console.error('fake agy only supports: acp'); process.exit(2); }
const STATE = join(process.env.AGYC_HOME, 'fake-state.json');
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const save = (s) => writeFileSync(STATE, JSON.stringify(s));

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const live = new Set();
const slow = new Map(); // 会话 id -> 结束这一轮的函数
const waiting = new Map(); // 发给客户端的请求 id -> 回调
let reqId = 1000;

function chunk(sessionId, text) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
}

async function prompt(id, { sessionId, prompt }) {
  if (!live.has(sessionId)) return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown session' } });
  const text = prompt.map((p) => p.text).join('');
  const state = load();
  const n = (state[sessionId] = (state[sessionId] ?? 0) + 1);
  save(state);
  const done = (stopReason = 'end_turn') => send({ jsonrpc: '2.0', id, result: { stopReason } });

  if (text.includes('SLOW')) { chunk(sessionId, 'partial'); slow.set(sessionId, () => done('cancelled')); return; }

  const perm = text.match(/PERM:(\w+)/);
  if (perm) {
    const rid = reqId++;
    const toolCallId = perm[1] === 'question' ? 'interaction_1' : 'call_1';
    send({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params: {
      sessionId, toolCall: { toolCallId, title: `do ${perm[1]}`, kind: perm[1] === 'question' ? undefined : perm[1] },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    } });
    const outcome = await new Promise((r) => waiting.set(rid, r));
    chunk(sessionId, `perm=${outcome.outcome}:${outcome.optionId ?? ''}`);
    return done();
  }

  chunk(sessionId, `echo#${n} primer=${text.includes('[协作说明]') ? 1 : 0} `);
  chunk(sessionId, `tail=${text.slice(-20)}`);
  done();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result?.outcome ?? {}); waiting.delete(m.id); return; }
  switch (m.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Fake agy', version: '0.0.0' }, agentCapabilities: { loadSession: true } } });
    case 'session/new': {
      const sessionId = randomUUID();
      live.add(sessionId);
      return send({ jsonrpc: '2.0', id: m.id, result: { sessionId } });
    }
    case 'session/load': {
      const { sessionId } = m.params;
      if (load()[sessionId] === undefined || process.env.FAKE_LOAD_FAIL) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'no such session' } });
      live.add(sessionId);
      chunk(sessionId, 'REPLAYED-HISTORY'); // 回放的历史，桥应当忽略
      return send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
    case 'session/prompt': return void prompt(m.id, m.params);
    case 'session/cancel': { const f = slow.get(m.params.sessionId); slow.delete(m.params.sessionId); f?.(); return; }
    default:
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
