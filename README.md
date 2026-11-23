# mochichat

本机的两件工具，放在同一个仓库里：

1. **mochichat（命令 `mochi`）：agent 团队中心**。把 Claude Code、codex、agy 拉进一个团队群，像群聊一样协作：可以建多个团队、随时加人踢人、给每个成员选模型和权限。
2. **`agyc`：Claude Code 与 agy 的对话桥**。一个常驻程序握着 `agy acp`，让当前这个 Claude Code 会话和 agy 多轮对话（见本文后半部分）。

## mochichat：团队中心（命令 `mochi`）

### 能做什么

- **团队和成员**：`mochi new` 建团队（绑定一个工作目录），`mochi add / kick` 加人、踢人。成员类型：`claude`（Claude Code）、`codex`、`agy`；同一种可以加多个（用 `--name` 起不同的名字）。
- **每个群各有记忆**：同一种 agent 进了多个群，每个群是一个独立会话，互相不知道对方聊过什么。团队中心重启后接回原来的会话。
- **@ 的规则**：`@成员名` 发给它；`@all agents` 发给全体（主理人最后说，并综合大家的回答）；谁也不 @ 就交给主理人，由它自己回答或 @ 别的成员。
- **工作目录和 worktree**：`mochi new` 默认用当前目录；`--workspace`（网页里不填目录）放进默认工作区 `~/mochichat/<团队名>/`。目录是有提交记录的 git 仓库时，每个成员有自己的 worktree（在 `~/.mochichat/worktrees/<团队编号>/<成员名>`）和分支（`mochi/<团队编号>/<成员名>`），互相看不到对方没提交的改动；`--shared`（网页里勾“成员共用这个目录”）改成大家共用一个目录。不是 git 仓库的目录只能共用。移出成员时：worktree 干净就收掉，有没提交的改动就留在原处；分支始终保留，不会自动合并或推送。
- **主理人**：每个团队一个，默认是第一个 Claude（没有 Claude 就是第一个成员），`mochi lead` 可改。
- **交回**：成员 A @ 了成员 B，B 回答后话自动交回 A，由 A 给出结论。
- **轮数上限**：成员每说一次算一轮，你发一条消息后最多自动进行 8 轮（`mochi rounds` 可改），到了就停下，发 `/continue` 或“继续”再给一批。
- **权限**：默认 `full`（全部放行，等同 Claude Code 的 bypass permissions）；`readonly` 不能改文件、不能跑命令；`ask` 每次改动先问你（`mochi allow / deny`）。按成员单独设置。
- **模型**：`mochi models <类型>` 列出可选模型，`mochi set … --model` 或 `/model` 切换，下一轮生效，不丢上下文。
- **打断**：`mochi stop <团队>`。
- **群里的 / 命令**（在 `mochi say` 的消息里用）：`/add 类型 [名字]`、`/kick 成员`、`/model 成员 模型`、`/permissions 成员 full|readonly|ask`、`/clear 成员`、`/lead 成员`、`/rounds 数字`、`/stop`、`/continue`。

### 群聊室网页

`mochi open` 在浏览器里打开群聊室（`http://127.0.0.1:4517`），和命令行用的是同一个团队中心、同一份数据。

- 左边是团队，中间是对话（自己的消息在右边），右边是成员。
- 点成员卡片可以改权限、换模型、设为主理人、清空记忆、移出团队；成员申请权限时，卡片上出现“同意 / 拒绝”。
- 输入框里打 `@` 选成员或 `@all agents`；打 `/` 出命令菜单，先 `@成员` 再打 `/` 就是对这个成员的命令。回车发送，Shift+回车换行。
- 左下角“设置”：默认工作区、新成员的默认权限、每种 agent 的默认模型、默认轮数上限（只影响以后新建的团队和新加的成员），以及这台浏览器上的外观（跟随系统 / 浅色 / 深色）和发送快捷键。全局设置存在 `~/.mochichat/settings.json`。
- 右下角“团队名字和说明”：改团队名；写一段团队说明，每个成员都会看到，改了之后成员在下一次发言前补看。
- 页面必须从 `mochi open` 进：它把口令放在地址的 `#` 后面交给页面，页面存进浏览器本地并立刻从地址里抹掉。直接输网址会提示去运行 `mochi open`。
- worktree 只在假成员上测过（各自的目录、分支、移出时的保留规则）；真实成员会不会按群规提交并告诉别人分支名，**未验证**。
- 已验证：用假成员在无头浏览器里点通了发消息、`@all agents`、权限请求的同意、打断、改权限、拉人。**未验证**：接真实的 Claude / codex / agy 时页面的表现（流式文字、长回答、Markdown 排版）；窄屏布局只写了样式，没有实际看过。

### 现在做不到的

- **成员是各自的无界面进程**，不是你正在终端里用的那个会话；它们读同一份配置（CLAUDE.md、MCP、技能等）。
- **同一时刻只有一个成员在说话**，其他人排队。
- **agent 自己的斜杠命令（如 `/compact`）不转发**，会被当成普通文字。
- **agy 的操作被拒绝后那一轮不回答**（agy 自己的行为），群里会出现一条说明。
- **打断 Claude 成员**只在假 agent 上测过，真实的还没有验证。

### 用法

```sh
mochi new 店序 --cwd ~/code/shopflow
mochi add 店序 claude
mochi add 店序 codex
mochi add 店序 agy --model gemini-3.8-flash-high
mochi say 店序 "登录用 session 还是 JWT？"          # 交给主理人
mochi say 店序 "@codex 跑一下 auth 的测试"
mochi say 店序 "@all agents 各自说说风险"
mochi status
mochi log 店序 -n 50
mochi help
```

数据在 `~/.mochichat/`（团队、聊天记录、口令、成员的 worktree）。环境变量：`MOCHI_HOME`、`MOCHI_WORKSPACE`（默认工作区，默认 `~/mochichat`）、`MOCHI_PORT`（默认 4517）、`MOCHI_CLAUDE_BIN` / `MOCHI_CODEX_BIN` / `MOCHI_AGY_BIN`。

## agyc：Claude Code 与 agy 的对话桥

### 能做什么

- **Claude 问 agy，多轮**：`agyc ask "…"`。同名会话保留上下文；agy 在回答里提出的问题，由 Claude 用下一条 `ask` 回答，回答者就是当前这个 Claude 会话。
- **长任务不阻塞**：把 `agyc ask` 放到后台运行，agy 做完时命令退出，Claude Code 会话收到通知。
- **外面的 agy 主动找 Claude**：Claude 在后台运行 `agyc wait` 监听；另一个终端里的 agy 运行 `agyc tell "…"`，Claude 被唤醒后用 `agyc reply` 回答，内容由程序原样传递。
- **权限由桥把关**：agy 默认只能读取和搜索；写文件、执行命令要在那一条 `ask` 上用 `--allow` 打开。
- **崩溃恢复**：常驻程序或 agy 进程重启后，按会话编号从 agy 的磁盘记录恢复上下文。
- **可查的记录**：每个会话的问答、工具调用、权限决定写在 `~/.claude-agy-bridge/logs/<会话名>.log`。

### 做不到的

- Claude 没有运行 `agyc wait` 时，外面的 agy 发来的消息送不到，`agyc tell` 会在超时后报“未送达”。
- 不转发 agy 的交互式提问（它只接受预设选项）：桥会取消它，并在会话开头约定 agy 把问题写在回答里。
- 只在本机使用，socket 文件只有当前系统用户能访问；没有网络功能。
- agy 一侧不做任何配置同步，不复制 Claude 的设置或密钥。

### 环境

- macOS（在 macOS 27 上开发和验证；Linux 未验证）
- Node.js 20 以上（无第三方依赖）
- `agy` 1.5.2 以上并已登录（验证用的是 1.5.14）

### 安装

```bash
# 在仓库目录里运行
ln -s "$PWD"/bin/agyc.mjs ~/.local/bin/agyc
ln -s "$PWD"/bin/mochi.mjs ~/.local/bin/mochi
ln -s "$PWD"/skill/agy ~/.claude/skills/agy   # 让 Claude Code 知道怎么用
```

### 使用

```bash
agyc ask "看一下 src/ 里的错误处理，有什么问题？"
agyc ask "第 2 点展开说说"                      # 同一会话，接着聊
agyc ask -s review --allow edit "按刚才的结论改 src/a.js"
agyc ask - <<'EOF'                               # 长消息从标准输入传
……
EOF
agyc wait                                        # 监听外面的 agy 来信（后台运行）
agyc reply m1 "回答"
agyc tell "问题"                                 # 由 agy 一侧运行
agyc status | log | cancel | new | stop
```

完整选项见 `agyc help`。

### 配置（环境变量）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `AGYC_HOME` | 运行目录（socket、会话表、日志） | `~/.claude-agy-bridge` |
| `AGYC_AGY_BIN` | agy 可执行文件 | `agy` |
| `AGYC_IDLE_HOURS` | 常驻程序空闲多久自动退出，0 为不退出 | `12` |

### 测试

```bash
npm test
```

两套测试都用假 agent（`test/fake-agy.mjs`、`test/fake-agent.mjs`，说的是和真的一样的协议）跑，不调用模型、不消耗额度。
