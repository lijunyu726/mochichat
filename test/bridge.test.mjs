// 全部用假 agy 跑，不调用模型。每个测试一个独立的 AGYC_HOME 和常驻程序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const AGYC = fileURLToPath(new URL('../bin/agyc.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url));

function bridge(t, extraEnv = {}) {
  const home = mkdtempSync('/tmp/agyc-');
  const env = { ...process.env, AGYC_HOME: home, AGYC_AGY_BIN: FAKE, ...extraEnv };
  const start = (args, { input, envMore } = {}) => {
    const child = spawn(process.execPath, [AGYC, ...args], { env: { ...env, ...envMore }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })));
    return { child, done };
  };
  const run = (args, opts) => start(args, opts).done;
  t.after(async () => { await run(['stop']); rmSync(home, { recursive: true, force: true }); });
  return { home, run, start };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('同一会话多轮保留上下文，只有第一条带协作说明', async (t) => {
  const { run } = bridge(t);
  const a = await run(['ask', 'hello one']);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /^echo#1 primer=1 tail=[^]*hello one$/);
  const b = await run(['ask', 'hello two']);
  assert.match(b.stdout, /^echo#2 primer=0 tail=hello two$/);
  const c = await run(['ask', '-s', 'other', 'x']);
  assert.match(c.stdout, /^echo#1 primer=1/);
});

test('消息可以从标准输入读，特殊字符原样送达', async (t) => {
  const { run } = bridge(t);
  const text = '引号" 反斜杠\\ <标签> 🙂 `ls`';
  const r = await run(['ask', '-'], { input: text });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.endsWith(`tail=${text.slice(-20)}`), r.stdout);
});

test('权限：读取默认放行，执行默认拒绝，--allow 后放行', async (t) => {
  const { run } = bridge(t);
  assert.equal((await run(['ask', 'PERM:read'])).stdout, 'perm=selected:yes');
  const denied = await run(['ask', 'PERM:execute']);
  assert.equal(denied.stdout, 'perm=selected:no');
  assert.match(denied.stderr, /已拒绝 agy 的操作（execute）.*--allow execute/);
  assert.equal((await run(['ask', '--allow', 'execute', 'PERM:execute'])).stdout, 'perm=selected:yes');
  assert.equal((await run(['ask', '--allow', 'all', 'PERM:delete'])).stdout, 'perm=selected:yes');
  const q = await run(['ask', '--allow', 'all', 'PERM:question']);
  assert.equal(q.stdout, 'perm=cancelled:');
  assert.match(q.stderr, /交互式提问被取消/);
});

test('超时会取消这一轮并返回已收到的部分', async (t) => {
  const { run } = bridge(t);
  const r = await run(['ask', '--timeout', '1', 'SLOW']);
  assert.equal(r.code, 4);
  assert.equal(r.stdout, 'partial');
  assert.match(r.stderr, /已取消：timeout/);
  assert.match((await run(['ask', 'after'])).stdout, /^echo#2/); // 会话没有卡在忙碌状态
});

test('调用方中途退出，这一轮被取消，会话可以继续用', async (t) => {
  const { run, start } = bridge(t);
  const p = start(['ask', '--timeout', '0', 'SLOW']);
  await sleep(600);
  p.child.kill();
  await p.done;
  await sleep(300);
  assert.match((await run(['ask', 'after'])).stdout, /^echo#2/);
});

test('常驻程序重启后按编号恢复会话，回放的历史不混进回答', async (t) => {
  const { run } = bridge(t);
  await run(['ask', 'one']);
  await run(['stop']); // 不等待：stop 之后立刻 ask 也必须落到新的常驻程序上
  const r = await run(['ask', 'two']);
  assert.match(r.stdout, /^echo#2 primer=0/, r.stderr);
  assert.match(r.stderr, /已按编号恢复/);
});

test('agy 进程被杀后自动重启并恢复会话', async (t) => {
  const { run } = bridge(t);
  await run(['ask', 'one']);
  const st = JSON.parse((await run(['status'])).stdout);
  process.kill(st.agyPid);
  await sleep(300);
  const r = await run(['ask', 'two']);
  assert.match(r.stdout, /^echo#2/, r.stderr);
  assert.match(r.stderr, /已按编号恢复/);
});

test('会话恢复失败时新建并明确告知', async (t) => {
  const { run } = bridge(t);
  await run(['ask', 'one']);
  await run(['stop']);
  await sleep(300);
  const r = await run(['ask', 'two'], { envMore: { FAKE_LOAD_FAIL: '1' } });
  assert.match(r.stdout, /^echo#1 primer=1/);
  assert.match(r.stderr, /之前的上下文不在了/);
});

test('外面的 agy 来信：wait 收到，reply 原样送回 tell', async (t) => {
  const { run, start } = bridge(t);
  const w = start(['wait']);
  await sleep(400);
  const text = '带引号" 和 <标签> 的问题';
  const tell = start(['tell', '--from', 'agy-terminal', text]);
  const got = await w.done;
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stdout, /^\[agy 来信 m1 · 来自 agy-terminal\]\n带引号" 和 <标签> 的问题\n/);
  const answer = '回答 "原样" \\ 🙂';
  assert.equal((await run(['reply', 'm1', answer])).code, 0);
  const told = await tell.done;
  assert.equal(told.code, 0, told.stderr);
  assert.equal(told.stdout, answer);
});

test('来信先到、wait 后到，也能送达；重复回复会报错', async (t) => {
  const { run, start } = bridge(t);
  const tell = start(['tell', 'early']);
  await sleep(400);
  const got = await run(['wait']);
  assert.match(got.stdout, /来信 m1 · 来自 agy\]\nearly/);
  await run(['reply', 'm1', 'ok']);
  assert.equal((await tell.done).stdout, 'ok');
  const again = await run(['reply', 'm1', 'again']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /没有在等回复的消息 m1/);
});

test('没人监听时 tell 超时并说明未送达', async (t) => {
  const { run } = bridge(t);
  const r = await run(['tell', '--timeout', '1', 'anyone?']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Claude 没在监听，未送达/);
});

test('日志记录了问答和权限决定', async (t) => {
  const { run, home } = bridge(t);
  await run(['ask', 'PERM:execute']);
  const log = readFileSync(join(home, 'logs', 'main.log'), 'utf8');
  assert.match(log, />>> Claude：PERM:execute/);
  assert.match(log, /权限 execute：do execute → 拒绝/);
  assert.match(log, /<<< agy（end_turn）：perm=selected:no/);
});
