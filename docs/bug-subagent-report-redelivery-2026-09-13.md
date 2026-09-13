# Bug 修复：主会话结束后，三个子代理报告依次重新触发执行

日期：2026-09-13。状态：已修复并通过回归验证。

## 现象与证据

主代理已通过 `delegate_wait` 收齐三个子代理的报告并给出结论，随后三份报告又作为用户消息回到主会话，分别启动额外一轮执行。用户停止第一轮后，第二份、第三份报告仍依次触发执行。

对应父会话为 `~/.tacode/sessions/2026/09/13/2026-09-13T05-47-58-524Z_01a0994e-e0bc-772e-bd3f-7757031f28d6.jsonl`：

| JSONL 行号 | 记录 |
| --- | --- |
| 70 | `delegate_wait` 返回一份完成报告，另两个子代理仍未完成 |
| 75 | 后续 `delegate_wait` 返回三个子代理的完成报告 |
| 79 | 主代理输出最终结论 |
| 80、82、84 | 相同的三个子代理报告被重新写入为用户消息 |
| 81、83、85 | 对应的三次 assistant 回复均以 `stopReason: "aborted"` 结束 |

这是报告交付与停止时序的问题，与「轮次上限留空表示不限」是独立问题。原始会话记录保持不变。

## 根因

`src/runtime/tools/delegate.ts` 的远程完成事件曾直接调用 `pi.sendUserMessage(..., { deliverAs: "followUp" })`。当 `delegate_wait` 还在等待其余子代理时，先完成的报告已经进入 Pi 队列；等工具返回再标记“已交付”无法撤回队列里的消息。本地 fallback 的 150 ms 投递定时器也存在相同竞争。

现有 RPC abort 补丁在 `await session.abort()` 之后才清理 follow-up 队列。但 Pi 0.83.0 的 `AgentSession._handlePostAgentRun()` 会在会话真正空闲之前继续消费队列，因此等待停止的过程反而可能启动下一份旧报告。原有投递开关还把所有 `agent_start` 都当成用户的新输入，自动续跑也能错误恢复投递。

另外，Pi 的 `agent_end` 早于会话真正空闲；之后仍可能进行上下文压缩、重试或续跑。只靠这个事件和固定延迟判断空闲，会重新打开提前入队的窗口。

## 修复行为

- 主代理运行及收尾期间，完成报告保留在 TACode 的缓冲中。真正空闲后，将当前尚未读取的报告合并通知。
- `delegate_wait` 在请求前保留目标报告的交付权；只确认本次返回的终态报告，并在成功、超时或失败后释放保留。等待超时后才完成的报告仍能正常通知。
- 已通过 `delegate_wait` 或 `delegate_continue` 返回的报告不再自动回灌。本地默认等待也能读取已经完成但尚未交付的报告。
- 父回合中止时撤销旧委派的自动通知；`agent_start` 只跟踪运行状态，只有 `interactive` / `rpc` 来源的新输入恢复投递。停止子代理时先撤销通知，再等待取消完成。
- 远程完成事件与已经终态的启动响应使用同一过滤规则，`cancelled` / `interrupted` 不触发新回复。关闭会话时清理定时器与事件订阅。
- `patches/@earendil-works__pi-coding-agent@0.83.0.patch` 改为在等待 abort 完成之前清空 follow-up 队列及其显示状态，保留独立的 steering 队列。补丁已通过 `pnpm patch-commit` 安装，`pnpm-lock.yaml` 同步更新。

子代理状态、最终报告与转录仍由原有协调器和面板保留。消费报告只撤销自动通知，不删除报告。

## 验证

修复前，新增的定向回归中有 9 个失败用例，覆盖等待期间提前投递、三份报告分别入队及 abort 清队列时序。修复后：

- 四个定向测试文件共 52 个用例通过：`delegate.test.ts`、`delegate-remote.test.ts`、`pi-rpc-abort-patch.test.ts`、`agent-delegation-delivery.test.ts`。
- 真实 `AgentHost` / RPC worker 测试使用隔离的 `TACODE_HOME`、本地 mock 模型网关与可控委派桥。三个完成事件先于 wait 响应到达时，仅有三次必要模型请求（委派、等待、总结）、一条真实用户输入和一次结论，没有额外报告用户消息。
- 真实 RPC 在生成中排入三条 follow-up，调用一次 abort 后无新增模型请求，队列为空；用户随后发新消息仍可正常执行。
- `pnpm test --reporter=dot`：107 个文件、949 个用例通过。`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。

本次验证覆盖真实 RPC 运行时与本地模拟网关，未重新执行 Electron 综合界面冒烟或调用线上模型。构建产物已更新；需要完整退出并重启 TACode，再启动新的 Agent 会话，已运行的 worker 才会使用修复后的逻辑。
