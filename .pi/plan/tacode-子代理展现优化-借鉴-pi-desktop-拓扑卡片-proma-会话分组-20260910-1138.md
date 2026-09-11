# TAcode 子代理展现优化方案

## 背景与差距

对照三个项目「启用 2 个代理分析」同一场景的展现：

| 能力 | PI-Desktop | Proma | TAcode 现状 |
| --- | --- | --- | --- |
| 聚合卡片（x/y、总耗时） | ✅ "Subagent 正在工作 · 0/2 · 1m11s" | ✅ 等待屏障 "1/4 等待 Agent B" | ❌ 仅 "委托 · 0/2" chip |
| 节点信息（模型/步骤数/耗时） | ✅ 模型 + "60 个步骤" + 状态环头像 | ✅ 侧栏会话名 + 状态 | ❌ 仅 role + 状态字 + live 一行 |
| 点开看子代理实时活动 | ✅ 右侧"子智能体"抽屉（工具行/思考/回复实时滚动） | ✅ 子会话即完整会话，tab 打开 | ❌ 无法细看，只有一行 live 文本 |
| 完成后回看报告 | ✅ 抽屉/报告 | ✅ 会话永久保留 | ⚠️ 需展开工具行看纯文本 |
| 侧栏呈现 | — | ✅ 委托会话嵌套在父会话下 | ⚠️ 平铺、无分组、无运行状态点 |

**TAcode 已有地基（无需重做）**：
- `src/runtime/tools/delegate.ts` 的 `DelegationRunner` 已订阅子 agent 事件（`tool_execution_start`/`message_end`），已维护 `turns`/`toolCalls`/`usage`/`live`；
- delegate 工具 `details` 已含 `tasks[{id, delegationId, role, task, status, live, model, thinkingLevel}]` 与 `results`（含 output/usage），且随会话持久化，历史可回看；
- `src/renderer/conversation.ts` 已有 `delegateProgress` / `delegationStatuses`（lifecycle 回填）/ `mergeToolDetails` 合并；`DelegationRegistry.scheduleDelivery` 已有节流投递；
- 侧栏已标记 `sourceDelegationId` / `delegationRole`（`delegated-session` 类）；
- `delegate_wait/list/stop` 已有中文标签与汇总 chip；任务行已有 stale（2 分钟无活动）检测。

## 改动内容

### P0 信息密度升级（纯展示层 + 运行时小改）

1. **运行时：`src/runtime/tools/delegate.ts`**
   - `delegateDetails()` 的 `tasks[]` 每项补充 `startedAt`、`toolCalls`、`turns`（字段已在 `DelegationRecord` 上，仅透传）。
2. **渲染层：`src/renderer/conversation.ts`**
   - `DelegateTaskState` 增加 `startedAt?`、`toolCalls?`、`turns?`；`normalizeDelegateTask` 归一化。
3. **渲染层：`src/renderer/ui.tsx` + `styles.css`**
   - delegate 工具展开区改为**聚合卡片**：头部一行「Workflow 图标 + 委托 · done/total + 迷你进度条 + 总耗时（running 时 1s tick，全部 settle 后停止）」；
   - `DelegateTaskRow` 升级为拓扑节点风格：
     - 状态环头像（running=spinner 环、completed=✓、failed=✕、pending=空心）；
     - 首行：role + pin 的 model（`providerId/modelId` 短名）+ 状态字 + 单任务耗时（`startedAt` 起 tick，仅 running）；
     - 次行：任务描述（保留现有截断）；
     - 三行：live 步骤文本（现有）+ 步骤计数「N 个步骤」（`toolCalls`）；
   - 沿用现有 `FreezeCell`/`LIVE_CHILD_WINDOW` 机制，tick 定时器只挂 running 行并在 settle 后清除。

### P1 子代理详情抽屉（对齐 PI-Desktop「子智能体」面板）

4. **运行时：`src/runtime/tools/delegate.ts`**
   - `DelegationRunner` 订阅里维护**有界活动缓冲**（最近 60 条）：`tool_execution_start` → `{kind:"tool", name, target}`（复用 `describeToolCall`）；`message_end` → 助手文本长度/最终报告标记；maxTurns 等通知 → `{kind:"notice"}`。若运行时提供 `tool_execution_end` 则记录失败标记，否则降级只记 start；
   - 缓冲随 `details.tasks[].recent` 下发（复用 `scheduleDelivery` 节流）。
5. **渲染层：`src/renderer/ui.tsx` / `App.tsx` / `styles.css`**
   - 点击任务行打开**右侧抽屉**（App 级 overlay，复用 `.panel` 对话框样式）：
     - 头部：role 头像 + 模型 + 状态 + 耗时 + tokens（usage 有则显示）；
     - 主体：活动流（工具行 name+target、当前 live 行高亮）+ 完成后的 report markdown（复用现有 renderText）；
     - Esc/遮罩关闭；打开时对应任务行高亮；
   - 抽屉数据全部来自已持久化的 `details`，历史会话中同样可打开回看；
   - P1 抽屉为只读（不做 UI 直接 stop，停止仍由主 agent 调 `delegate_stop`）。
6. **i18n：`src/shared/i18n.ts`** 新增键：`delegate.elapsed`（耗时）、`delegate.steps`（N 个步骤）、`delegate.detailTitle`（子代理详情）、`delegate.detailEmpty` 等，中英文补全。

### P2 侧栏分组与等待屏障（借鉴 Proma，可后续会话实施）

7. `src/renderer/App.tsx` 侧栏：把 `sourceDelegationId` 会话**嵌套到父会话下**（缩进 + 折叠 chevron + running 状态点），点击打开该会话（现有能力）。
8. `delegate_wait` 工具行进行中时显示「等待子代理 done/total」实时进度（扩展 `delegateLifecycleChip`）。

## 验证

- `pnpm test`：扩展 `src/runtime/tools/delegate.test.ts`（tasks 透传 startedAt/toolCalls/turns、活动缓冲上限与降级）、`src/renderer/conversation.test.ts`（新字段归一化、lifecycle 回填不回归）、`src/renderer/execution-flow.test.ts` 及新增组件测试（聚合卡头部耗时/进度、行点击回调）；
- `pnpm typecheck` 通过；
- 手动验收：触发一次 delegate 2 任务 → 卡片显示 0/2、两节点计时与步骤数递增、live 文本刷新；点行打开抽屉看到实时活动流；完成后头像变 ✓、总耗时停止、抽屉可回看报告；重启进历史会话仍可打开抽屉。
