# TACode 子代理实测记录与问题汇总（第二轮 2026-09-10）

本文件记录一次真实的委派测试：父代理通过 `delegate` 同步启动 2 个只读子代理分析本仓库，
再汇总「子代理使用过程中出现的问题 + 优化建议」。第一轮报告见
`docs/subagent-analysis-2026-09-10.md`。

## 1. 测试方法

| 项 | 值 |
| --- | --- |
| 父会话 | 当前 TACode Agent 会话（cwd `/Users/yfdl/project/TAcode`） |
| 子代理 1 | `explorer`（只读）——端到端子代理/委派调用链 + 定义与解析 + 状态机 |
| 子代理 2 | `code-reviewer`（只读）——对抗式审查权限、工具白名单、进程泄漏、报告提取 |
| 调用方式 | 单次 `delegate` 提交 2 个 task（并行），父代理同步等待回传 |
| 模型/权限 | openai / deepseek-v4-flash，permission=auto |

## 2. 实测结果

### 2.1 委派本身：成功（第一轮的回传缺陷已修复）

数据来自 `~/.tether/logs/tether.log` 的 `scope=delegation` 记录：

| delegationId | role | status | elapsedMs | turns | toolCalls | reportChars |
| --- | --- | --- | --- | --- | --- | --- |
| delegation-ce24c804 | explorer | completed | 121716 | 38 | 48 | 4735 |
| delegation-b4b25ff6 | code-reviewer | completed | 198350 | 41 | 63 | 2805 |

- 两条 `delegation launching` 时间同为 07:55:42，`settled` 分别在 07:57:43 / 07:59:00；
  墙钟约 198s ≈ 较慢子代理耗时，说明两个子代理**确实并行**执行。
- 两次都是 `hasReport: true` + `status: completed`，父上下文拿到了完整报告文本。
- 对比第一轮的 `The delegated worker finished without a report.`：`collectReport` 现在会
  `await host.waitForIdle()` 后才判定（`src/main/delegation-coordinator.ts:476`），缺陷已修。
- 历史遗留的 8 条 failed 记录在同日 07:52:36 被逐条
  `delegation failure reconciled to completed`（`delegation-coordinator.ts:717-737` 的自愈逻辑）。
  自愈本身工作正常，但也说明「先误判 failed、再事后对账」是当前完成判定的常态成本。

### 2.2 聚焦测试基线

命令：`npx vitest run --no-file-parallelism --pool=forks <files>`

| 测试文件 | 结果 |
| --- | --- |
| `src/shared/delegation.test.ts` | 6 passed |
| `src/main/delegation-coordinator.test.ts` | 12 passed（含 waits for the worker to settle / keeps two concurrent delegations' reports separate） |
| `src/main/agent-subagents.test.ts` | 1 failed：`expected {} to match object { total: 1, done: 1 }` |

环境说明：本次父代理运行在 TACode 沙箱（macOS Seatbelt，workspace-write）内，vitest 收尾阶段
报 `Unhandled Rejection: kill EPERM`（沙箱禁止终止子进程），且 `/tmp` 写入被拒。
`agent-subagents.test.ts` 需要 spawn 真实 RPC worker 并写 `TETHER_HOME`，其红灯**根因待非沙箱环境复跑确认**；
但第一轮报告（在相同断言上）也观察到同样的红灯，两轮独立观察一致，回归基线仍未建立。

## 3. 本次暴露的问题

### P1-1 委派子会话的 `childRuntimeId` 恒为空（实测 + 代码双向确认）

- 实测：两条 `delegation completion judged` 日志中 `childRuntimeId` 都是 `""`。
- 代码：`AgentHost.runtimeId` 只在 `src/main/agent-manager.ts:187` 被赋值；
  委派路径由 `delegation-coordinator.ts:319,389` 调 `createHost()` 直接 `new AgentHost(...)`，
  从未写 `runtimeId`，而 `src/main/agent-host.ts:73` 的初值就是 `""`。
- 影响：日志/诊断里 `childRuntimeId`（`delegation-coordinator.ts:484`）与
  `describeFailure` 输出（`:533`）永远是 `unknown`/空，委派故障无法按 runtimeId 对账，
  这正是第一轮「故障无法自证」问题的残留分支。
- 建议：`createHost` 注入处补 `host.runtimeId = runtimeId`（与 agent-manager 一致），
  或在 `AgentHost` 构造函数接收 runtimeId；并加一条断言日志字段非空的单测。

### P1-2 桥接路径下 `maxTurns` / `thinkingLevel` 不生效

- `src/main/index.ts:1995-2043` 的 `buildStartOptions` 返回值只带 `provider/permission/sandbox/
  network/cwd/sessionPath/model/baseUrl/maxTokens/activeTools/delegationDepth/扩展`，
  **没有 `maxTurns`、没有 `thinkingLevel`**；`src/shared/types.ts:81-94` 的 `AgentStartOptions`
  同样没有这两个字段。
- 后果：`explorer/code-reviewer` 定义的 `maxTurns: 40`、`fixer: 60`、`test-runner: 30`
  在默认（桥接）路径完全无效，子代理只受 30 分钟兜底超时约束
  （`delegation-coordinator.ts` 的 `completionTimeoutMs`）。本次 explorer 跑到 38 轮已接近上限，
  若定义生效会提前收口。
- 建议：把 `maxTurns`/`thinkingLevel` 透传进 start options 与类型；否则至少删除定义中的字段，
  避免「配了不生效」的隐形承诺。

### P2-1 报告长度上限双轨（12 000 vs 50 000）

- 本地 fallback 用 `MAX_SUBAGENT_REPORT_CHARS = 12_000`（`src/shared/subagents.ts:58`，
  `src/runtime/tools/delegate.ts:146-148`）；桥接路径主进程侧是 `boundedDelegationText`
  默认 50 000（`delegation-coordinator.ts:589-591`），回灌时再拼 `remoteReportBlock`。
- 后果：同一条委派链路，两条路径的父上下文预算不一致，桥接路径可能一次灌入约 4 倍文本。
- 建议：收敛为一个共享常量，并让日志记录「截断前后字符数」以便观测。

### P2-2 权限兜底不保守

- `src/main/delegation-coordinator.ts:741-745`：`parent` 缺失或非法时 `parentMode` 回退 `"auto"`。
- 后果：若调用方漏传父权限，而父会话实际是 `plan`，子代理反而拿到比父更宽松的 `auto`（相对越权）。
- 建议：兜底值取最保守（`plan`），并在回退时写 warn 日志；`effectivePermission` 可导出后单测。

### P2-3 完成事件可静默丢失 → 卡片长期 stale

- `src/main/index.ts:2044`：`emitEvent` 用 `agentManager.findBySession(parentSessionPath)?.sendDelegationEvent(...)`，
  父 host 找不到时事件被静默丢弃；渲染层后台卡片状态主要靠父模型再调
  `delegate_wait/list/stop` 的 details 回填（`src/renderer/conversation.ts:1007-1027`）。
- 后果：父模型不主动调用这些工具时，UI 卡片会停在 running/stale；本次因父模型同步 `delegate` 才没有暴露。
- 建议：父会话缺失时把事件落到状态库，渲染层订阅状态库变化；或在不丢事件的前提下重试投递。

### P3-1 定义与注释自相矛盾：`test-runner` 被判为「可写」

- `src/runtime/subagents.ts:35` 注释写「只有 fixer 可写」，但 `test-runner` 声明了
  `exec_command`/`write_stdin`（`:67-81`），而这两个工具在
  `src/shared/subagents.ts:26-32` 的 `SUBAGENT_MUTATING_TOOLS` 里 → `subagentCanMutate` 返回 true。
- 后果：UI/权限提示与注释不一致，容易被误读为「test-runner 是只读的」。
- 建议：要么把「可写」定义收窄为文件写入类工具，要么改注释为「可执行命令」并同步 UI 文案。

### P3-2 并发/超时常量在两处重复

- `MAX_SUBAGENT_CONCURRENCY = 8`（`src/shared/subagents.ts:55`）与
  `DELEGATION_MAX_CONCURRENCY = 8`（`src/shared/delegation.ts:35`）各存一份；
  超时同样并存（本地 600s / 桥接 3600s / 兜底 30 分钟）。
- 建议：抽到 `src/shared/` 单一来源，避免两条路径漂移。

## 4. 子代理「使用体验」层面的问题与建议

1. **单个子代理成本不低**：本次两个只读子代理分别用了 38/41 轮、48/63 次工具调用、2–3.3 分钟。
   委派问题必须窄：把「分析整个项目」拆成「链路 A 的调用顺序」这类可证伪的问题，收口更快。
2. **报告长度要与任务匹配**：实测回传 4735 / 2805 字符都在安全区间；但如果要求子代理「列出全部文件」，
   桥接路径最多会灌 50 000 字符进父上下文。给子代理的 prompt 里应显式写「结论优先、≤1500 字」。
3. **角色选择**：链路/定位用 `explorer`，改动后找缺陷用 `code-reviewer`，验证用 `test-runner`，
   有界改写用 `fixer`；只读任务的报告可信度最高（本次两份都带 `file:line` 证据）。
4. **并行优于串行**：两个子代理同时启动，墙钟等于较慢者（198s），串行会是 320s 左右；
   默认应该用一次 `delegate` 提交多个 task。
5. **要求子代理标注不确定**：本次两份报告都带「不确定」小节，父代理据此才能区分结论与猜测，
   建议把这条写进自定义子代理的 prompt 模板。
6. **父代理要主动收口卡片状态**：因为事件通道可能丢（P2-3），父代理在后台委派后应调用
   `delegate_wait`/`delegate_list` 回填状态，否则 UI 会一直显示运行中。

## 5. 建议的落地顺序

| 优先级 | 事项 | 落点 |
| --- | --- | --- |
| 1 | 委派 host 写入 `runtimeId`，诊断字段不再为空 | `src/main/index.ts:180-202` / `agent-host.ts:73` |
| 2 | 透传 `maxTurns` / `thinkingLevel` 到 start options 与类型 | `src/main/index.ts:1995-2043`、`src/shared/types.ts:81-94` |
| 3 | 让 `agent-subagents.test.ts` 变绿（或在非沙箱复跑确认根因） | `src/main/agent-subagents.test.ts:126` |
| 4 | 统一报告上限常量（12 000）与并发/超时常量来源 | `src/shared/subagents.ts:58`、`src/shared/delegation.ts:32-35` |
| 5 | 权限兜底改保守值 + 导出 `effectivePermission` 补单测 | `src/main/delegation-coordinator.ts:741-745` |
| 6 | 委派事件缺失父 host 时不丢（落库/重试） | `src/main/index.ts:2044`、`src/renderer/conversation.ts:1007-1027` |
| 7 | 修 `test-runner` 可写性与注释/UI 文案不一致 | `src/runtime/subagents.ts:35,67-81` |

> 未验证项：`code-reviewer` 报告中 `continue` 硬编码 `workspace-write`（`delegation-coordinator.ts:329`）、
> `launch` 与 `close()` 竞态产生「终态 + 存活进程」（`:372-397`）、
> `stop()` 未唤醒 `waitForIdle` 的 waiter（`agent-host.ts:413-440`）、
> cacheKey 复用 `requestId`（`:124`）四条本次未复现，父代理仅做了代码级核对，标注为待验证。
