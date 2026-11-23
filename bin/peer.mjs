#!/usr/bin/env node
// peer：团队中心的命令行入口。团队中心没在跑时会自动启动。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_PORT, TOKEN_FILE } from '../src/hub/paths.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hub', 'hub.mjs');
const BASE = `http://127.0.0.1:${PEER_PORT}`;
const USAGE = `peer：让 Claude Code、codex、agy 在一个团队群里协作

团队
  peer new <团队> [--cwd 目录]            新建团队（工作目录默认是当前目录）
  peer rm <团队>                          删除团队和它的聊天记录
  peer status                             所有团队和成员的状态
成员
  peer add <团队> <claude|codex|agy> [--name 名字] [--model 模型] [--perm full|readonly|ask]
  peer kick <团队> <成员>                 移出团队
  peer set <团队> <成员> [--model 模型] [--perm 权限]
  peer clear <团队> <成员>                清空这个成员在本群的记忆
  peer lead <团队> <成员>                 指定主理人
  peer models <claude|codex|agy>          这种 agent 能选的模型
对话
  peer say <团队> <消息...> [--no-wait]   发消息并等大家说完；@成员、@all agents、不 @ 则交给主理人
  peer watch <团队>                       一直看着这个群
  peer log <团队> [-n 条数]               看聊天记录
  peer stop <团队>                        打断正在进行的讨论
  peer continue <团队>                    到轮数上限后再给一批
  peer rounds <团队> <数字>               自动讨论的轮数上限
  peer allow|deny <团队> <请求编号>       回答成员的权限请求（权限为 ask 时）
其他
  peer start | peer shutdown              启动 / 关闭团队中心`;

const token = () => { try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };

async function api(method, path, data) {
  const r = await fetch(BASE + path, {
    method, headers: { 'x-peer-token': token(), 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const o = await r.json();
  if (!o.ok) throw new Error(o.error);
  return o;
}

async function alive() { try { await api('GET', '/api/state'); return true; } catch (e) { if (e.cause || /fetch failed/.test(e.message)) return false; throw e; } }

async function ensureHub() {
  if (await alive()) return;
  spawn(process.execPath, [HUB], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); if (await alive()) return; }
  throw new Error(`团队中心没能启动。手动运行看报错：node ${HUB}`);
}

// 读事件流，每个事件调一次 fn；fn 返回 true 就结束。
async function events(fn, onOpen) {
  const r = await fetch(`${BASE}/api/events`, { headers: { 'x-peer-token': token() } });
  if (!r.ok) throw new Error('连不上事件流');
  await onOpen?.();
  let buf = '';
  const dec = new TextDecoder();
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!block.startsWith('data: ')) continue;
      if (await fn(JSON.parse(block.slice(6)))) { reader.cancel().catch(() => {}); return; }
    }
  }
}

const time = (ts) => new Date(ts).toLocaleTimeString('sv-SE').slice(0, 5);
function printMsg(m) {
  if (m.from === 'system') console.log(`  — ${m.text}`);
  else console.log(`\n[${m.from}${m.seconds ? ` · ${m.seconds}s` : ''} · ${time(m.ts)}]\n${m.text}`);
}
function printAsks(v, shown) {
  for (const a of v.asks) {
    if (shown.has(a.id)) continue;
    shown.add(a.id);
    console.log(`\n  ? ${a.member} 请求：${a.title}\n    同意：peer allow ${v.name} ${a.id}    拒绝：peer deny ${v.name} ${a.id}`);
  }
}

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-wait') opt.noWait = true;
    else if (['--cwd', '--name', '--model', '--perm', '-n'].includes(a)) opt[a.replace(/^-+/, '')] = argv[++i];
    else pos.push(a);
  }
  return { pos, opt };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return console.log(USAGE);
  const { pos, opt } = parse(rest);
  const need = (i, what) => { if (!pos[i]) throw new Error(`缺少${what}。运行 peer help 看用法`); return pos[i]; };
  const T = () => `/api/teams/${encodeURIComponent(need(0, '团队名'))}`;
  const Mb = () => `${T()}/members/${encodeURIComponent(need(1, '成员名'))}`;

  if (cmd === 'shutdown') {
    if (!(await alive())) return console.log('团队中心没有在运行');
    await api('POST', '/api/shutdown');
    return console.log('团队中心已关闭');
  }
  await ensureHub();

  switch (cmd) {
    case 'start': return console.log(`团队中心在运行：${BASE}`);
    case 'status': {
      const { teams } = await api('GET', '/api/state');
      if (!teams.length) return console.log('还没有团队。peer new <团队名> 建一个');
      for (const t of teams) {
        console.log(`${t.name}　${t.cwd}　上限 ${t.maxRounds} 轮${t.paused ? '　已到上限，等 continue' : ''}`);
        for (const m of t.members) console.log(`  ${m.name === t.lead ? '★' : ' '} ${m.name}　${m.kind}　${m.model ?? '默认模型'}　${m.permission}　${m.status === 'running' ? '发言中' : t.queue.includes(m.name) ? '排队' : '空闲'}`);
      }
      return;
    }
    case 'new': { const { team } = await api('POST', '/api/teams', { name: need(0, '团队名'), cwd: resolve(opt.cwd ?? process.cwd()) }); return console.log(`已建团队 ${team.name}，工作目录 ${team.cwd}`); }
    case 'rm': await api('DELETE', T()); return console.log(`已删除团队 ${pos[0]}`);
    case 'add': await api('POST', `${T()}/members`, { kind: need(1, ' agent 类型'), name: opt.name, model: opt.model, permission: opt.perm }); return console.log(`${opt.name ?? pos[1]} 已加入 ${pos[0]}`);
    case 'kick': await api('DELETE', Mb()); return console.log(`${pos[1]} 已移出 ${pos[0]}`);
    case 'set': {
      const patch = {};
      if (opt.model !== undefined) patch.model = opt.model;
      if (opt.perm !== undefined) patch.permission = opt.perm;
      if (!Object.keys(patch).length) throw new Error('要改什么？--model 模型 或 --perm 权限');
      await api('PATCH', Mb(), patch);
      return console.log(`${pos[1]} 已更新`);
    }
    case 'clear': await api('POST', `${Mb()}/clear`); return console.log(`${pos[1]} 在 ${pos[0]} 的记忆已清空`);
    case 'lead': await api('PATCH', T(), { lead: need(1, '成员名') }); return console.log(`${pos[0]} 的主理人是 ${pos[1]}`);
    case 'rounds': await api('PATCH', T(), { maxRounds: Number(need(1, '轮数')) }); return console.log(`${pos[0]} 的自动讨论上限是 ${pos[1]} 轮`);
    case 'models': { const { models } = await api('GET', `/api/models/${need(0, ' agent 类型')}`); for (const m of models) console.log(`${m.id}${m.name && m.name !== m.id ? `　${m.name}` : ''}${m.isDefault ? '　（默认）' : ''}`); return; }
    case 'stop': await api('POST', `${T()}/stop`); return console.log('已打断');
    case 'continue': await api('POST', `${T()}/continue`); return console.log('继续');
    case 'allow': case 'deny': await api('POST', `${T()}/asks/${need(1, '请求编号')}`, { allow: cmd === 'allow' }); return console.log(cmd === 'allow' ? '已同意' : '已拒绝');
    case 'log': {
      const { messages } = await api('GET', `${T()}/messages`);
      for (const m of messages.slice(-(Number(opt.n) || 30))) printMsg(m);
      return;
    }
    case 'say': case 'watch': {
      const { team } = await api('GET', T());
      const text = pos.slice(1).join(' ');
      if (cmd === 'say' && !text) throw new Error('要说什么？peer say <团队> <消息>');
      if (cmd === 'say' && opt.noWait) { await api('POST', `${T()}/messages`, { text }); return; }
      const shown = new Set();
      let posted = cmd === 'watch';
      let view = team;
      const idle = () => cmd === 'say' && posted && !view.running && (view.paused || !view.queue.length);
      await events((ev) => {
        if (ev.team !== team.id) return false;
        if (ev.type === 'message') printMsg(ev.data);
        else if (ev.type === 'tool') console.log(`  · ${ev.member}：${ev.title}`);
        else if (ev.type === 'team') { view = ev.data; printAsks(view, shown); }
        else if (ev.type === 'team-removed') return true;
        return idle();
      }, async () => {
        if (cmd !== 'say') return;
        await api('POST', `${T()}/messages`, { text });
        view = (await api('GET', T())).team;
        posted = true;
        if (idle()) process.exit(0);
      });
      return;
    }
    default: throw new Error(`不认识的命令 ${cmd}。运行 peer help 看用法`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(`peer：${e.message}`); process.exit(1); });
