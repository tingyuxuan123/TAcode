# TACode 子代理实测记录与问题汇总（第二轮 2026-09-10）

本文件记录一次真实的委派测试：父代理通过 `delegate` 同步启动 2 个只读子代理分析本仓库，
再汇总「子代理使用过程中出现的问题 + 优化建议」。第一轮报告见
`docs/subagent-analysis-2026-09-10.md`。

> 成稿于 2026-09-10。文中日志与数据目录路径已按改名后的现状（`~/.tacode`）更新；当时的路径为 `~/.tether`。

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

数据来自 `~/.tacode/logs/tacode.log` 的 `scope=delegation` 记录：

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
`agent-subagents.test.ts` 需要 spawn 真实 RPC worker 并写 `TACODE_HOME`，其红灯**根因待非沙箱环境复跑确认**；
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
| 3 | ~~让 `agent-subagents.test.ts` 变绿~~ **已核实不需要修**：非沙箱环境复跑 green（`1 passed, 3.3s`），原红灯是 Seatbelt 沙箱禁止 spawn 子进程所致，不是代码回归 | `src/main/agent-subagents.test.ts:126` |
| 4 | 统一报告上限常量（12 000）与并发/超时常量来源 | `src/shared/subagents.ts:58`、`src/shared/delegation.ts:32-35` |
| 5 | 权限兜底改保守值 + 导出 `effectivePermission` 补单测 | `src/main/delegation-coordinator.ts:741-745` |
| 6 | 委派事件缺失父 host 时不丢（落库/重试） | `src/main/index.ts:2044`、`src/renderer/conversation.ts:1007-1027` |
| 7 | 修 `test-runner` 可写性与注释/UI 文案不一致 | `src/runtime/subagents.ts:35,67-81` |

> 未验证项：`code-reviewer` 报告中 `continue` 硬编码 `workspace-write`（`delegation-coordinator.ts:329`）、
> `launch` 与 `close()` 竞态产生「终态 + 存活进程」（`:372-397`）、
> `stop()` 未唤醒 `waitForIdle` 的 waiter（`agent-host.ts:413-440`）、
> cacheKey 复用 `requestId`（`:124`）四条本次未复现，父代理仅做了代码级核对，标注为待验证。

---

## 6. 第三轮：逐条核实与修复（2026-09-10 下午）

对第 3、5 节的所有条目做了独立代码核实（三个只读子代理并行 + 父代理复跑测试），结论与落地如下。

### 6.1 核实中发现的更正

| 条目 | 原说法 | 核实结果 |
| --- | --- | --- |
| 测试基线 | `agent-subagents.test.ts` 仍红，回归基线未建立 | **不成立（环境问题）**：`npx vitest run --no-file-parallelism --pool=forks src/main/agent-subagents.test.ts` → `1 passed (3.3s)`；`pnpm test` 全量 green。原红灯是 Seatbelt 沙箱禁止 spawn/写 `/tmp`，不是代码回归 |
| P1-2 `thinkingLevel` | 与 `maxTurns` 并列，都「没透传」 | **只差一行**：桥接 payload 已带 `thinkingLevel`（`runtime/extension.ts:214`），只是主进程 `buildStartOptions` 不读；`effort → --effort → --thinking` 通道现成 |
| P1-2 `maxTurns` | 「不生效」 | **比说法更重**：不只是没透传，pi 打包物根本没有轮数参数，桥接链路上没有任何接收方（只有进程内 `runtime/tools/delegate.ts` 消费），全链路需要新开通道（属 B 批） |
| P2-3 事件丢失 | 「UI 卡片 stale」 | **后果更重**：父 host 被 `agent.stop()` 停过（换模型/切项目/新对话都会）时，后台子代理的**报告永远进不了父会话上下文**；且渲染层没有任何直达通道（子 host 事件被 `index.ts:183` 的 `if (!delegationId)` 拦掉） |
| P3-1 `test-runner` 可写 | 「UI/权限提示与注释不一致」 | **UI 部分不成立**：设置页没有 writable 标记，也没有按 canMutate 降权限的代码。真实后果是另外两条：① `delegate.ts` 给 test-runner 的 system prompt 写的是 "You may change files"，与它自己的 "Never edit files" 打架；② plan 模式下 `exec_command` 被剔除 → test-runner 跑不了测试 |

### 6.2 本轮已修复（A 批）

| # | 事项 | 落点 |
| --- | --- | --- |
| A1 | 委派 host 注入 `runtimeId`；协调器侧再兜底 + 告警，`childRuntimeId` 不再为空 | `src/main/index.ts:205`、`delegation-coordinator.ts` 的 `createDelegationHost()` |
| A2 | `thinkingLevel` 真正进启动选项（payload 优先，缺字段回落角色定义，覆盖 `continue()` 重建 payload 的场景） | 新增 `src/main/delegation-options.ts` + `index.ts` 的 `buildStartOptions` |
| A3 | 报告上限收敛为唯一来源 `DELEGATION_MAX_REPORT_CHARS = 12_000`（本地/落库/回灌同一预算） | `src/shared/delegation.ts:32`、`src/shared/subagents.ts` |
| A4 | 权限兜底保守化：`effectivePermission`（新委派）回退值 `auto` → `plan` 并导出；`index.ts` 的 `buildStartOptions` 同步；父权限缺失/非法时写 warn 日志。**水合回退保持 `auto`**（理由见 7.1） | `delegation-coordinator.ts` 的 `effectivePermission`/`start`、`index.ts:2020` |
| A5 | 并发与超时常量单一来源；本地 600s 与桥接 3600s 的差异改成具名常量而非硬编码 | `shared/delegation.ts`、`shared/subagents.ts`、`runtime/tools/delegate.ts`、`delegation-coordinator.ts` |
| A6 | 拆出 `SUBAGENT_FILE_WRITE_TOOLS` + `subagentEditsFiles()`；提示词三分支，test-runner 不再被告知「可以改文件」；注释同步 | `shared/subagents.ts`、`runtime/tools/delegate.ts`、`runtime/subagents.ts` |
| A7 | 本文档与 `.agents/progress.md` 回写 | — |
| A8 | 验证：`pnpm typecheck` + `pnpm test`（65 文件 / 560 用例，全部通过） | — |

新增回归用例：`src/main/delegation-options.test.ts`（3）、`delegation-coordinator.test.ts`（runtimeId 兜底 + `effectivePermission` 3 条）、`shared/subagents.test.ts`（可写性/常量来源 2 条）、`runtime/tools/delegate.test.ts`（提示词分支 2 条）。

### 6.3 本轮未做（B 批，待排期）

- **B1 `maxTurns` 全链透传**：需要新增通道（`shared/types.ts` → `index.ts` → `agent-host.ts` 环境变量 → `runtime/options.ts` → `runtime/extension.ts` 的 `turn_end` 计数 + `ctx.abort()`），并决定「到上限」映射为 `truncated` 还是 `failed`（若映射为 failed，用户看到的仍是失败，等于没修）。
- **B2 委派事件不丢**：父 host 缺失时兜底送渲染层（`index.ts:2043` + `agent-host.ts:407` 返回 boolean + preload 新通道 + App 刷新），并处理「父 host 被杀后报告进不了父上下文」这条更重的问题。
- 4 条未验证项（`continue` 硬编码 sandbox、launch/close 竞态、`stop()` 未唤醒 waiter、cacheKey 复用）保持原状。

---

## 7. 审查后的调整（同日下午，A 批自审）

A 批落地后做了一次只读对抗式审查，按其结论调整了 5 处：

1. **水合兜底回退到原行为 + 告警**（`delegation-coordinator.ts` 的 `hydratePersistedEntries`）：原计划把水合时的 permission 兜底也从 `auto` 改成 `plan`，审查指出这条记录是**我们自己此前授予的权限**（不是父会话的），旧行缺字段时猜成 `plan` 会让 `fixer` 之类的续跑被剥掉全部写工具、而提示词仍承诺可改文件 → 续跑必然失败。`effectivePermission`（新委派的相对越权路径）保持 `plan`，水合这条改成「保留 `auto` + 写 warn 日志留痕」；正确修法是从子会话把真实权限取回来（待排期）。
2. **`delegationModelOptions` 收口值域**：只接受 `SUBAGENT_THINKING_LEVELS` 内的档位，非字符串/未知档位一律回落（否则畸形桥接 payload 会让 `.trim` 抛错，或把非法值塞进 `--thinking` 导致 worker 启动失败）。
3. **截断可观测**：`settle()` 的日志新增 `reportCharsRaw` 与 `reportTruncated`（上限 50k → 12k 后，要能从日志看出报告是否被削过）。
4. **报告预算前置**：`composeSubagentSystemPrompt`（本地路径）与 `composeChildTask`（桥接路径）都加了一行「≤1500 字符、结论优先」的明确预算，减少触碰上限的概率；`remoteReportBlock` 在报告确实被截断时附上子会话文件路径（`[report truncated; full text: …]`），父模型可用 `read_file` 读回完整报告——这是 12 000 上限下唯一的取回路径。
5. **测试补强**：钉住常量数值本身（原来只断言「两者相等」是同义反复）+ `boundedDelegationText` 默认上限的截断行为；新增「父权限缺失 → 子会话以 plan 起步并告警」与「超长报告在 settle 处按新上限截断且日志记录前后字符数」两条用例。

**已知测试缺口**（无法在本仓库单测，需接受）：`index.ts` 的两处接线（`createAgentHost` 写 `runtimeId`、`buildStartOptions` 展开 `delegationRunOptions`）依赖 Electron 与用户配置，删掉这两行测试仍会全绿；目前靠协调器侧的 runtimeId 兜底用例与 `delegation-run-options.test.ts` 的纯函数用例间接覆盖。若要真正钉住接线，需要把 `buildStartOptions` 抽成可注入的纯函数（改动面较大，未做）。

---

## 8. B1：`maxTurns` 全链生效（到上限 = truncated）

产品语义由用户拍定：**到轮数上限算收口（`truncated`，保留已产出的报告），不算失败**。

### 8.1 链路

```
角色定义 definition.maxTurns
  → delegationRunOptions()（src/main/delegation-run-options.ts，纯函数 + 单测）
  → AgentStartOptions.maxTurns（src/shared/types.ts）
  → 子 worker 环境变量 TACODE_MAX_TURNS（src/main/agent-host.ts）
  → runtime turn_end 钩子计数，到上限 ctx.abort()（src/runtime/extension.ts）
  → 协调器按同一上限判定 truncated（src/main/delegation-coordinator.ts）
```

### 8.2 两侧各做什么

| 位置 | 行为 |
| --- | --- |
| runtime（子 worker 自己） | `turn_end` 计数，到 `TACODE_MAX_TURNS` 主动 `ctx.abort()`（保留已产出内容，优于被强杀），随后清零计数——同一 worker 会被 `delegate_continue` 复用，续跑要拿新预算，否则第二轮会立刻撞上限 |
| 协调器（主进程，判定权威） | ① `collectReport` 判定阶段：本次运行新增轮次 `turns >= limit` → 落 `truncated` 并保留报告（**先于** 原来的 `no_report → failed` 分支，因此「到上限但没写出最终文本」不再误判为失败）；② 看门狗：每 500ms 轮询 `get_messages`，超限则停 worker 并落 `truncated`，避免只能等 30 分钟兜底超时 |
| 轮次口径 | 按「本次运行新增的 assistant 轮次」计（`turns - baselineTurns`）。`continue()` 复用同一 worker，用绝对轮次会让续跑立刻撞上限 |
| 上限取值 | `definition.maxTurns`（explorer/code-reviewer 40、test-runner 30、fixer 60），非法值回落 `MAX_SUBAGENT_MAX_TURNS`=60，并 `Math.min` 收敛——与进程内路径同一默认值，两条路径不再各算一套 |

### 8.3 验证

- 新增用例：`delegation-run-options.test.ts`（运行选项 + `delegationTurnLimit` 边界 7 条）、`delegation-coordinator.test.ts` 的 `describe("delegation turn limit")` 3 条（到上限 → `truncated` 且保留报告、`neverSettle` 时看门狗收口、上限内仍 `completed`）。
- FakeHost 新增 `assistantTurns` / `neverSettle` 开关以复现「多轮」与「不自收口」；顺带把一个既有用例（mid-turn crash）的 `reportDelayMs` 固定为 5s，让它不再依赖 0ms 定时器与 kill 的竞速。
- `pnpm typecheck` 通过；`pnpm test` 65 文件 569 用例通过。

### 8.4 仍存在的边界（记录在案）

- runtime 钩子本身没有端到端测试（需要真实 worker 跑满上限才可观测）；不过计数/解析逻辑已抽到 `src/runtime/turn-limit.ts` 并单测覆盖（含「每次运行重置」），协调器侧的同名判定也有单测，等于「即使 runtime 钩子失效，父侧仍会按上限收口」。
- 看门狗按 500ms 轮询，实际超限轮次可能比上限多出少量（可接受；连续运行的长任务不会被误判，因为基准是本次运行的轮次增量）。

### 8.5 B1 自审后的修正（同日下午）

B1 落地后做了一次只读对抗式审查，修掉两处真实缺陷：

1. **续跑预算被静默缩短（中高）**：runtime 侧原本是 worker 进程级计数器、只在上限处清零，而 `delegate_continue` 会复用同一个 worker——续跑只能拿到 `limit - N` 轮，父侧按「本次运行新增轮次」判定又算不到上限，于是一次被提前掐断的续跑被记成 `completed`。修法：把计数抽成 `src/runtime/turn-limit.ts` 的 `TurnLimiter`，并在 `before_agent_start`（每次运行开始）调用 `startRun()` 重置；同时补「`continue` 复用 worker 时按本次运行重新计预算」的协调器用例。
2. **基线读取在 try 之外（中）**：`runPrompt` 里 `await this.assistantTurns(entry)` 原本在 `try` 之前，RPC 抛错会让 `continue()` 的 `void this.runPrompt(...)` 变成未处理拒绝、且该条记录永远停在 `running`。修法：读基准包 try/catch；**读不到就本轮不启用上限**（`limit = Infinity` + warn），宁可等兜底超时也不误杀健康运行。

另外两处补强：

3. `src/main/ipc-validation.ts` 的 `validateAgentStartOptions` 补上 `maxTurns`（白名单漏字段会让经 IPC 打开的子会话丢预算；委派桥接链路本身不走 IPC，故不是当前回归）。
4. 用例补强：轮数恰好等于上限（边界 `>=`）、`continue` 后按新预算判定、`parseTurnLimit`/`createTurnLimiter` 的单测（含畸形值、重复 abort 抑制、跨运行重置）。
