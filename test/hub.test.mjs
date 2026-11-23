// 团队中心的测试：三种成员都用假 agent，不调用模型。每个测试一个独立的 MOCHI_HOME、端口和团队中心。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MOCHI = fileURLToPath(new URL('../bin/mochi.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
let nextPort = 21000 + Math.floor(Math.random() * 20000);

function hub(t) {
  const home = mkdtempSync('/tmp/mochi-');
  const port = nextPort++;
  const env = { ...process.env, MOCHI_HOME: home, MOCHI_WORKSPACE: join(home, 'workspace'), MOCHI_PORT: String(port), MOCHI_CLAUDE_BIN: FAKE, MOCHI_CODEX_BIN: FAKE, MOCHI_AGY_BIN: FAKE };
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [MOCHI, ...args], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
  const ok = async (...args) => { const r = await run(...args); assert.equal(r.code, 0, `mochi ${args.join(' ')} 失败：${r.stderr}`); return r.stdout; };
  const api = async (method, path, data) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-mochi-token': readFileSync(join(home, 'token'), 'utf8').trim() }, body: data && JSON.stringify(data) });
    return r.json();
  };
  t.after(async () => { await run('shutdown'); rmSync(home, { recursive: true, force: true }); });
  return {
    home, port, run, ok, api,
    script: (o) => writeFileSync(join(home, 'fake-script.json'), JSON.stringify(o)),
    log: () => { try { return readFileSync(join(home, 'fake-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    // 群里的发言（不含系统提示），形如 ['用户: …', 'codex: …']
    talk: () => {
      const dir = join(home, 'messages');
      return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((m) => m.from !== 'system').map((m) => `${m.from}: ${m.text}`);
    },
    // 最后一条消息，系统提示也算
    last: () => {
      const dir = join(home, 'messages');
      const m = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).at(-1);
      return `${m.from}: ${m.text}`;
    },
    team: async (name) => (await api('GET', `/api/teams/${encodeURIComponent(name)}`)).team,
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } assert.fail(`等不到：${what}`); }

async function trio(h) {
  await h.ok('new', '店序');
  await h.ok('add', '店序', 'codex');
  await h.ok('add', '店序', 'agy');
  await h.ok('add', '店序', 'claude');
}

test('不 @ 时交给主理人；主理人叫了人，对方答完交回主理人收尾', async (t) => {
  const h = hub(t);
  await trio(h);
  assert.equal((await h.team('店序')).lead, 'claude', '默认主理人是 Claude，哪怕它不是第一个加入的');
  h.script({ claude: ['我倾向 session。@codex 跑一下测试', '结论：用 session'], codex: ['42 个通过'] });
  await h.ok('say', '店序', '登录用', 'session', '还是', 'JWT？');
  assert.deepEqual(h.talk(), ['用户: 登录用 session 还是 JWT？', 'claude: 我倾向 session。@codex 跑一下测试', 'codex: 42 个通过', 'claude: 结论：用 session']);
  const log = h.log();
  assert.deepEqual(log.map((l) => l.name), ['claude', 'codex', 'claude'], 'agy 没被叫到，不发言');
  assert.match(log[0].prompt, /\[群规\]/);
  assert.match(log[0].prompt, /你是主理人/);
  assert.match(log[1].prompt, /【用户】登录用 session 还是 JWT？[\s\S]*【claude】我倾向 session/, '被叫的成员能看到之前的全部消息');
  assert.doesNotMatch(log[2].prompt, /\[群规\]/, '群规只在第一次给');
  assert.match(log[2].prompt, /【codex】42 个通过[\s\S]*已经回答了你刚才的请求/);
  assert.doesNotMatch(log[2].prompt, /登录用 session/, '看过的消息不重复给');
  assert.doesNotMatch(log[1].prompt, /思考中/);
});

test('@成员 只发给它；@all agents 全体发言，主理人最后说并收尾', async (t) => {
  const h = hub(t);
  await trio(h);
  await h.ok('say', '店序', '@agy', '你好');
  assert.deepEqual(h.talk(), ['用户: @agy 你好', 'agy: agy#1']);
  await h.ok('say', '店序', '@all agents', '各自说说');
  assert.deepEqual(h.talk().slice(2), ['用户: @all agents 各自说说', 'codex: codex#1', 'agy: agy#2', 'claude: claude#1']);
  const lead = h.log().at(-1);
  assert.match(lead.prompt, /【codex】codex#1[\s\S]*【agy】agy#2[\s\S]*综合大家的回答/);
});

test('成员互相叫个不停时，到轮数上限停下，continue 再给一批', async (t) => {
  const h = hub(t);
  await trio(h);
  await h.ok('rounds', '店序', '2');
  h.script({ claude: ['@codex 一', '@codex 三', '@codex 五'], codex: ['@claude 二', '@claude 四', '收工'] });
  const out = await h.ok('say', '店序', '开始');
  assert.match(out, /已自动讨论 2 轮，到上限了/);
  assert.deepEqual(h.talk(), ['用户: 开始', 'claude: @codex 一', 'codex: @claude 二']);
  assert.equal((await h.team('店序')).paused, true);
  await h.ok('say', '店序', '继续');
  assert.deepEqual(h.talk().slice(3), ['claude: @codex 三', 'codex: @claude 四']);
  await h.ok('continue', '店序');
  await until(async () => h.talk().length === 7 && (await h.team('店序')).paused, '第三批说完');
  assert.deepEqual((await h.team('店序')).queue, ['claude'], '交回主理人的那一轮也算轮数，排着等 continue');
  await h.ok('continue', '店序');
  await until(async () => { const v = await h.team('店序'); return !v.running && !v.queue.length; }, '讨论结束');
  assert.deepEqual(h.talk().slice(5), ['claude: @codex 五', 'codex: 收工', 'claude: claude#4'], '被叫的人答完交回，交回后不再循环');
});

test('同一种 agent 进两个群，各有各的会话；团队中心重启后接着原来的会话', async (t) => {
  const h = hub(t);
  for (const team of ['甲', '乙']) { await h.ok('new', team); for (const k of ['claude', 'codex', 'agy']) await h.ok('add', team, k); }
  await h.ok('say', '甲', '@all agents', '甲群的秘密');
  await h.ok('say', '乙', '@all agents', '乙群的事');
  const log = h.log();
  for (const k of ['claude', 'codex', 'agy']) {
    const [a, b] = log.filter((l) => l.kind === k);
    assert.notEqual(a.session, b.session, `${k} 在两个群里是两个会话`);
    assert.doesNotMatch(b.prompt, /甲群的秘密/);
  }
  await h.ok('shutdown');
  await h.ok('say', '甲', '@all agents', '还记得吗');
  for (const k of ['claude', 'codex', 'agy']) {
    const mine = h.log().filter((l) => l.kind === k && /甲群的秘密|还记得吗/.test(l.prompt));
    assert.equal(mine[0].session, mine[1].session, `${k} 重启后接回原会话`);
    assert.doesNotMatch(mine[1].prompt, /\[群规\]/);
  }
});

test('权限默认全部放行；ask 时要用户点头；readonly 直接拒绝', async (t) => {
  const h = hub(t);
  await trio(h);
  for (const k of ['claude', 'codex', 'agy']) {
    h.script({ [k]: ['PERM', 'PERM', 'PERM', 'PERM'] });
    await h.ok('say', '店序', `@${k}`, '清一下');
    assert.equal(h.talk().at(-1), `${k}: perm=allow`, `${k} 默认最高权限`);

    await h.ok('set', '店序', k, '--perm', 'readonly');
    await h.ok('say', '店序', `@${k}`, '清一下');
    // agy 的操作被拒绝后整轮不说话，群里给一条系统提示说明原因。
    const denied = (perm) => (k === 'agy' ? `system: agy 想做“rm -rf build”，被它现在的权限（${perm}）拒绝了，这一轮没有回答` : `${k}: perm=deny`);
    assert.equal(h.last(), denied('readonly'), `${k} 只读时拒绝`);

    await h.ok('set', '店序', k, '--perm', 'ask');
    for (const [answer, want] of [['allow', `${k}: perm=allow`], ['deny', denied('ask')]]) {
      const said = h.ok('say', '店序', `@${k}`, '清一下');
      let ask;
      await until(async () => (ask = (await h.team('店序')).asks[0]), `${k} 的权限请求`);
      assert.equal(ask.member, k);
      assert.match(ask.title, /rm -rf build/);
      await h.ok(answer, '店序', ask.id);
      assert.match(await said, /请求：.*rm -rf build/);
      assert.equal(h.last(), want);
    }
    const mine = h.log().filter((l) => l.kind === k);
    assert.equal(new Set(mine.map((l) => l.session)).size, 1, `${k} 改权限不丢会话`);
  }
});

test('改模型下一轮生效；清空记忆后是新会话；踢出后不再能 @', async (t) => {
  const h = hub(t);
  await trio(h);
  assert.match(await h.ok('models', 'codex'), /gpt-x-mini/);
  assert.match(await h.ok('models', 'agy'), /g-fast/);
  await h.ok('add', '店序', 'codex', '--name', '小C', '--model', 'gpt-x-mini');
  await h.ok('say', '店序', '@小C', '在吗');
  assert.equal(h.log().at(-1).model, 'gpt-x-mini');
  for (const [k, model] of [['claude', 'claude-haiku-5-5'], ['codex', 'gpt-x-mini'], ['agy', 'g-fast']]) {
    await h.ok('say', '店序', `@${k}`, '第一句');
    await h.ok('say', '店序', `/model ${k} ${model}`);
    await h.ok('say', '店序', `@${k}`, '第二句');
    const [a, b] = h.log().filter((l) => l.name === k);
    assert.equal(a.model, null);
    assert.equal(b.model, model);
    assert.equal(a.session, b.session, `${k} 换模型不丢会话`);
    await h.ok('clear', '店序', k);
    await h.ok('say', '店序', `@${k}`, '第三句');
    const c = h.log().filter((l) => l.name === k)[2];
    assert.notEqual(c.session, a.session);
    assert.match(c.prompt, /\[群规\]/);
    assert.doesNotMatch(c.prompt, /第一句|第二句/, '清空后看不到之前的消息');
  }
  await h.ok('kick', '店序', 'agy');
  const before = h.log().length;
  await h.ok('say', '店序', '@agy', '还在吗');
  assert.equal(h.log().at(-1).name, 'claude', '@ 不到人就交给主理人');
  assert.equal(h.log().length, before + 1);
  const r = await h.run('add', '店序', 'gemini');
  assert.match(r.stderr, /不认识的 agent 类型/);
});

test('stop 能打断正在说话的成员', async (t) => {
  const h = hub(t);
  await trio(h);
  for (const k of ['claude', 'codex', 'agy']) {
    h.script({ [k]: ['SLOW'] });
    const said = h.ok('say', '店序', `@${k}`, '慢慢想');
    await until(async () => (await h.team('店序')).running === k && h.log().some((l) => l.name === k), `${k} 开始发言`);
    await h.ok('stop', '店序');
    assert.match(await said, new RegExp(`${k} 的发言被打断了`));
    assert.equal((await h.team('店序')).running, null);
  }
});

test('没有口令或 Host 不是本机的请求被拒绝', async (t) => {
  const h = hub(t);
  await h.ok('new', '店序');
  const base = `http://127.0.0.1:${h.port}/api/state`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers: { 'x-mochi-token': 'x'.repeat(48) } })).status, 401);
  assert.equal((await h.api('GET', '/api/state')).ok, true);
});

test('工作目录是 git 仓库时每个成员一个自己的 worktree；不是仓库就共用；不给目录放进默认工作区', async (t) => {
  const h = hub(t);
  const repo = join(h.home, 'repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  mkdirSync(join(repo, 'sub'), { recursive: true });
  writeFileSync(join(repo, 'sub', 'a.txt'), 'a\n');
  execFileSync('git', ['init', '-q', repo]);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');

  // 团队的工作目录是仓库里的子目录：成员待在自己 worktree 的同一个子目录里
  await h.ok('new', '隔离', '--cwd', join(repo, 'sub'));
  await h.ok('add', '隔离', 'claude');
  await h.ok('add', '隔离', 'codex');
  const team = await h.team('隔离');
  assert.equal(team.isolation, 'worktree');
  const [a, b] = team.members;
  assert.notEqual(a.dir, b.dir);
  assert.equal(a.branch, `mochi/${team.id}/claude`);
  assert.equal(readFileSync(join(a.dir, 'a.txt'), 'utf8'), 'a\n');
  assert.match(git('branch', '--list', 'mochi/*'), /codex/);
  await h.ok('say', '隔离', '@claude', '看一下');
  const first = h.log().at(-1);
  assert.equal(first.cwd, realpathSync(a.dir), '成员进程在自己的 worktree 里运行');
  assert.match(first.prompt, new RegExp(`你的分支是 mochi/${team.id}/claude`));

  // 有没提交的改动：移出时留着目录；干净的：移出时收掉。分支都保留
  writeFileSync(join(a.dir, 'draft.txt'), '没提交\n');
  await h.ok('kick', '隔离', 'claude');
  await h.ok('kick', '隔离', 'codex');
  assert.ok(existsSync(join(a.dir, 'draft.txt')), '没提交的改动不能丢');
  assert.ok(!existsSync(b.dir));
  assert.match(h.last(), /codex 被移出了团队，它的分支 mochi\//);
  assert.match(git('branch', '--list', 'mochi/*'), /claude[\s\S]*codex/);

  // 不是 git 仓库：共用；硬要 worktree 报错
  const plain = (await h.api('POST', '/api/teams', { name: '默认' })).team;
  assert.equal(plain.cwd, join(h.home, 'workspace', '默认'));
  assert.equal(plain.isolation, 'shared');
  const bad = await h.api('POST', '/api/teams', { name: '不行', cwd: h.home, isolation: 'worktree' });
  assert.match(bad.error, /不是有提交记录的 git 仓库/);
  const shared = (await h.api('POST', '/api/teams', { name: '共用', cwd: repo, isolation: 'shared' })).team;
  assert.equal(shared.isolation, 'shared');
});

test('全局设置只影响新团队和新成员；团队说明进群规，改了以后成员下一轮补看', async (t) => {
  const h = hub(t);
  await h.ok('status');
  const bad = await h.api('PATCH', '/api/settings', { permission: 'root' });
  assert.match(bad.error, /权限只能是/);
  const ws = join(h.home, 'ws2');
  const { settings } = await h.api('PATCH', '/api/settings', { workspace: ws, permission: 'readonly', maxRounds: 3, models: { codex: 'm-x' } });
  assert.deepEqual(settings, { workspace: ws, permission: 'readonly', maxRounds: 3, models: { codex: 'm-x' } });
  const team = (await h.api('POST', '/api/teams', { name: '新队' })).team;
  assert.equal(team.cwd, join(ws, '新队'));
  assert.equal(team.maxRounds, 3);
  await h.ok('add', '新队', 'codex');
  await h.ok('add', '新队', 'claude', '--perm', 'full');
  const m = (await h.team('新队')).members;
  assert.deepEqual([m[0].permission, m[0].model, m[1].permission, m[1].model], ['readonly', 'm-x', 'full', null]);

  await h.api('PATCH', `/api/teams/${team.id}`, { brief: '回答用中文', name: '改名队' });
  await h.ok('say', '改名队', '@codex', '你好');
  assert.match(h.log().at(-1).prompt, /\[团队说明\][\s\S]*回答用中文/);
  await h.api('PATCH', `/api/teams/${team.id}`, { brief: '先跑测试' });
  await h.ok('say', '改名队', '@codex', '再来');
  assert.match(h.log().at(-1).prompt, /\[团队说明更新\][\s\S]*先跑测试/);
  await h.ok('say', '改名队', '@codex', '第三次');
  assert.doesNotMatch(h.log().at(-1).prompt, /团队说明/, '说明只补看一次');
  // 重启后设置还在
  await h.ok('shutdown');
  assert.equal((await h.run('status')).code, 0);
  assert.equal((await h.api('GET', '/api/settings')).settings.maxRounds, 3);
});
