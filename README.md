# claude-agy-bridge

本机的两件工具，放在同一个仓库里：

1. **`peer`：agent 团队中心**。把 Claude Code、codex、agy 拉进一个团队群，像群聊一样协作：可以建多个团队、随时加人踢人、给每个成员选模型和权限。
2. **`agyc`：Claude Code 与 agy 的对话桥**。一个常驻程序握着 `agy acp`，让当前这个 Claude Code 会话和 agy 多轮对话（见本文后半部分）。

## peer：团队中心

### 能做什么

- **团队和成员**：`peer new` 建团队（绑定一个工作目录），`peer add / kick` 加人、踢人。成员类型：`claude`（Claude Code）、`codex`、`agy`；同一种可以加多个（用 `--name` 起不同的名字）。
- **每个群各有记忆**：同一种 agent 进了多个群，每个群是一个独立会话，互相不知道对方聊过什么。团队中心重启后接回原来的会话。
- **@ 的规则**：`@成员名` 发给它；`@all agents` 发给全体（主理人最后说，并综合大家的回答）；谁也不 @ 就交给主理人，由它自己回答或 @ 别的成员。
- **主理人**：每个团队一个，默认是第一个 Claude（没有 Claude 就是第一个成员），`peer lead` 可改。
- **交回**：成员 A @ 了成员 B，B 回答后话自动交回 A，由 A 给出结论。
- **轮数上限**：成员每说一次算一轮，你发一条消息后最多自动进行 8 轮（`peer rounds` 可改），到了就停下，发 `/continue` 或“继续”再给一批。
- **权限**：默认 `full`（全部放行，等同 Claude Code 的 bypass permissions）；`readonly` 不能改文件、不能跑命令；`ask` 每次改动先问你（`peer allow / deny`）。按成员单独设置。
- **模型**：`peer models <类型>` 列出可选模型，`peer set … --model` 或 `/model` 切换，下一轮生效，不丢上下文。
- **打断**：`peer stop <团队>`。
- **群里的 / 命令**（在 `peer say` 的消息里用）：`/add 类型 [名字]`、`/kick 成员`、`/model 成员 模型`、`/permissions 成员 full|readonly|ask`、`/clear 成员`、`/lead 成员`、`/rounds 数字`、`/stop`、`/continue`。

### 现在做不到的

- **群聊室网页还没有做**，目前只有命令行 `peer`。HTTP 接口已经齐了（见 AGENTS.md），网页会接在同一个服务上。
- **成员是各自的无界面进程**，不是你正在终端里用的那个会话；它们读同一份配置（CLAUDE.md、MCP、技能等）。
- **同一时刻只有一个成员在说话**，其他人排队。
- **agent 自己的斜杠命令（如 `/compact`）不转发**，会被当成普通文字。
- **agy 的操作被拒绝后那一轮不回答**（agy 自己的行为），群里会出现一条说明。
- **打断 Claude 成员**只在假 agent 上测过，真实的还没有验证。

### 用法

```sh
peer new 店序 --cwd /Volumes/S690/codes/shopflow
peer add 店序 claude
peer add 店序 codex
peer add 店序 agy --model gemini-3.8-flash-high
peer say 店序 "登录用 session 还是 JWT？"          # 交给主理人
peer say 店序 "@codex 跑一下 auth 的测试"
peer say 店序 "@all agents 各自说说风险"
peer status
peer log 店序 -n 50
peer help
```

数据在 `~/.peer/`（团队、聊天记录、口令）。环境变量：`PEER_HOME`、`PEER_PORT`（默认 4517）、`PEER_CLAUDE_BIN` / `PEER_CODEX_BIN` / `PEER_AGY_BIN`。

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
ln -s /Volumes/S690/codes/claude-agy-bridge/bin/agyc.mjs ~/.local/bin/agyc
ln -s /Volumes/S690/codes/claude-agy-bridge/bin/peer.mjs ~/.local/bin/peer
ln -s /Volumes/S690/codes/claude-agy-bridge/skill/agy ~/.claude/skills/agy   # 让 Claude Code 知道怎么用
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
