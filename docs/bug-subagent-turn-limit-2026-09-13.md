# Bug 报告：子代理「轮次上限」留空并非不限制，界面文案与实现不一致

> 处理状态（2026-09-13）：已按用户选择修复为「留空真正不限制轮次」。第 1–11 节保留修复前的调查记录，最终实现和验证见第 12 节。

日期：2026-09-13
分支：`main`（工作树有 12 个未提交改动，见文末「基线」）
影响面：子代理委派（delegate）、子代理设置界面、进程内子代理路径
严重度：中高——不是崩溃，是静默降级：用户以为没有上限，实际被 60 轮截断，且工具层仍返回成功

---

## 1. 一句话结论

设置界面承诺「轮次上限留空表示不限制」（`src/shared/i18n.ts:406-407`），但代码把「留空／非法值」统一回退成常量 `MAX_SUBAGENT_MAX_TURNS = 60`（`src/shared/subagents.ts:69`）。当前代码库中不存在任何能表达「不限制」的取值：留空 → 60，写 999 → 收敛到 60，写 0/负数/小数 → 当作未设置 → 60。

底层（worker 侧）其实天然支持「不设上限」，是父层三处默认值把它顶成了 60。详见 §3。

## 2. 现象与复现

1. 设置 → 子代理 → `code-reviewer`，「轮次上限」输入框留空，界面显示灰色占位符「不限制」。
   该占位符来自 `src/renderer/subagent-settings.tsx:422` 的 `placeholder={t("subagents.maxTurnsUnlimited")}`，仅在输入为空时显示——它是占位符，不是已生效的值。
2. 保存后落盘 `~/.tacode/subagents/code-reviewer.md`，frontmatter 中没有 `maxTurns` 行（`src/renderer/subagent-draft.ts:114`：`...(draft.maxTurns ? { maxTurns } : {})`，0 时省略字段）。
3. 主代理收到的子代理目录（catalog）却显示 `code-reviewer (tools: ...; maxTurns 60; thinking max)`。
   原因：`src/shared/subagents.ts:208` `const turns = item.maxTurns ?? MAX_SUBAGENT_MAX_TURNS;` —— 渲染目录时就把缺省值填成 60 展示。
4. 实际运行：跑到 60 轮被收口，委派终态落 `truncated`，报告是工具调用之间的过程旁白（例如 `Now let me examine the agent-manager and index.ts delegation wiring.`），而父代理收到的工具结果仍是成功。

实测记录（本次真实发生）：一次 `code-reviewer` 委派以 `truncated` 结束，报告为上述旁白；该委派必须由主代理再用 `delegate_continue` 补问才拿到正式报告。同一时期 `explorer` 委派正常收敛。

## 3. 根因：调用链逐层核对

「不限制」的语义在链路上被逐层替换成 60，每一层都有明确位置：

| # | 层 | 位置 | 留空时的行为 |
| --- | --- | --- | --- |
| 1 | 草稿/界面 | `src/renderer/subagent-draft.ts:41,81,95,114` | 注释写「0 表示不限制」，写文档时省略 `maxTurns` |
| 2 | 文档解析 | `src/shared/subagents.ts:350-379` | 非法值忽略并告警；>60 收敛；省略 → `undefined` |
| 3 | 定义合并 | `src/shared/subagents.ts:403-410` | 用户文档整体替换同名内置定义（`merged.set(name, definition)`），不做字段级合并 |
| 4 | 目录渲染 | `src/shared/subagents.ts:203-210` | `?? MAX_SUBAGENT_MAX_TURNS` → 主代理看到的 catalog 显示 60 |
| 5 | 桥接下发出参 | `src/main/index.ts:2250` → `src/main/delegation-run-options.ts:54-64` → `:37-43` | `return MAX_SUBAGENT_MAX_TURNS` → 60 |
| 6 | worker 环境变量 | `src/main/agent-host.ts:335` | 下发 `TACODE_MAX_TURNS=60` |
| 7 | worker 内收口 | `src/runtime/extension.ts:312-326` + `src/runtime/turn-limit.ts:10-39` | `turn_end` 计数到 60 主动 `ctx.abort()` |
| 8 | 父侧看门狗 | `src/main/delegation-coordinator.ts:617`、`:643-652`（`TURN_LIMIT_POLL_MS=500`）、`:754-766` | 每 500ms 轮询，到 60 落 `truncated` |
| 9 | IPC 校验 | `src/main/ipc-validation.ts:177-179` | 只接受 `1..MAX_SUBAGENT_MAX_TURNS` |
| 10 | 进程内子代理路径 | `src/runtime/tools/delegate.ts:287` | `definition.maxTurns ?? MAX_SUBAGENT_MAX_TURNS` → 60 |

### 关键点：底层本就支持「不限制」

`src/runtime/turn-limit.ts:10-16` 的 `parseTurnLimit` 对非正整数/畸形值返回 `undefined`；`:25-26` 的 `createTurnLimiter(limit: number | undefined)` 在 `undefined` 时返回 `undefined`，注释原文：

> `/** 未配置上限时返回 undefined，调用方据此不注册任何钩子。 */`

`src/runtime/extension.ts:315-316` 据此不注册任何钩子。也就是说「不限制」在 worker 层是可表达、已实现的状态；`undefined` 一旦从父层传下来，行为就是真正不限制。是第 5、8、10 层的默认值把它顶成了 60。

### 相关注释与实现自相矛盾

- `src/main/delegation-run-options.ts:33-36`：「没配则与进程内路径用同一个默认值——两条路径的收口语义必须一致」
- `src/renderer/subagent-draft.ts:41`：「0 表示不限制（frontmatter 里省略 maxTurns）」

两处注释对同一个 `undefined` 给出相反语义，说明这不是笔误，而是「默认 60」与「留空即不限」两套设计意图同时留在了代码里，最终实现取了前者、文案取了后者。

## 4. 为什么用户完全看不出来（静默降级链）

1. `src/runtime/tools/delegate.ts:210`：`success: record.status === "completed" || record.status === "truncated"`
   → `truncated` 对父代理返回 `success: true`，父代理不区分「正常交付」与「撞上限截断」。
2. `src/runtime/tools/delegate.ts:164`：文案 `truncated (turn limit)`；界面 `src/renderer/browser/child-session-panel.tsx:25` → `t("subagent.limitReached")`（"已达到轮次上限"）。线索只存在于状态字段与这句文案里。
3. `src/main/delegation-coordinator.ts:673` 注释明示这是有意取舍：「收口而非失败：保留已产出的报告，状态落 truncated（渲染层按完成态展示）」。

## 5. 附带影响：定义整体覆盖会顺带丢掉内置的其它字段

`src/shared/subagents.ts:403-410` 是整对象替换。以 `code-reviewer` 为例：

- 内置定义（`src/runtime/subagents.ts:62-70`）：`tools` 含 `exec_command`、`thinkingLevel: "high"`、`maxTurns: 40`
- 用户文档 `~/.tacode/subagents/code-reviewer.md`：`tools` 只有 3 项（无 `exec_command`）、`thinkingLevel: max`、无 `maxTurns`
- 合并后：无 `exec_command`、`max`、`maxTurns` → 60

后果：`maxTurns` 从内置的 40 反而涨到 60；同时少了 `exec_command`，取证只能反复 `read_file`（只读命令白名单路径被关闭），同样信息量消耗更多轮次，更容易撞上限。这不是本 bug 的根因，但会放大它的触发概率。

---

## 6. 修复方案

两个方案互斥，需先决策：**A = 让文案与实现一致（保持 60 默认）**，**B = 真正实现「不限制」**。

### 方案 A：只改文案（最小改动，无行为风险，建议先做）

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `src/shared/i18n.ts` | `:405-407`、`:419`（中文） | 「留空表示不限制」→「留空按默认上限 60 轮处理」；`subagents.maxTurnsUnlimited`（`:407`）的字面值「不限制」需同步改成「默认 60 轮」或类似表述 |
| `src/shared/i18n.ts` | `:1188-1190`（英文） | 同上对齐 `No limit` → 默认值表述 |
| `src/renderer/subagent-settings.tsx` | `:422-423` | placeholder 用的是 `subagents.maxTurnsUnlimited`，改 key 文案即可；注意 key 名语义已不符，可考虑重命名 |
| `src/renderer/subagent-draft.ts` | `:41` | 注释「0 表示不限制」→「0 表示未设置（走默认上限）」 |

验收：无行为变化，`pnpm test` 应全绿（现有断言都按 60 默认值写的，见 §7）。

### 方案 B：真正支持「不限制」

需要引入显式哨兵（不要再用「留空」表达，否则无法与「未设置」区分）。建议哨兵：frontmatter 写 `maxTurns: -1` 或 UI 提供独立「不限」开关。改动点（缺一不可）：

1. `src/shared/subagents.ts:105` 类型放宽；`:350-379` 解析放行哨兵；`:396` 的 `renderSubagentDocument` 参与 round-trip（`src/shared/subagents.test.ts:140-160` 有 round-trip 断言）
2. `src/renderer/subagent-draft.ts:41,95,114` + `src/renderer/subagent-settings.tsx:417-426`：输入框需有明确「不限」选项，不能只靠留空
3. `src/main/delegation-run-options.ts:37-43` 返回 `Infinity` 或显式 `undefined`；`:54-64` 的返回类型 `{ maxTurns: number }` 需改为可选
4. `src/main/delegation-coordinator.ts:617` 允许无限；`:643-652` 应显式不创建 `limitTimer`（仅靠 `turns - baselineTurns >= Infinity` 永假会比较浪费）；`:754` 判定跳过
5. `src/main/agent-host.ts:335` 不下发 `TACODE_MAX_TURNS`（下发链本就支持缺省，见 §3）
6. `src/main/ipc-validation.ts:177-179` 放行哨兵
7. `src/runtime/tools/delegate.ts:287` 进程内路径同步（`:317-323` 的 `turns >= maxTurns` 收口需跳过）

风险：失去轮数兜底后只剩完成超时 30 分钟（`src/main/delegation-coordinator.ts:118` `DEFAULT_COMPLETION_TIMEOUT_MS`）与「停止子代理」按钮；跑飞的委派会长时间占用并发槽。若要做，建议同时在界面上给出显式警告文案。

## 7. 现有测试会拦住哪些改动（修改时需同步）

以下断言把「默认 60」钉死了，属于方案 A 无需动、方案 B 必须改的部分：

- `src/main/delegation-run-options.test.ts:37-42`：断言 `{}`、`0`、`-3`、`2.5`、`"40"` 全部 → `MAX_SUBAGENT_MAX_TURNS`
- `src/main/delegation-run-options.test.ts:44-45`：`999` 与 60 都收敛到 60
- `src/main/delegation-run-options.test.ts:48-50`：`expect(MAX_SUBAGENT_MAX_TURNS).toBe(60)`（注释称「默认值与内置角色定义一致」）
- `src/shared/subagents.test.ts:115-127`：`maxTurns: 999` 收敛、非法值忽略并告警
- `src/renderer/subagent-draft.test.ts:35-41`：`maxTurns: 0` 视为合法（`expect(...Error(draft({ maxTurns: 0 }))).toBeNull()`）
- `src/main/delegation-coordinator.test.ts:823` 附近：按 explorer 的 `maxTurns: 40` 跑到边界

## 8. 验收命令

```bash
pnpm test src/main/delegation-run-options.test.ts src/shared/subagents.test.ts src/renderer/subagent-draft.test.ts src/main/delegation-coordinator.test.ts
pnpm test
pnpm typecheck
```

## 9. 与本次一并记录的相邻缺陷（独立问题，可分开修）

- D1 撞上限时跳过报告补救：`src/main/delegation-coordinator.ts:754-768` 的收口分支在 `:770-790` 的「再要一次最终报告」（`DELEGATION_REPORT_NUDGE`）之前 `return`，因此撞线时该补救永不执行，直接把过程旁白落成报告。
- D2 旁白识别对多轮运行失效：`src/shared/delegation.ts:92-97` 的 `isPreambleReport` 有 `if (run.turns > 1 || run.toolCalls > 0) return false;`，只要多轮或调用过工具就判否；配合 `:100-119` `extractAssistantReport`（倒序取最后一条有文本的 assistant 消息），必然把过程旁白当正式报告。
- D3 截断冒充成功：`src/runtime/tools/delegate.ts:210` 把 `truncated` 计入 `success: true`，父代理无法区分交付与截断。

## 10. 未验证事项（不要把推断当结论）

- 未在界面改值后真实复现一次撞线（改了设置需重新构建并完整重启 TACode、新建 Agent 会话才生效，见 `docs/subagent-workflow.md` 末节）。
- 未确认 worker 侧（`src/runtime/extension.ts:315-326`）与父侧看门狗（`delegation-coordinator.ts:643-652`）哪一个先命中；`src/runtime/extension.ts:313-314` 注释称父侧「按同一上限兜底收口」，但两侧计时起点未逐帧核对。
- 本次 `truncated` 的具体轮次数未取证：判定日志在 `src/main/delegation-coordinator.ts:744-753`（`delegation completion judged`，含 `turns` / `turnLimit` / `hasReport`），可按 `delegationId` 查诊断日志确证。
- 结论均为静态代码路径 + 单次运行观测，未做进程级实测。

## 11. 基线（改动前状态）

- 分支 `main`，工作树 12 个未提交改动：`src/main/delegation-coordinator.ts`、`src/main/delegation-coordinator.test.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/browser/child-session-panel.tsx`（及 `.test.ts`）、`src/renderer/browser/delegation-tabs.ts`、`src/renderer/browser/workbench-panels.tsx`、`src/renderer/delegation-state.test.ts`、`src/runtime/tools/delegate.ts`、`src/shared/delegation.ts`、`src/shared/types.ts`
- 本报告撰写前实测基线：`pnpm test src/main/delegation-coordinator.test.ts src/main/agent-lifecycle.test.ts src/renderer/delegation-state.test.ts src/runtime/tools/delegate-remote.test.ts --reporter=dot` → exit 0，Test Files 4 passed、Tests 77 passed；`pnpm typecheck` → exit 0
- 注意：上述 12 个文件中 `src/runtime/tools/delegate.ts`、`src/main/delegation-coordinator.ts` 正在被改动，修改前请先确认别人是否已动过 §6 涉及的行号

## 12. 修复结果（2026-09-13）

用户确认采用「留空真正不限制轮次」。沿用已有的省略 `maxTurns` 表达方式，无需新增哨兵、配置迁移或界面开关；同名用户定义整体覆盖内置定义，因此清空内置角色的上限也会生效。

- `src/shared/subagents.ts`：共享 `resolveSubagentMaxTurns` 解析规则，缺省表示不限；主代理目录显示 `maxTurns unlimited`。60 只作为显式上限允许的最大值。
- `src/main/delegation-run-options.ts`：留空时省略启动选项中的 `maxTurns`，首次启动和续跑重建选项使用相同语义。
- `src/main/delegation-coordinator.ts`：无上限时不创建轮次轮询定时器，也不按轮次将报告判为 `truncated`。
- `src/runtime/tools/delegate.ts`：进程内路径使用同一解析规则，仅在配置了上限时按轮次中止。
- `src/main/agent-host.ts`：未配置上限时显式清除 worker 继承的 `TACODE_MAX_TURNS`，避免启动环境重新施加隐藏限制。
- 显式的 1–60 轮上限、手动停止及桌面委派完成超时继续生效。第 9 节列出的报告补救、旁白识别与 `truncated` 成功标记是独立问题，本次未调整。

回归测试以 FakeAgent / FakeHost 驱动 65 轮，覆盖首次委派、复用 worker 续跑、重启 worker 续跑，以及不限轮次时的停止、超时和无轮次轮询；另验证清空内置角色后的保存重载与 worker 启动环境。修复前相关断言失败，修复后 6 个定向测试文件、114 个用例全部通过。

全量验证：`pnpm test --reporter=dot` 通过（106 个文件、929 个用例）；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。

Electron 验证：浏览器和消息列表冒烟通过。`pnpm test:browser` 首次在窄面板布局检查超时；单独复跑工作台后该检查通过，但在 `scripts/workbench-smoke.ts:247` 的 `activity fallback` 断言失败。该断言要求无转录的进程内委派显示活动记录，当前已提交的 `ChildSessionPanel` 回退区域仅展示最终报告；测试脚本与面板代码均未在本次修改。因此综合冒烟尚未整体通过，后续工作台断言也未执行。消息列表通过 `TACODE_SMOKE_ONLY=message-list node scripts/test-browser.mjs` 单独验证。

源码构建后需完整重启 TACode，并启动新的 Agent 会话，已运行的主进程与 worker 才会切换到修复后的逻辑。
