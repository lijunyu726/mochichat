// 群聊室页面。只和本机的团队中心说话；页面上的文字一律先转义再显示。
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND_NAME = { claude: 'Claude Code', codex: 'Codex CLI', agy: 'Antigravity CLI' };
const PERM_NAME = { full: '完全放行', readonly: '只读', ask: '每次询问' };
const COMMANDS = [
  ['/model', '换模型'], ['/permissions', '完全放行 · 只读 · 每次询问'], ['/clear', '清空它在本群的记忆'], ['/kick', '移出团队'],
  ['/lead', '设为主理人'], ['/stop', '打断正在进行的讨论'], ['/continue', '到上限后再给一批'],
];
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 存不了就算了 */ } },
};

// 口令由 mochi open 放在地址的 # 后面；拿到后存起来并从地址里抹掉。
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) { store.set('mochi-token', fromHash); history.replaceState(null, '', location.pathname); }
const TOKEN = store.get('mochi-token', '');

const S = {
  teams: new Map(), // id -> 团队
  cur: store.get('mochi-cur', null),
  msgs: new Map(), // id -> 消息数组
  live: new Map(), // id -> { member, text, tools }：正在说的那一位
  seen: store.get('mochi-seen', {}), // id -> 看到第几条
  models: {}, // 类型 -> 模型表
  open: null, // 右栏展开的成员
  online: false,
  pop: null, // 弹出的菜单 { kind, items, index, ... }
  settings: null, // 团队中心的全局设置
};
const team = () => S.teams.get(S.cur);

// 外观：跟随系统，或设置里指定的浅色 / 深色。
const dark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = store.get('mochi-theme', 'auto');
  document.documentElement.dataset.theme = t === 'auto' ? (dark.matches ? 'dark' : 'light') : t;
}
dark.addEventListener('change', applyTheme);

async function api(method, path, data) {
  const r = await fetch(path, { method, headers: { 'x-mochi-token': TOKEN, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const o = await r.json();
  if (!o.ok) throw new Error(o.error || '出错了');
  return o;
}
const T = (t = team()) => `/api/teams/${encodeURIComponent(t.id)}`;
// 做一件事，失败了用提示条说出来。
async function act(fn) { try { return await fn(); } catch (e) { toast(e.message); } }
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

// ---------- 文字的显示 ----------
const avatar = (kind, cls = '') => `<img class="av ${cls}" alt="" src="avatars/${esc(kind)}.png">`;
const kindOf = (name, t = team()) => t?.members.find((m) => m.name.toLowerCase() === String(name).toLowerCase())?.kind;

// 很小的一套 Markdown：代码块、行内代码、粗体、标题、列表、段落。输入先整体转义，所以不会带进任何标签。
function rich(text, t) {
  const blocks = [];
  let s = esc(text).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (x) => x
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/@(all\s*agents|所有人|全体)(?![\w-])/gi, '<span class="at">@$1</span>')
    .replace(/@([\w一-龥-]+)/g, (m, n) => { const k = kindOf(n, t); return k ? `<span class="at ${k}">@${n}</span>` : m; });
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const para of s.split(/\n{2,}/)) {
    const lines = para.split('\n');
    let buf = [];
    const endP = () => { if (buf.length) { out.push(`<p>${buf.join('<br>')}</p>`); buf = []; } };
    for (const line of lines) {
      const li = line.match(/^\s*(?:([-*])|(\d+)[.、])\s+(.*)$/);
      const hd = line.match(/^#{1,6}\s+(.*)$/);
      const blk = line.match(/^\u0000(\d+)\u0000$/);
      if (li) { endP(); const tag = li[1] ? 'ul' : 'ol'; if (list?.tag !== tag) { flush(); list = { tag, items: [] }; } list.items.push(inline(li[3])); }
      else if (hd) { endP(); flush(); out.push(`<h3>${inline(hd[1])}</h3>`); }
      else if (blk) { endP(); flush(); out.push(blocks[+blk[1]]); }
      else { flush(); buf.push(inline(line)); }
    }
    endP();
    flush();
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}
const hhmm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- 左栏：团队 ----------
function renderTeams() {
  const list = [...S.teams.values()];
  $('#team-list').innerHTML = list.map((t) => {
    const unread = t.id === S.cur ? 0 : Math.max(0, (t.seq ?? 0) - (S.seen[t.id] ?? 0));
    const last = t.last ? `${t.last.from === 'system' ? '' : `${esc(t.last.from)}：`}${esc(t.last.text)}` : '还没人说话';
    return `<button class="team ${t.id === S.cur ? 'on' : ''}" data-act="pick-team" data-id="${esc(t.id)}">
      <div class="top"><span class="name">${esc(t.name)}</span>${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
      <div class="last">${last}</div>
      <div class="avs">${t.members.slice(0, 6).map((m) => avatar(m.kind)).join('')}</div></button>`;
  }).join('');
  $('#hub-dot').className = `dot ${S.online ? 'on' : ''}`;
  $('#hub-text').textContent = S.online ? '团队中心运行中 · 本机' : '和团队中心断开了，正在重连…';
}

// ---------- 中间：标题、消息 ----------
function renderHead() {
  const t = team();
  if (!t) { $('#head').innerHTML = ''; return; }
  const segs = Array.from({ length: Math.min(t.maxRounds, 16) }, (_, i) => `<i class="${i < Math.round(t.rounds / t.maxRounds * Math.min(t.maxRounds, 16)) ? 'on' : ''}"></i>`).join('');
  const busy = !!t.running || t.queue.length > 0;
  $('#head').innerHTML = `<div><div class="title"><h1>${esc(t.name)}</h1>
    ${busy || t.rounds ? `<span class="rounds">第 ${t.rounds} / ${t.maxRounds} 轮<span class="segs">${segs}</span></span>` : ''}</div>
    <div class="cwd">${esc(t.cwd)}${t.isolation === 'worktree' ? ' · 每个成员一个 worktree' : ''}</div></div>
    <div class="acts">${t.paused ? '<button class="pill dark" data-act="continue">继续讨论</button>' : ''}
    ${busy && !t.paused ? '<button class="pill" data-act="stop">暂停讨论</button>' : ''}</div>`;
}

function msgHtml(m, t) {
  if (m.from === 'system') return `<div class="sys">${esc(m.text)}</div>`;
  if (m.from === '用户') return `<div class="msg me"><div class="bubble">${rich(m.text, t)}</div><span class="sub">${hhmm(m.ts)}</span></div>`;
  const kind = m.kind ?? kindOf(m.from, t) ?? 'claude';
  return `<div class="msg">${avatar(kind)}<div><div class="meta"><b>${esc(m.from)}</b>${m.from === t.lead ? '<span class="tag">主理人</span>' : ''}<span>${m.seconds ? `${m.seconds} 秒 · ` : ''}${hhmm(m.ts)}</span></div><div class="bubble">${rich(m.text, t)}</div></div></div>`;
}
function liveHtml(t) {
  const l = S.live.get(t.id);
  if (!t.running) return '';
  const kind = kindOf(t.running, t) ?? 'claude';
  const tools = l?.tools.length ? `<div class="tools">${l.tools.slice(-4).map((x) => `<div class="tool"><b>在做</b><span>${esc(x)}</span></div>`).join('')}</div>` : '';
  const text = l?.text ? `${rich(l.text, t)}` : '<span class="thinking">正在想</span>';
  return `<div class="msg" id="live">${avatar(kind)}<div><div class="meta"><b>${esc(t.running)}</b>${t.running === t.lead ? '<span class="tag">主理人</span>' : ''}<span>正在说…</span></div><div class="bubble">${text}<span class="caret"></span>${tools}</div></div></div>`;
}
function renderMsgs(stick = true) {
  const box = $('#msgs');
  const t = team();
  if (!t) {
    box.innerHTML = `<div class="empty"><div class="trio">${avatar('claude')}${avatar('codex')}${avatar('agy')}</div><h2>拉一个团队开始</h2><p>把 Claude、codex、agy 拉进同一个群，一起讨论、一起干活。</p><button class="pill dark" data-act="new-team">＋ 新团队</button></div>`;
    return;
  }
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const msgs = S.msgs.get(t.id) ?? [];
  if (!t.members.length) box.innerHTML = `<div class="empty"><div class="trio">${avatar('claude')}${avatar('codex')}${avatar('agy')}</div><h2>${esc(t.name)} 还没有成员</h2><p>先拉人进来。第一个 Claude 会当主理人。</p><button class="pill dark" data-act="add-member">＋ 拉人进来</button></div>`;
  else box.innerHTML = msgs.map((m) => msgHtml(m, t)).join('') + liveHtml(t);
  if (stick && near) box.scrollTop = box.scrollHeight;
  S.seen[t.id] = t.seq ?? 0;
  store.set('mochi-seen', S.seen);
}
// 只更新“正在说”的那一块，避免每个字都重画整页。
function renderLive() {
  const t = team();
  const box = $('#msgs');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const old = $('#live');
  const html = t ? liveHtml(t) : '';
  if (old) old.outerHTML = html; else if (html) box.insertAdjacentHTML('beforeend', html);
  if (near) box.scrollTop = box.scrollHeight;
}

// ---------- 右栏：成员 ----------
function renderMembers() {
  const t = team();
  const box = $('#members');
  if (!t) { box.innerHTML = ''; return; }
  const cards = t.members.map((m) => {
    const asks = t.asks.filter((a) => a.member === m.name);
    const running = t.running === m.name;
    const queued = t.queue.includes(m.name);
    const st = asks.length ? ['等你', 'wait'] : running ? ['正在说', 'on'] : queued ? ['排队中', ''] : ['空闲', ''];
    const open = S.open === m.name;
    const models = S.models[m.kind];
    const modelSel = `<select data-act="set-model" data-name="${esc(m.name)}" aria-label="${esc(m.name)} 的模型" ${running ? 'disabled' : ''}>
      <option value="">默认模型</option>${(models ?? (m.model ? [{ id: m.model, name: m.model }] : [])).map((x) => `<option value="${esc(x.id)}" ${x.id === m.model ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('')}</select>`;
    const body = open ? `<div class="body">${m.branch ? `<div class="field"><span>它自己的 worktree</span><div class="branch">分支 ${esc(m.branch)}<br>${esc(m.dir)}</div></div>` : ''}
        <div class="field"><span>权限</span><div class="seg">${Object.entries(PERM_NAME).map(([k, v]) => `<button class="${m.permission === k ? 'on' : ''}" data-act="set-perm" data-name="${esc(m.name)}" data-perm="${k}" ${running ? 'disabled' : ''}>${v}</button>`).join('')}</div></div>
        <div class="field"><span>模型</span>${modelSel}</div>
        <div class="row">${m.name === t.lead ? '' : `<button class="pill sm line" data-act="set-lead" data-name="${esc(m.name)}">设为主理人</button>`}<button class="pill sm line" data-act="clear" data-name="${esc(m.name)}" ${running ? 'disabled' : ''}>清空记忆</button><button class="pill sm line danger" data-act="kick" data-name="${esc(m.name)}">移出团队</button></div></div>` : '';
    const askHtml = asks.map((a) => `<div class="ask"><b>等你点头</b><code>${esc(a.title)}</code><div class="row"><button class="pill sm dark" data-act="ask" data-id="${esc(a.id)}" data-allow="1">同意</button><button class="pill sm" data-act="ask" data-id="${esc(a.id)}" data-allow="">拒绝</button></div></div>`).join('');
    return `<div class="mem ${open ? 'open' : ''}">
      <button class="who" data-act="toggle-member" data-name="${esc(m.name)}" aria-expanded="${open}">${avatar(m.kind)}
        <div class="n"><div><b>${esc(m.name)}</b>${m.name === t.lead ? '<span class="tag">主理人</span>' : ''}</div><small>${esc(m.model || KIND_NAME[m.kind])} · ${PERM_NAME[m.permission]}</small></div>
        <span class="st"><span class="dot ${st[1]}"></span>${st[0]}</span></button>${body}${askHtml ? `<div class="body">${askHtml}</div>` : ''}</div>`;
  }).join('');
  box.innerHTML = `<div class="hd"><h2>成员 <span>${t.members.length}</span></h2><button class="pill dark sm" data-act="add-member">＋ 添加</button></div>${cards}
    <div class="settings">
      <div class="kv"><span>主理人</span><select data-act="pick-lead" aria-label="主理人" ${t.members.length ? '' : 'disabled'}>${t.members.map((m) => `<option ${m.name === t.lead ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="kv"><span>自动讨论上限</span><span class="step"><button data-act="rounds" data-d="-1" aria-label="减少">−</button>${t.maxRounds} 轮<button data-act="rounds" data-d="1" aria-label="增加">＋</button></span></div>
      <div class="team-acts"><button class="linkish plain" data-act="team-settings">团队名字和说明${t.brief ? '（已写）' : ''}</button><button class="linkish" data-act="rm-team">删除这个团队</button></div>
    </div>`;
}
function renderAll() { renderTeams(); renderHead(); renderMsgs(); renderMembers(); renderHint(); }
function renderHint() {
  const t = team();
  $('#hint').textContent = !t ? '' : t.members.length <= 1 ? '' : `不 @ 就交给主理人 ${t.lead ?? ''}`;
  $('#send').disabled = !t || !t.members.length;
}

async function loadModels(kind) {
  if (S.models[kind]) return;
  S.models[kind] = null;
  try { S.models[kind] = (await api('GET', `/api/models/${kind}`)).models; renderMembers(); }
  catch { delete S.models[kind]; }
}

// ---------- 数据 ----------
async function pick(id) {
  S.cur = id;
  S.open = null;
  store.set('mochi-cur', id);
  const t = team();
  if (t && !S.msgs.has(id)) S.msgs.set(id, (await api('GET', `${T(t)}/messages`)).messages);
  renderAll();
  const box = $('#msgs');
  box.scrollTop = box.scrollHeight;
  $('#input').focus();
}
async function refresh() {
  const { teams, settings } = await api('GET', '/api/state');
  S.settings = settings;
  S.teams = new Map(teams.map((t) => [t.id, t]));
  if (!S.teams.has(S.cur)) S.cur = teams[0]?.id ?? null;
  // 断线期间可能漏了消息，当前团队重新取一遍。
  S.msgs.clear();
  await pick(S.cur);
}
function onEvent(ev) {
  const t = S.teams.get(ev.team);
  if (ev.type === 'team') {
    const was = t?.running;
    S.teams.set(ev.team, ev.data);
    if (was !== ev.data.running) S.live.delete(ev.team);
    if (!S.cur) return void pick(ev.team);
    renderTeams();
    if (ev.team === S.cur) { renderHead(); renderMembers(); renderHint(); renderLive(); }
  } else if (ev.type === 'settings') {
    S.settings = ev.data;
  } else if (ev.type === 'team-removed') {
    S.teams.delete(ev.team);
    if (ev.team === S.cur) pick([...S.teams.keys()][0] ?? null); else renderTeams();
  } else if (ev.type === 'message') {
    if (t) { t.seq = ev.data.seq; t.last = { from: ev.data.from, text: ev.data.text.replace(/\s+/g, ' ').slice(0, 60) }; }
    S.msgs.get(ev.team)?.push(ev.data);
    if (ev.data.from !== 'system' && ev.data.from !== '用户') S.live.delete(ev.team);
    renderTeams();
    if (ev.team === S.cur) renderMsgs();
  } else if (ev.type === 'delta' || ev.type === 'tool') {
    let l = S.live.get(ev.team);
    if (!l || l.member !== ev.member) S.live.set(ev.team, (l = { member: ev.member, text: '', tools: [] }));
    if (ev.type === 'delta') l.text += ev.text; else l.tools.push(ev.title);
    if (ev.team === S.cur) renderLive();
  }
}
function connect() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.onopen = () => { S.online = true; act(refresh); };
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onerror = () => { if (S.online) { S.online = false; renderTeams(); } }; // 浏览器会自己重连
}

// ---------- 输入框和弹出菜单 ----------
const input = $('#input');
function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
function closePop() { S.pop = null; $('#popup').hidden = true; }
function showPop() {
  const p = S.pop;
  if (!p || !p.items.length) return closePop();
  const el = $('#popup');
  el.innerHTML = `<div class="cap">${esc(p.cap)}</div>` + p.items.map((it, i) => `<button class="${i === p.index ? 'on' : ''}" data-act="pop-pick" data-i="${i}"><span class="l">${it.kind ? avatar(it.kind) : ''}${esc(it.label)}</span><span class="r">${esc(it.desc)}</span></button>`).join('');
  el.hidden = false;
  el.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function updatePop() {
  const t = team();
  if (!t) return closePop();
  const before = input.value.slice(0, input.selectionStart);
  const at = before.match(/@([\w一-龥-]*)$/);
  const slash = before.match(/(?:^|\s)\/(\w*)$/);
  if (at) {
    const q = at[1].toLowerCase();
    const items = [
      ...t.members.filter((m) => m.name.toLowerCase().startsWith(q)).map((m) => ({ label: m.name, desc: `${m.model || KIND_NAME[m.kind]} · ${PERM_NAME[m.permission]}`, kind: m.kind, insert: `@${m.name} ` })),
      ...('all agents'.startsWith(q) && t.members.length > 1 ? [{ label: 'all agents', desc: '全体成员，主理人最后说', insert: '@all agents ' }] : []),
    ];
    S.pop = { cap: '@ 谁', items, index: 0, cut: at[0].length };
  } else if (slash) {
    // 前面刚 @ 过某个成员，命令就是对它的。
    const target = before.slice(0, before.length - slash[0].length).match(/@([\w一-龥-]+)\s*$/)?.[1];
    const m = target && t.members.find((x) => x.name.toLowerCase() === target.toLowerCase());
    const cmds = COMMANDS.filter(([c]) => c.slice(1).startsWith(slash[1].toLowerCase()) && (m ? !['/stop', '/continue'].includes(c) : true));
    S.pop = { cap: m ? `对 ${m.name} 的命令` : '命令', items: cmds.map(([c, d]) => ({ label: c, desc: d, cmd: c, member: m?.name })), index: 0, cut: slash[0].trimStart().length };
  } else return closePop();
  showPop();
}
function insert(text, cut = 0) {
  const pos = input.selectionStart;
  input.value = input.value.slice(0, pos - cut) + text + input.value.slice(input.selectionEnd);
  input.selectionStart = input.selectionEnd = pos - cut + text.length;
  input.focus();
  grow();
  updatePop();
}
function choose(i) {
  const p = S.pop;
  const it = p?.items[i];
  if (!it) return;
  if (it.insert) return insert(it.insert, p.cut);
  closePop();
  if (!it.member) {
    if (it.cmd === '/stop' || it.cmd === '/continue') { input.value = ''; grow(); return void act(() => api('POST', `${T()}${it.cmd}`)); }
    return insert(`${it.cmd} `, p.cut);
  }
  // 对某个成员的命令：直接做，或者打开它的设置。
  input.value = '';
  grow();
  const name = it.member;
  if (it.cmd === '/model' || it.cmd === '/permissions') { S.open = name; renderMembers(); loadModels(kindOf(name)); document.querySelector(`.mem.open ${it.cmd === '/model' ? 'select' : '.seg button'}`)?.focus(); }
  else if (it.cmd === '/clear') clearMember(name);
  else if (it.cmd === '/kick') kick(name);
  else if (it.cmd === '/lead') act(() => api('PATCH', T(), { lead: name }));
}
async function send() {
  const text = input.value.trim();
  const t = team();
  if (!text || !t) return;
  closePop();
  input.value = '';
  grow();
  try { await api('POST', `${T(t)}/messages`, { text }); }
  catch (e) { input.value = text; grow(); toast(e.message); }
}
input.addEventListener('input', () => { grow(); updatePop(); });
input.addEventListener('click', updatePop);
input.addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 正在选字（输入法），回车是确认候选词
  const p = S.pop;
  if (p) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); p.index = (p.index + (e.key === 'ArrowDown' ? 1 : p.items.length - 1)) % p.items.length; return showPop(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return choose(p.index); }
    if (e.key === 'Escape') { e.preventDefault(); return closePop(); }
  }
  const mod = store.get('mochi-send-key', 'enter') === 'mod';
  if (e.key === 'Enter' && (mod ? (e.metaKey || e.ctrlKey) : !e.shiftKey)) { e.preventDefault(); send(); }
});

// ---------- 成员和团队的操作 ----------
const clearMember = (name) => { if (confirm(`清空 ${name} 在这个群里的记忆？它会忘掉之前聊过的内容。`)) act(() => api('POST', `${T()}/members/${encodeURIComponent(name)}/clear`)); };
const kick = (name) => { if (confirm(`把 ${name} 移出团队？`)) act(async () => { await api('DELETE', `${T()}/members/${encodeURIComponent(name)}`); if (S.open === name) S.open = null; }); };

async function openSettings() {
  const f = $('#dlg-settings form');
  const s = S.settings ?? (await api('GET', '/api/settings')).settings;
  f.workspace.value = s.workspace;
  f.permission.value = s.permission;
  f.maxRounds.value = s.maxRounds;
  f.theme.value = store.get('mochi-theme', 'auto');
  f.sendKey.value = store.get('mochi-send-key', 'enter');
  const fill = (kind) => {
    const cur = s.models[kind] ?? '';
    const list = S.models[kind] ?? (cur ? [{ id: cur, name: cur }] : []);
    f[`m-${kind}`].innerHTML = `<option value="">用它自己的默认</option>` + list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name || x.id)}</option>`).join('');
  };
  for (const kind of Object.keys(KIND_NAME)) { fill(kind); if (!S.models[kind]) loadModels(kind).then(() => fill(kind)); }
  $('#dlg-settings').showModal();
}
$('#dlg-settings').addEventListener('close', (e) => {
  if (e.target.returnValue !== 'ok') return;
  const f = e.target.querySelector('form');
  store.set('mochi-theme', f.theme.value);
  store.set('mochi-send-key', f.sendKey.value);
  applyTheme();
  act(async () => {
    S.settings = (await api('PATCH', '/api/settings', {
      workspace: f.workspace.value, permission: f.permission.value, maxRounds: Number(f.maxRounds.value),
      models: Object.fromEntries(Object.keys(KIND_NAME).map((k) => [k, f[`m-${k}`].value])),
    })).settings;
    toast('设置已保存');
  });
});
$('#dlg-brief').addEventListener('close', (e) => {
  if (e.target.returnValue !== 'ok') return;
  const f = e.target.querySelector('form');
  act(() => api('PATCH', T(), { name: f.elements.name.value.trim(), brief: f.brief.value }));
});

let pickedKind = 'claude';
function openMemberDialog() {
  const dlg = $('#dlg-member');
  const draw = () => { $('#kind-pick').innerHTML = Object.entries(KIND_NAME).map(([k, v]) => `<button type="button" class="${k === pickedKind ? 'on' : ''}" data-kind="${k}">${avatar(k)}${k === 'claude' ? 'Claude' : k}<small>${v}</small></button>`).join(''); };
  draw();
  $('#kind-pick').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (b) { pickedKind = b.dataset.kind; draw(); } };
  dlg.querySelector('form').reset();
  dlg.showModal();
}
$('#dlg-member').addEventListener('close', (e) => {
  if (e.target.returnValue !== 'ok') return;
  const name = e.target.querySelector('[name=name]').value.trim();
  act(() => api('POST', `${T()}/members`, { kind: pickedKind, name: name || undefined }));
});
$('#dlg-team').addEventListener('close', (e) => {
  if (e.target.returnValue !== 'ok') return;
  const f = e.target.querySelector('form');
  const cwd = f.cwd.value.trim();
  store.set('mochi-last-cwd', cwd);
  act(async () => { const { team: t } = await api('POST', '/api/teams', { name: f.elements.name.value.trim(), cwd: cwd || undefined, isolation: f.shared.checked ? 'shared' : undefined }); S.teams.set(t.id, t); await pick(t.id); });
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (!e.target.closest('#popup, #input')) closePop(); return; }
  const d = b.dataset;
  const t = team();
  switch (d.act) {
    case 'new-team': { const dlg = $('#dlg-team'); dlg.querySelector('form').reset(); dlg.querySelector('[name=cwd]').value = store.get('mochi-last-cwd', ''); dlg.showModal(); break; }
    case 'settings': act(openSettings); break;
    case 'team-settings': { const f = $('#dlg-brief form'); f.elements.name.value = t.name; f.brief.value = t.brief ?? ''; $('#dlg-brief').showModal(); break; }
    case 'pick-team': act(() => pick(d.id)); break;
    case 'add-member': openMemberDialog(); break;
    case 'toggle-member': S.open = S.open === d.name ? null : d.name; if (S.open) loadModels(kindOf(d.name)); renderMembers(); break;
    case 'set-perm': act(() => api('PATCH', `${T()}/members/${encodeURIComponent(d.name)}`, { permission: d.perm })); break;
    case 'set-lead': act(() => api('PATCH', T(), { lead: d.name })); break;
    case 'clear': clearMember(d.name); break;
    case 'kick': kick(d.name); break;
    case 'ask': act(() => api('POST', `${T()}/asks/${d.id}`, { allow: !!d.allow })); break;
    case 'rounds': act(() => api('PATCH', T(), { maxRounds: Math.max(1, Math.min(100, t.maxRounds + Number(d.d))) })); break;
    case 'rm-team': if (confirm(`删除团队“${t.name}”和它的聊天记录？删了找不回来。`)) act(() => api('DELETE', T())); break;
    case 'stop': act(() => api('POST', `${T()}/stop`)); break;
    case 'continue': act(() => api('POST', `${T()}/continue`)); break;
    case 'send': send(); break;
    case 'ins-at': insert('@'); break;
    case 'ins-all': insert('@all agents '); break;
    case 'ins-slash': insert(input.value && !/\s$/.test(input.value) ? ' /' : '/'); break;
    case 'pop-pick': choose(Number(d.i)); break;
  }
});
document.addEventListener('change', (e) => {
  const d = e.target.dataset;
  if (d.act === 'set-model') act(() => api('PATCH', `${T()}/members/${encodeURIComponent(d.name)}`, { model: e.target.value }));
  if (d.act === 'pick-lead') act(() => api('PATCH', T(), { lead: e.target.value }));
});

if (!TOKEN) {
  document.body.innerHTML = '<div class="gate"><h2>需要从命令打开</h2><p>这个页面要带着口令才能用。请在终端里运行 <code>mochi open</code>。</p></div>';
} else {
  renderAll();
  connect();
}
