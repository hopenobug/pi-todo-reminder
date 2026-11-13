# pi-todo-reminder

Pi 扩展：当一次 agent 运行**真正结束**、而 todo 列表里还有未完成任务时，自动注入一条提醒消息并触发后续一轮，让 agent 继续干活。

**这个扩展是为 `rpiv-todo` 写的**：它依赖 `rpiv-todo` 的 `todo` 工具产生任务数据，脱离 `rpiv-todo` 不工作。

解决的问题很具体：agent 经常在 todo 没做完时就收尾（"我先完成了前两步"），需要人再催一句。这个扩展在运行 settle 时替人补这一句。

## 行为

每次 `agent_settled` 时，按下面的顺序判定（`guard.ts:shouldRemind`）：

| 情况 | 结果 |
| --- | --- |
| 用户手动中止（`aborted`，如 Esc） | 完全静默，不触发 turn，签名重置 |
| 有停止请求（用户插话，或模型输出停止标记） | 静默一轮，基线对齐到当前签名 |
| 没有未完成任务（全部 completed / deleted） | 静默，签名重置 |
| 未完成任务的签名与上次提醒相同（无进展） | 静默，被动显示一条说明 |
| 其它（首次 settle 或任务有变化） | 注入提醒 + `triggerTurn: true` |

提醒正文把 `in_progress` 排在 `pending` 前面（先做完手头的事），并附上 todo 工作流要求和停止标记的用法。

除"手动中止"和"全部完成"外，被抑制的提醒会以 `display: true` 的被动消息说明原因，但**永远不触发 turn**，且每个提醒周期最多一条。

## 无限循环防护

核心是任务签名 `signatureOf`：未完成任务（`pending` + `in_progress`）的 `id:status` 集合，与顺序无关。

两次 settle 之间签名不变 ⇒ agent 没碰 todo ⇒ 不再提醒。只要完成一个任务或新增一个任务，签名就变，提醒自然重新武装。

## 停止机制

两个来源，语义相同，在下一次 settle 统一消费：

- **模型自判**：提醒正文要求模型在自己认为不该继续（用户已接管、用户要求停止、任务被外部阻塞）时，于回复最后一行原样输出 `<!-- todo-reminder:stop -->`。模型看得到全部上下文，因此它是主判官。
- **用户插话**：提醒链激活期间，用户手动发起运行（`before_agent_start`），或在提醒触发的那一轮里插入用户消息，都会让下一次 settle 静默。

两种方式都只静音一轮并对齐基线，之后的进展会重新触发提醒。

## 会话隔离

按 `ctx.sessionManager.getSessionId()` 为每个会话维护独立快照；子会话的 todo 调用只影响子会话自己的槽位，不会给前台会话发提醒。`session_shutdown` 时清理槽位。ctx 失效（会话替换期间 Pi 会让 ctx 代理抛错）时退化为 `""` 共享槽位，与 rpiv-todo 的默认行为一致。

## 依赖

- 宿主：`@earendil-works/pi-coding-agent`（peer dependency，由 Pi 提供）。
- 数据来源：`rpiv-todo` 的 `todo` 工具。通过公开持久化契约读取 `ToolResultMessage.details.tasks`（完整列表，含 deleted 墓碑）。

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/hopenobug/pi-todo-reminder
```

或者把目录放到 Pi 的扩展目录下即可（例如 `~/.pi/agent/extensions/pi-todo-reminder`）。`package.json` 的 `pi.extensions` 已指向 `./index.ts`。

## 开发

```bash
npm install
npm test        # vitest run
```

## 文件结构

- `index.ts` — Pi 生命周期挂载：`tool_execution_end` 收集 todo 快照，`before_agent_start` / `agent_end` 捕获停止信号，`agent_settled` 决策并注入消息。
- `guard.ts` — 纯决策与渲染逻辑，不 import Pi，因此无限循环防护可以脱离 Pi 运行时单测。
- `guard.test.ts` — 覆盖签名、抑制分支、停止语义与提醒正文。

## License

MIT
