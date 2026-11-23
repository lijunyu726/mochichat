// 团队（群）的规则：成员增删、消息、@ 的去向、轮流发言、交回、轮数上限。
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKSPACE } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import { createSession, KINDS, PERMISSIONS } from './backends.mjs';

const USER = '用户';
const DEFAULT_ROUNDS = 8;
const HISTORY_CAP = 40; // 一次最多给成员补看这么多条旧消息

export class Rooms {
  teams = new Map(); // id -> team
  // dir：数据目录；emit(event)：把事件推给所有在看的页面和命令
  constructor(dir, emit) {
    this.dir = dir;
    this.emit = emit;
    mkdirSync(join(dir, 'messages'), { recursive: true });
    // 全局设置：只影响以后新建的团队和新加的成员，不改已有的。
    this.settings = { workspace: WORKSPACE, permission: 'full', maxRounds: DEFAULT_ROUNDS, models: {} };
    try { Object.assign(this.settings, JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))); } catch { /* 还没改过设置 */ }
    try {
      for (const t of JSON.parse(readFileSync(join(dir, 'teams.json'), 'utf8'))) {
        const all = this.messages(t.id);
        this.teams.set(t.id, { ...t, seq: all.at(-1)?.seq ?? 0, last: preview(all.at(-1)), run: newRun(), members: t.members.map((m) => ({ ...m, session: null, status: 'idle' })) });
      }
    } catch { /* 第一次运行 */ }
  }

  updateSettings(patch) {
    const s = { ...this.settings };
    if (patch.workspace !== undefined) {
      const w = String(patch.workspace).trim();
      if (!w.startsWith('/')) throw new Error('默认工作区要写完整路径（以 / 开头）');
      s.workspace = w;
    }
    if (patch.permission !== undefined) {
      if (!PERMISSIONS.includes(patch.permission)) throw new Error(`权限只能是 ${PERMISSIONS.join('、')}`);
      s.permission = patch.permission;
    }
    if (patch.maxRounds !== undefined) {
      const n = Number(patch.maxRounds);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('轮数上限要是 1 到 100 的整数');
      s.maxRounds = n;
    }
    if (patch.models !== undefined) {
      s.models = { ...s.models };
      for (const [k, v] of Object.entries(patch.models)) {
        if (!KINDS.includes(k)) throw new Error(`不认识的 agent 类型 ${k}`);
        if (v) s.models[k] = String(v); else delete s.models[k];
      }
    }
    this.settings = s;
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify(s, null, 2));
    this.emit({ type: 'settings', data: s });
    return s;
  }

  // ---------- 存取 ----------
  #save() {
    const out = [...this.teams.values()].map((t) => ({
      id: t.id, name: t.name, cwd: t.cwd, isolation: t.isolation ?? 'shared', lead: t.lead, maxRounds: t.maxRounds, brief: t.brief ?? '',
      members: t.members.map((m) => ({ dir: m.dir ?? null, tree: m.tree ?? null, branch: m.branch ?? null, name: m.name, kind: m.kind, model: m.model, permission: m.permission, sessionId: m.session?.id ?? m.sessionId ?? null, primed: m.primed, seen: m.seen, briefStale: m.briefStale || undefined })),
    }));
    writeFileSync(join(this.dir, 'teams.json'), JSON.stringify(out, null, 2));
  }
  #file(id) { return join(this.dir, 'messages', `${id}.jsonl`); }
  messages(id, after = 0) {
    try { return readFileSync(this.#file(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.seq > after); }
    catch { return []; }
  }

  team(ref) {
    const t = this.teams.get(ref) ?? [...this.teams.values()].find((x) => x.name === ref);
    if (!t) throw new Error(`没有叫 ${ref} 的团队`);
    return t;
  }
  member(t, name) {
    const m = t.members.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!m) throw new Error(`团队 ${t.name} 里没有成员 ${name}`);
    return m;
  }
  view(t) {
    return {
      id: t.id, name: t.name, cwd: t.cwd, lead: t.lead, maxRounds: t.maxRounds, rounds: t.run.rounds, paused: t.run.paused,
      seq: t.seq, last: t.last ?? null, isolation: t.isolation ?? 'shared', brief: t.brief ?? '',
      running: t.run.current?.member.name ?? null, queue: t.run.queue.map((q) => q.member.name),
      asks: [...t.run.asks.values()].map((a) => ({ id: a.id, member: a.member, title: a.title, kind: a.kind })),
      members: t.members.map((m) => ({ name: m.name, kind: m.kind, model: m.model, permission: m.permission, status: m.status, dir: m.dir ?? t.cwd, branch: m.branch ?? null })),
    };
  }
  state() { return [...this.teams.values()].map((t) => this.view(t)); }
  #changed(t) { this.#save(); this.emit({ type: 'team', team: t.id, data: this.view(t) }); }

  // ---------- 团队与成员 ----------
  // isolation：'worktree' 每个成员一个自己的 git worktree 和分支；'shared' 所有成员共用工作目录。
  // 不指定时：工作目录是有提交的 git 仓库就用 worktree，否则 shared。
  createTeam({ name, cwd, isolation }) {
    name = String(name ?? '').trim();
    if (!name) throw new Error('团队要有名字');
    if ([...this.teams.values()].some((t) => t.name === name)) throw new Error(`已经有叫 ${name} 的团队`);
    if (!cwd) {
      // 默认工作区：每个团队一个文件夹。
      cwd = join(this.settings.workspace, name.replace(/[\/\\:\0]/g, '_'));
      mkdirSync(cwd, { recursive: true });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
    const repo = gitRepo(cwd);
    if (isolation !== undefined && !['worktree', 'shared'].includes(isolation)) throw new Error('隔离方式只能是 worktree 或 shared');
    if (isolation === 'worktree' && !repo) throw new Error('这个目录不是有提交记录的 git 仓库，没法给成员各开一个 worktree');
    isolation ??= repo ? 'worktree' : 'shared';
    const t = { id: randomBytes(4).toString('hex'), name, cwd, isolation, lead: null, maxRounds: this.settings.maxRounds, brief: '', members: [], seq: 0, run: newRun() };
    this.teams.set(t.id, t);
    this.#changed(t);
    return t;
  }
  removeTeam(ref) {
    const t = this.team(ref);
    this.stop(t);
    for (const m of t.members) { m.session?.close(); this.#dropWorktree(t, m); }
    this.teams.delete(t.id);
    rmSync(this.#file(t.id), { force: true });
    this.#save();
    this.emit({ type: 'team-removed', team: t.id });
  }
  updateTeam(ref, patch) {
    const t = this.team(ref);
    if (patch.lead !== undefined) t.lead = this.member(t, patch.lead).name;
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('团队要有名字');
      if ([...this.teams.values()].some((x) => x !== t && x.name === name)) throw new Error(`已经有叫 ${name} 的团队`);
      t.name = name;
    }
    if (patch.brief !== undefined) {
      const brief = String(patch.brief).trim().slice(0, 4000);
      // 已经看过群规的成员，下一轮补看新的团队说明。
      if (brief !== (t.brief ?? '')) { t.brief = brief; for (const m of t.members) if (m.primed) m.briefStale = true; }
    }
    if (patch.maxRounds !== undefined) {
      const n = Number(patch.maxRounds);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('轮数上限要是 1 到 100 的整数');
      t.maxRounds = n;
    }
    this.#changed(t);
    return t;
  }
  addMember(ref, { kind, name, model, permission }) {
    const t = this.team(ref);
    if (!KINDS.includes(kind)) throw new Error(`不认识的 agent 类型 ${kind}（可用：${KINDS.join('、')}）`);
    name = String(name ?? kind).trim();
    if (!/^[\w一-龥-]{1,24}$/.test(name) || /^all$/i.test(name)) throw new Error('成员名只能用字母、数字、汉字、下划线和短横线，且不能叫 all');
    if (t.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new Error(`团队里已经有成员 ${name}，换个名字（--name）`);
    permission ??= this.settings.permission;
    model ||= this.settings.models[kind];
    if (!PERMISSIONS.includes(permission)) throw new Error(`权限只能是 ${PERMISSIONS.join('、')}`);
    const m = { name, kind, model: model || null, permission, sessionId: null, primed: false, seen: t.seq, session: null, status: 'idle' };
    if (t.isolation === 'worktree') Object.assign(m, this.#openWorktree(t, name));
    t.members.push(m);
    // 默认主理人：第一个 Claude；没有 Claude 就是第一个加入的成员。
    if (!t.lead || (kind === 'claude' && this.member(t, t.lead).kind !== 'claude')) t.lead = name;
    this.#post(t, 'system', `${name}（${kind}）加入了团队`);
    this.#changed(t);
    return m;
  }
  removeMember(ref, name) {
    const t = this.team(ref);
    const m = this.member(t, name);
    if (t.run.current?.member === m) m.session?.cancel();
    t.run.queue = t.run.queue.filter((q) => q.member !== m);
    m.removed = true;
    m.session?.close();
    t.members = t.members.filter((x) => x !== m);
    const kept = this.#dropWorktree(t, m);
    if (t.lead === m.name) t.lead = (t.members.find((x) => x.kind === 'claude') ?? t.members[0])?.name ?? null;
    this.#post(t, 'system', `${m.name} 被移出了团队` + (kept ? `。它的工作目录里有没提交的改动，保留在 ${kept}（分支 ${m.branch}）` : m.branch ? `，它的分支 ${m.branch} 还在` : ''));
    this.#changed(t);
  }
  // 给成员开一个自己的 worktree：<数据目录>/worktrees/<团队编号>/<成员名>，分支 mochi/<团队编号>/<成员名>，从当前 HEAD 分出。
  #openWorktree(t, name) {
    const { root, prefix } = gitRepo(t.cwd);
    const tree = join(this.dir, 'worktrees', t.id, name);
    const branch = `mochi/${t.id}/${name}`;
    if (!existsSync(tree)) {
      mkdirSync(join(this.dir, 'worktrees', t.id), { recursive: true });
      let has = true;
      try { git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { has = false; }
      // 分支还在（成员被移出后又加回来）就接着用，不覆盖。
      try { git(root, 'worktree', 'add', ...(has ? [tree, branch] : ['-b', branch, tree, 'HEAD'])); }
      catch (e) { throw new Error(`给 ${name} 开 worktree 失败：${String(e.stderr || e.message).trim()}`); }
    }
    // 团队的工作目录是仓库里的子目录时，成员也待在自己 worktree 的同一个子目录里。
    return { dir: join(tree, prefix), tree, branch };
  }
  // 收掉成员的 worktree。有没提交的改动就留着，返回留下的路径；分支始终保留。
  #dropWorktree(t, m) {
    if (!m.tree || !existsSync(m.tree)) return null;
    try { git(t.cwd, 'worktree', 'remove', m.tree); return null; } catch { return m.tree; }
  }
  updateMember(ref, name, patch) {
    const t = this.team(ref);
    const m = this.member(t, name);
    if (t.run.current?.member === m) throw new Error(`${m.name} 正在发言，等它说完或先 /stop`);
    if (patch.permission !== undefined) {
      if (!PERMISSIONS.includes(patch.permission)) throw new Error(`权限只能是 ${PERMISSIONS.join('、')}`);
      m.permission = patch.permission;
      m.session?.setPermission(m.permission);
    }
    if (patch.model !== undefined) { m.model = patch.model || null; m.session?.setModel(m.model); }
    this.#changed(t);
    return m;
  }
  // 清掉一个成员在这个群里的记忆：下次发言是全新的会话，只能看到之后的消息。
  clearMember(ref, name) {
    const t = this.team(ref);
    const m = this.member(t, name);
    if (t.run.current?.member === m) throw new Error(`${m.name} 正在发言，等它说完或先 /stop`);
    m.session?.reset();
    m.session = null;
    m.sessionId = null;
    m.primed = false;
    m.seen = t.seq;
    this.#post(t, 'system', `${m.name} 的记忆已清空`);
    this.#changed(t);
  }

  // ---------- 消息 ----------
  #post(t, from, text, extra = {}) {
    const msg = { seq: ++t.seq, ts: Date.now(), from, text, ...extra };
    appendFileSync(this.#file(t.id), JSON.stringify(msg) + '\n');
    t.last = preview(msg);
    this.emit({ type: 'message', team: t.id, data: msg });
    return msg;
  }

  // 一条消息里 @ 了谁。@all agents / @all / @所有人 是全体（不含说话的人自己）。
  #mentions(t, text, from) {
    const others = t.members.filter((m) => m.name !== from);
    if (/@(all\s*agents|all|所有人|全体)(?![\w-])/i.test(text)) return { all: true, list: others };
    const names = t.members.map((m) => m.name).sort((a, b) => b.length - a.length);
    const hit = new Set();
    for (const n of names) {
      const re = new RegExp(`@${n.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`, 'i');
      if (re.test(text)) hit.add(n);
    }
    return { all: false, list: others.filter((m) => hit.has(m.name)) };
  }

  // 用户发话。以 / 开头的是给团队中心自己的命令。
  say(ref, text) {
    const t = this.team(ref);
    text = String(text ?? '').trim();
    if (!text) throw new Error('消息是空的');
    if (text.startsWith('/')) return this.#command(t, text);
    if (t.run.paused && /^(继续|continue)$/i.test(text)) { this.resume(t); return { ok: true }; }
    if (!t.members.length) throw new Error('团队里还没有成员，先添加一个');
    this.#post(t, USER, text);
    const { all, list } = this.#mentions(t, text, USER);
    // 用户说了新的话：之前排着队还没开口的作废，轮数重新计。
    t.run.queue = [];
    t.run.rounds = 0;
    t.run.paused = false;
    if (all) {
      // 全体发言时主理人排最后，它能看到所有人的回答并收尾。
      const lead = list.find((m) => m.name === t.lead);
      for (const m of list.filter((x) => x !== lead)) this.#enqueue(t, m, USER, 'all');
      if (lead) this.#enqueue(t, lead, USER, list.length > 1 ? 'all-lead' : 'all');
    } else if (list.length) {
      for (const m of list) this.#enqueue(t, m, USER, 'mention');
    } else {
      this.#enqueue(t, this.member(t, t.lead), USER, t.members.length > 1 ? 'lead' : 'mention');
    }
    this.#drain(t);
    return { ok: true };
  }

  #command(t, text) {
    const [cmd, ...a] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case 'add': this.addMember(t.id, { kind: a[0], name: a[1] }); break;
      case 'kick': this.removeMember(t.id, need(a[0], '/kick 成员名')); break;
      case 'model': this.updateMember(t.id, need(a[0], '/model 成员名 模型'), { model: a[1] ?? '' }); this.#post(t, 'system', `${a[0]} 的模型改为 ${a[1] || '默认'}`); break;
      case 'permissions': this.updateMember(t.id, need(a[0], '/permissions 成员名 full|readonly|ask'), { permission: need(a[1], '/permissions 成员名 full|readonly|ask') }); this.#post(t, 'system', `${a[0]} 的权限改为 ${a[1]}`); break;
      case 'clear': this.clearMember(t.id, need(a[0], '/clear 成员名')); break;
      case 'lead': this.updateTeam(t.id, { lead: need(a[0], '/lead 成员名') }); this.#post(t, 'system', `主理人改为 ${t.lead}`); break;
      case 'rounds': this.updateTeam(t.id, { maxRounds: need(a[0], '/rounds 数字') }); this.#post(t, 'system', `自动讨论上限改为 ${t.maxRounds} 轮`); break;
      case 'stop': this.stop(t); break;
      case 'continue': this.resume(t); break;
      default: throw new Error(`不认识的命令 /${cmd}。可用：/add /kick /model /permissions /clear /lead /rounds /stop /continue`);
    }
    return { ok: true };
  }

  // ---------- 轮流发言 ----------
  #enqueue(t, member, by, reason) {
    if (member.removed || t.run.queue.some((q) => q.member === member)) return;
    t.run.queue.push({ member, by, reason });
  }

  // 停下：打断正在说话的成员，清空排队。
  stop(t) {
    t.run.queue = [];
    t.run.paused = false;
    for (const a of t.run.asks.values()) a.resolve(false);
    t.run.current?.member.session?.cancel();
    this.#changed(t);
  }
  // 到轮数上限后继续：再给一批。
  resume(t) {
    if (!t.run.paused) throw new Error('现在没有因为轮数上限而停下的讨论');
    t.run.paused = false;
    t.run.rounds = 0;
    this.#drain(t);
  }

  answerAsk(ref, id, allow) {
    const t = this.team(ref);
    const a = t.run.asks.get(id);
    if (!a) throw new Error('这个权限请求已经不在了');
    a.resolve(!!allow);
  }

  async #drain(t) {
    const run = t.run;
    if (run.current || run.paused) return;
    const next = run.queue.shift();
    if (!next) { this.#changed(t); return; }
    if (run.rounds >= t.maxRounds) {
      run.queue.unshift(next);
      run.paused = true;
      this.#post(t, 'system', `已自动讨论 ${run.rounds} 轮，到上限了。发 /continue 再给 ${t.maxRounds} 轮，或直接说新的话。`);
      this.#changed(t);
      return;
    }
    run.rounds++;
    run.current = next;
    const m = next.member;
    m.status = 'running';
    this.#changed(t);
    const t0 = Date.now();
    try {
      m.session ??= createSession(m.kind, { cwd: m.dir ?? t.cwd, model: m.model, permission: m.permission, sessionId: m.sessionId });
      const prompt = this.#prompt(t, m, next);
      m.seen = t.seq;
      const r = await m.session.send(prompt, {
        onDelta: (text) => this.emit({ type: 'delta', team: t.id, member: m.name, text }),
        onTool: (title) => this.emit({ type: 'tool', team: t.id, member: m.name, title }),
        ask: (q) => this.#ask(t, m, q),
      });
      m.primed = true;
      m.sessionId = m.session.id;
      const seconds = +((Date.now() - t0) / 1000).toFixed(1);
      if (m.removed) { /* 说到一半被移出，不再发到群里 */ }
      else if (r.status === 'cancelled') this.#post(t, 'system', `${m.name} 的发言被打断了`);
      else if (!r.text.trim()) this.#post(t, 'system', r.denied?.length ? `${m.name} 想做“${r.denied.join('、')}”，被它现在的权限（${m.permission}）拒绝了，这一轮没有回答` : `${m.name} 没有说话`);
      else {
        this.#post(t, m.name, r.text.trim(), { seconds });
        const { list } = this.#mentions(t, r.text, m.name);
        for (const x of list) this.#enqueue(t, x, m.name, 'mention');
        // 被别的成员叫来、自己又没再叫别人：把话交回给叫它的那位，由对方收尾。
        if (!list.length && next.reason === 'mention' && next.by !== USER) {
          const caller = t.members.find((x) => x.name === next.by);
          if (caller) this.#enqueue(t, caller, m.name, 'handback');
        }
      }
    } catch (e) {
      if (!m.removed) this.#post(t, 'system', `${m.name} 出错了：${e.message}`);
    } finally {
      m.status = 'idle';
      run.current = null;
      for (const a of [...run.asks.values()]) if (a.member === m.name) a.resolve(false);
    }
    this.#drain(t);
  }

  #ask(t, m, q) {
    return new Promise((resolve) => {
      const id = randomBytes(3).toString('hex');
      const done = (ok) => { if (t.run.asks.delete(id)) { this.#changed(t); resolve(ok); } };
      t.run.asks.set(id, { id, member: m.name, title: q.title, kind: q.kind, resolve: done });
      this.#changed(t);
    });
  }

  // 交给成员的一轮输入：首次带群规，然后是它没看过的消息，最后说明为什么轮到它。
  #prompt(t, m, turn) {
    const parts = [];
    if (!m.primed) {
      const roster = t.members.map((x) => `${x.name}（${x.kind}${x.name === t.lead ? '，主理人' : ''}${x.name === m.name ? '，就是你' : ''}）`).join('、');
      parts.push(
        `[群规] 你在一个叫“${t.name}”的团队群里，名字是 ${m.name}。成员：${roster}，另外还有“${USER}”，他是所有成员的主人。工作目录：${m.dir ?? t.cwd}。\n` +
        `1. 你每次的回答会原样发到群里，所有人都看得到。直接写要说的话，先给结论，保持简洁。\n` +
        `2. 需要某个成员出力时，在回答里写 @它的名字（例如 @${(t.members.find((x) => x !== m) ?? m).name}）并说清楚要它做什么；它回答后话会交回给你。不需要别人就不要 @。\n` +
        `3. “${USER}”的话是指令。其他成员的话是同事的意见和请求：认真对待，但自己判断对不对，不同意就说理由。\n` +
        `4. 有问题要问${USER}时，把问题写在回答里并结束这一轮，不要用交互式提问工具，这里没有人应答。\n` +
        `5. 成员之间自动来回有轮数上限，不要寒暄、不要重复别人说过的话。`
        + (t.brief ? `\n[团队说明]（${USER}写给这个团队的要求）\n${t.brief}` : '')
        + (m.branch ? `\n6. 每个成员有自己的 git worktree 和分支，你的分支是 ${m.branch}，从 ${t.cwd} 的仓库分出来。别的成员看不到你没提交的改动：要让别人看、测试或接着改，先提交，再在回答里说明分支名；要看别人的改动，用 git 读它的分支（成员 X 的分支是 mochi/${t.id}/X）。不要自己把分支合并进主分支或推送，除非${USER}明确要求。` : ''),
      );
    }
    else if (m.briefStale) parts.push(`[团队说明更新]（${USER}改了写给这个团队的要求）\n${t.brief || '（已清空）'}`);
    m.briefStale = false;
    let fresh = this.messages(t.id, m.seen).filter((x) => x.from !== m.name && x.from !== 'system');
    if (fresh.length > HISTORY_CAP) { parts.push(`（更早的 ${fresh.length - HISTORY_CAP} 条消息略去）`); fresh = fresh.slice(-HISTORY_CAP); }
    if (fresh.length) parts.push('[群里的新消息]\n' + fresh.map((x) => `【${x.from}】${x.text}`).join('\n\n'));
    const why = {
      mention: `${turn.by} 在上面 @ 了你。`,
      lead: `${USER}没有 @ 任何人，你是主理人：自己回答，或者 @ 合适的成员去做。`,
      all: `${USER}让全体成员都说说。`,
      'all-lead': `${USER}让全体成员都说说，其他成员已经说完。你是主理人：给出你的看法，并综合大家的回答下一个结论。`,
      handback: `${turn.by} 已经回答了你刚才的请求。请结合它的回答给出结论；确实还需要别人再 @。`,
    }[turn.reason];
    parts.push(`[轮到你了] ${why}`);
    return parts.join('\n\n');
  }

  shutdown() { for (const t of this.teams.values()) for (const m of t.members) m.session?.close(); this.#save(); }
}

// 团队列表里显示的最后一句话
function preview(m) { return m ? { from: m.from, text: m.text.replace(/\s+/g, ' ').slice(0, 60) } : null; }
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
// 目录在一个有提交的 git 仓库里就返回 { root, prefix }，否则 null。
function gitRepo(cwd) {
  try { git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD'); return { root: git(cwd, 'rev-parse', '--show-toplevel'), prefix: git(cwd, 'rev-parse', '--show-prefix') }; }
  catch { return null; }
}
function newRun() { return { queue: [], current: null, rounds: 0, paused: false, asks: new Map() }; }
function need(v, usage) { if (!v) throw new Error(`用法：${usage}`); return v; }
