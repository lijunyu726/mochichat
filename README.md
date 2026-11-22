# claude-agy-bridge

让 Claude Code 和 Antigravity CLI（`agy`）在本机多轮对话的小桥：一个常驻程序握着 `agy acp`，一条命令 `agyc` 负责收发。

## 能做什么

- **Claude 问 agy，多轮**：`agyc ask "…"`。同名会话保留上下文；agy 在回答里提出的问题，由 Claude 用下一条 `ask` 回答，回答者就是当前这个 Claude 会话。
- **长任务不阻塞**：把 `agyc ask` 放到后台运行，agy 做完时命令退出，Claude Code 会话收到通知。
- **外面的 agy 主动找 Claude**：Claude 在后台运行 `agyc wait` 监听；另一个终端里的 agy 运行 `agyc tell "…"`，Claude 被唤醒后用 `agyc reply` 回答，内容由程序原样传递。
- **权限由桥把关**：agy 默认只能读取和搜索；写文件、执行命令要在那一条 `ask` 上用 `--allow` 打开。
- **崩溃恢复**：常驻程序或 agy 进程重启后，按会话编号从 agy 的磁盘记录恢复上下文。
- **可查的记录**：每个会话的问答、工具调用、权限决定写在 `~/.claude-agy-bridge/logs/<会话名>.log`。

## 做不到的

- Claude 没有运行 `agyc wait` 时，外面的 agy 发来的消息送不到，`agyc tell` 会在超时后报“未送达”。
- 不转发 agy 的交互式提问（它只接受预设选项）：桥会取消它，并在会话开头约定 agy 把问题写在回答里。
- 只在本机使用，socket 文件只有当前系统用户能访问；没有网络功能。
- agy 一侧不做任何配置同步，不复制 Claude 的设置或密钥。

## 环境

- macOS（在 macOS 27 上开发和验证；Linux 未验证）
- Node.js 20 以上（无第三方依赖）
- `agy` 1.5.2 以上并已登录（验证用的是 1.5.14）

## 安装

```bash
ln -s /Volumes/S690/codes/claude-agy-bridge/bin/agyc.mjs ~/.local/bin/agyc
ln -s /Volumes/S690/codes/claude-agy-bridge/skill/agy ~/.claude/skills/agy   # 让 Claude Code 知道怎么用
```

## 使用

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

## 配置（环境变量）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `AGYC_HOME` | 运行目录（socket、会话表、日志） | `~/.claude-agy-bridge` |
| `AGYC_AGY_BIN` | agy 可执行文件 | `agy` |
| `AGYC_IDLE_HOURS` | 常驻程序空闲多久自动退出，0 为不退出 | `12` |

## 测试

```bash
npm test
```

用假的 agy（`test/fake-agy.mjs`，同样说 ACP）跑，不调用模型、不消耗额度。
