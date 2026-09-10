# TACode 子代理分析报告（2026-09-10）

本文件由两个 TACode 子代理（explorer / code-reviewer，均只读）产出，由父代理汇编。
两者都是通过 `delegate(background: true)` 启动、在子代理自然跑完后，从子会话 JSONL 的
最终 assistant 文本中提取的——原因见下文第 0 节。

## 0. 为什么必须这样取报告：委派回传缺陷

现象：`delegate` / `delegate_wait` 无论任务长短、并发与否、同步或后台，一律返回
`failed: The delegated worker finished without a report.`，但子代理其实跑完了。

证据（`~/.tether/state.sqlite` 的 `threads.delegation_completed_at` 对比子会话首条 user 消息时间）：

| delegationId | 判定为 failed 的时刻 | 子会话首条 user 消息 |
| --- | --- | --- |
| delegation-9fee67e8 | 05:42:02.952 | 05:42:02.951 |
| delegation-ba5a4974 | 05:42:02.971 | 05:42:02.970 |
| delegation-4c3b5193 | 05:42:53.593 | 05:42:53.503 |
| delegation-44d6e548 | 05:43:23.315 | 05:43:23.314 |
| delegation-b46aa35c | 05:43:36.625 | 05:43:36.624 |

判定发生在子代理**收到任务的同一毫秒**，而不是等它跑完；`delegation-44d6e548` 的完整报告
是在被判 failed 之后约 15 秒才写入会话文件的。

根因定位：`src/main/delegation-coordinator.ts:355-364` 的 `runPrompt`

1. `await entry.host.request("prompt", ...)` 立即返回（RPC `prompt` 不是阻塞到整轮结束的语义）；
2. 紧接着的 `get_messages` 只看到 user 消息；
3. `extractAssistantReport`（`src/main/delegation-coordinator.ts:540`）取不到文本；
4. 直接 `settle(..., "failed", "", "The delegated worker finished without a report.")`，不再等待。

对比：`src/runtime/tools/delegate.ts:350` 的本地实现用的是 `await agent.waitForIdle()`，
主进程这条路径缺少等子代理空闲这一步。

附带问题：`delegation-coordinator.ts` 没有注入任何诊断（无 `DiagnosticSink`），
`~/.tether/logs/tether.log` 对这类失败零记录；`runPrompt` catch 分支的错误信息也不含
`childSessionPath`，导致故障无法自证。

修复建议：
- 判定改为事件驱动或轮询：等子代理 `agent_settled`/空闲，或对 `get_messages` 做有上限的
  重试（直到出现 assistant 文本或超时）；
- 失败时把 `childSessionPath`、worker 退出码、stderr 摘要写入 `error`；
- 给 coordinator 接上 `LocalLogger`；
- 现有这条 `agent-subagents.test.ts:126` 单测就是红的（`expected {} to match object {total:1,done:1}`），
  可先让它变绿作为回归基线。

---

# 一、explorer 子代理报告：架构与代码地图

# TACode 架构与代码地图（只读分析）

> 工作目录：`/Users/yfdl/project/TAcode`。本报告基于源码静态阅读，未修改任何文件、未运行构建/测试。
> 结论均附 `文件路径:行号`。凡标注“不确定”处均为证据不足。

---

## 0. 总览

TACode 是 Electron 壳 + 自研 Agent Runtime 的分层结构：

```
React 渲染层 (src/renderer)
   │ preload contextBridge (src/preload)
   │ Electron IPC（typed contract: src/shared/types.ts）
   ▼
Electron 主进程 (src/main)
   │ 换行分隔 JSON-RPC over stdio + Node IPC（child.send）
   ▼
Agent Runtime worker (src/runtime → dist-electron/runtime/rpc-entry.js)
   │ 注入扩展（src/extensions）
   ▼
Pi 生态 (@earendil-works/pi-*)
```

产品定位与架构自述见 `README.md:50-67`；主进程入口产物由 `package.json:9`（`main: dist-electron/main/index.mjs`）声明。

关键目录规模（文件级，非行数）：`src/main`（含 `browser/` 子目录）、`src/runtime`（含 `tools/`）、`src/renderer`（含 `browser/`）、`src/shared`、`src/extensions`、`src/preload`。完整清单见 `src/**/*`（本次列举）。

---

## 1. 各层职责

### src/main —— Electron 主进程（窗口 / IPC / 权限 / 工作区 / 子进程宿主）

- **总装与 IPC 注册**：`src/main/index.ts`
  - 运行时命令白名单 `ALLOWED_AGENT_COMMANDS`：`index.ts:129-147`
  - 主进程 IPC 统一注册函数 `registerIpc()`：`index.ts:533`（`ipcMain.handle(...)` 从 `index.ts:534` 起）
  - 诊断日志 `LocalLogger`：`index.ts:169-176`
  - “运行中会话”注册表（磁盘会话缺失时的兜底）：`index.ts:212-296`
  - 应用启动与子系统装配：`index.ts:1991-2081`（`app.whenReady()`）
- **RPC 子进程宿主**：`src/main/agent-host.ts`（`AgentHost` 类，`agent-host.ts:39`）
- **会话级生命周期管理**：`src/main/agent-manager.ts`（`AgentManager` 类，`agent-manager.ts:51`）
- **子代理协调**：`src/main/delegation-coordinator.ts`（`DelegationCoordinator` 类，`delegation-coordinator.ts:70`）
- **内置浏览器（主进程侧）**：`src/main/browser/`：`ipc.ts`（`registerBrowserIpc`，`ipc.ts:107`）、`automation.ts`（`BrowserAutomation`，`automation.ts:40`）、`windows.ts`、`popups.ts`、`downloads.ts`、`passwords.ts`、`page-operations.ts`、`accessibility.ts`
- **供应商与凭据**：`src/main/provider-store.ts`（`ProviderRepository`，`provider-store.ts:31`）、`src/main/providers.ts`（`providerRepository()`，`providers.ts:13`）
- **Skills 文件系统**：`src/main/skills-fs.ts`（`listLocalSkills`，`skills-fs.ts:31`）
- **横切基础设施**：`atomic-file.ts`、`local-logger.ts`、`ipc-validation.ts`、`workspace-path.ts`、`update-check.ts`、`process-tree.ts`、`rpc-lines.ts`

### src/runtime —— Agent Runtime（worker 子进程 + 主进程可复用的存储能力）

- **worker 入口（RPC 模式）**：`src/runtime/rpc-entry.ts:1-43`；直接调用 Pi 的 `main()` 并注入 TACode 扩展（`rpc-entry.ts:17,35-37`）
- **主进程共享入口**：`src/runtime/index.ts`（重导出 home/settings/credential/auth/state/subagents/options，`index.ts:8-107`）
- **扩展装配与工具注册**：`src/runtime/extension.ts`（`createTacodeExtension`，`extension.ts:96`）
- **工具集**：`src/runtime/tools/*`（files、patch、commands、managed-process、policy、sandbox、workspace、plan、ask-user、delegate、deepseek-provider、checkpoint、process）
- **委派桥**：`src/runtime/delegation-bridge.ts`（`createRuntimeDelegationClient`，`delegation-bridge.ts:24`）
- **存储与凭据**：`credential-store.ts`、`auth.ts`、`providers.ts`、`settings.ts`、`state.ts`、`home.ts`、`subagents.ts`、`options.ts`、`env.ts`、`rpc-client.ts`

### src/renderer —— 界面状态与组件（React 19）

- 状态与编排：`src/renderer/App.tsx`（含事件订阅、会话切换、发送逻辑）
- 组件库：`src/renderer/ui.tsx`、`provider-dialog.tsx`、`subagent-settings.tsx`、`appearance-settings.tsx` 等
- 会话归并：`src/renderer/conversation.ts`（`applyAgentEvent`，`conversation.ts:363`）
- 流式调度：`src/renderer/stream-scheduler.ts`
- 内置浏览器 UI：`src/renderer/browser/*`（`browser-panel.tsx`、`use-browser-panels.ts`、`panel-state.ts`、`browser-window.tsx` 等）
- 独立浏览器窗口入口：`src/renderer/browser-window.tsx:38-50`

### src/shared —— 跨层共享契约与纯逻辑

- IPC 契约 `DesktopApi`：`src/shared/types.ts:178-331`
- Agent 事件协议：`types.ts:130-163`（`AgentEvent`/`AgentStartResult`/`AgentRuntimeInfo`）
- 委派协议常量：`src/shared/delegation.ts:3-35`
- 子代理定义模型：`src/shared/subagents.ts:12-100`
- 浏览器工具定义：`src/shared/browser-tools.ts:25`（`BROWSER_TOOLS`）
- 其它：`skills.ts`、`providers*`、`provider-config.ts`、`model-*`、`thinking.ts`、`i18n.ts`、`vision-api.ts`、`integrations.ts`、`agent-protocol.ts` 等

### src/extensions —— 注入 worker 的 Pi 扩展（tsup 单独打包）

- `src/extensions/vision.ts`（视觉/OCR 工具）、`src/extensions/provider.ts`（桌面托管供应商，`provider.ts:14`）、`src/extensions/browser.ts`（浏览器工具，`browser.ts:48`）、`src/extensions/browser-routing.ts`
- 打包入口：`tsup.config.ts:25`

### src/preload —— contextBridge 桥接

- 主 preload：`src/preload/index.ts`（暴露 `window.harness`，`index.ts:19`、`index.ts:156`）
- webview guest preload：`src/preload/webview-browser.ts`（链接拦截 + 密码助手，`webview-browser.ts:80`）

---

## 2. 一次对话的完整数据流（含关键 file:line）

**1) 渲染层发起**
- 用户提交 → `App.tsx` 组装乐观消息 `optimisticUserMessage(...)`（`App.tsx:1260`，定义在 `conversation.ts:458`）→ 调用 `window.harness.agent.command("prompt", …)`（`App.tsx:1282`；图片路径见 `App.tsx:1286-1301`）。

**2) preload 桥接（IPC 契约）**
- `agent.command` 绑定：`src/preload/index.ts:100-106`（`ipcRenderer.invoke("agent:command", type, data, runtimeId ?? activeRuntimeId)`，无会话时把哨兵还原成 rejection，`index.ts:104`）。
- 契约类型：`src/shared/types.ts:264`（`agent.command<T>(...)`）。

**3) 主进程接收**
- `ipcMain.handle("agent:command", …)`：`src/main/index.ts:1255-1307`
  - 白名单校验 `index.ts:1264-1265`
  - 载荷大小校验 `assertPayloadLimit`：`index.ts:1267`
  - prompt 先落“受保护用户消息”再下发 worker：`index.ts:1282-1295`
  - 转发 `agentManager.command(handle, command, payload)`：`index.ts:1297`

**4) AgentManager 路由到对应 host**
- `AgentManager.command`：`src/main/agent-manager.ts:138-160`（按 runtimeId 取 host，串行执行 `host.request`）
- 无会话时返回哨兵 `agentNoSessionResult()`：`index.ts:1278`

**5) RPC worker 交互（stdin/stdout JSON-RPC）**
- `AgentHost.request` 写 stdin：`src/main/agent-host.ts:370-403`（`child.stdin.write(\`${JSON.stringify(command)}\n\`)`，`agent-host.ts:396`）
- worker 进程启动：`AgentHost.start` 的 `spawn(process.execPath, args, …)`，`agent-host.ts:211-241`（`--mode rpc --harness safe --provider/--permission/--sandbox …` 组装于 `agent-host.ts:181-207`）
- worker 侧入口执行 Pi 主循环：`src/runtime/rpc-entry.ts:35`（`await main(parsed.piArgs, { extensionFactories: [createTacodeExtension(...)] })`），扩展装配 `src/runtime/extension.ts:96-266`

**6) 流式回传（stdout → 事件）**
- `child.stdout` → `handleChunk`：`agent-host.ts:294`、`agent-host.ts:415`
- 逐行解析 → `handleLine`：`agent-host.ts:428-451`（`response` 走 pending 解析，其它 `type===string` 交给 `emitEvent`，`agent-host.ts:441-450`）
- 事件打标（`__seq`/`__runtimeId`/`__sessionId`）与回放缓冲：`AgentHost.tagged`，`agent-host.ts:96-111`
- 事件转发到渲染层：主进程 `createAgentHost` 的 emit 回调 `mainWindow?.webContents.send("agent:event", event)`，`src/main/index.ts:180-193`

**7) 渲染层订阅与归并**
- preload 订阅：`src/preload/index.ts:112`（`onEvent: subscribe<AgentEvent>("agent:event", …)`）
- App 订阅与去重：`App.tsx:1372-1393`（按 `__sessionId` 路由到后台/前台，按 `__seq` 去重）
- 流式批处理：`createStreamScheduler`，`App.tsx:1364-1371`
- 事件 → 消息归并：`applyAgentEvent`，`src/renderer/conversation.ts:363-456`（处理 `agent_settled`/`agent_end`/`message_*`/`tool_execution_*`）

**8) 快照与缺口补齐（重连/切换会话）**
- 启动结果含 `replay` 与 `lastSeq`：契约 `types.ts:145-153`、`types.ts:146-152`
- 主进程返回快照 + 回放：`AgentManager.startOn`，`agent-manager.ts:192-208`（`replay: host.replaySince(cut)`）
- 渲染层先套快照再补回放，并二次 `agent.replay` 去重：`App.tsx:776-832`

---

## 3. 关键子系统

### 3.1 agent-manager（会话级生命周期）
`AgentManager`（`agent-manager.ts:51`）
- 索引与查找：`runtimes`/`index` 映射（`agent-manager.ts:52-54`），`findBySession`（`:65`）、`findRuntime`（`:71`）、`activeHost`（`:76`）
- `list()` 返回运行中会话徽标信息：`:80-89`（`running: host.isInTurn()`）
- `start/resume/stop/command/respondToUi/stopAll`：`:97`、`:109`、`:126`、`:138`、`:162`、`:176`
- 同 runtime 串行队列 `enqueue`：`:220-225`；`createHost` 生成 `runtime-<uuid>`：`:184-190`
- 壳层补充参数类型 `AgentHostStartOptions`：`agent-manager.ts:34-42`

### 3.2 agent-host（RPC 子进程宿主）
`AgentHost`（`agent-host.ts:39`）
- 启动与命令参数拼装：`start`，`agent-host.ts:168-333`
- 子进程 IPC 收包（浏览器请求 + 委派桥请求）：`agent-host.ts:243-293`
  - 委派桥：`DELEGATION_BRIDGE_REQUEST` 处理与响应：`:249-279`
  - 浏览器请求/取消：`:281-292`（`executeBrowser` 回调注入自 `index.ts:194`）
- `sendDelegationEvent`：`:335-339`
- `stop`（杀整棵进程树，`killProcessTree`）：`:341-368`
- `respondToUi`（写 `extension_ui_response`）：`:405-413`
- `snapshot` 与异步 meta（models/skills/stats）：`:122-166`
- 异常与退出处理（脱敏 stderr）：`handleExit`，`:458-474`；RPC 超时策略：`:477-479`

### 3.3 delegation-coordinator 与 runtime/tools/delegate.ts
**主进程协调器** `DelegationCoordinator`（`delegation-coordinator.ts:70`）
- 桥请求入口 `handleRequest`（校验父会话存活、动作白名单、请求去重缓存）：`:87-140`
- 动作分发：`start/list/get/wait/stop/continue`：`:110-137`
- `start`：并发上限 `DELEGATION_MAX_CONCURRENCY`、子代理定义查找、子会话落盘、持久化线程：`:156-217`
- `wait`（轮询 + 超时）：`:219-257`；`continue`：`:272-321`；`stopAll`：`:323-330`
- `launch`/`runPrompt`（真实子 worker 启动并取报告）：`:332-377`
- 持久化恢复 `hydratePersistedEntries`：`:491-...`；`buildStartOptions` 由主进程注入（`src/main/index.ts:1996-2042`，`delegationDepth: 1` 见 `:2026`）

**runtime 侧工具** `src/runtime/tools/delegate.ts`
- 工具名常量：`delegate`/`delegate_wait`/`delegate_list`/`delegate_stop`/`delegate_continue`：`delegate.ts:31-35`
- 本地 fallback `registerDelegateTools`：`delegate.ts:469`
- 远程桥版 `registerRemoteDelegateTools`：`delegate.ts:579`（`client.request("start"/"wait"/"list"/"stop"/"continue")`：`delegate.ts:613-681`）
- runtime 侧客户端：`src/runtime/delegation-bridge.ts:24-82`（`request`：`:47`）
- 协议常量：`src/shared/delegation.ts:3-5`；动作集合：`:19-29`
- 扩展中的装配（是否启用桥 / depth 控制）：`src/runtime/extension.ts:183-225`

### 3.4 provider 配置与凭据存储
- 主进程仓库 `ProviderRepository`：`src/main/provider-store.ts:31`，凭据键 `serviceCredentialId = desktop-service:<id>`：`provider-store.ts:14`
- 主进程工厂 + IPC 校验：`src/main/providers.ts:13-45`（`createTacodeCredentialStore()` 作为读写后端，`:16-20`）
- runtime 凭据存储：`src/runtime/credential-store.ts`（三模式 file/keyring/auto，说明 `:1-15`；`FileCredentialStore`：`:37-79`；`installTacodeCredentialStore` 由 `rpc-entry.ts:33` 调用）
- 桌面壳固定走文件存储避免钥匙串弹窗：`src/main/index.ts:163`（`process.env.TETHER_CREDENTIALS_STORE = "file"`）
- auth 读写子集：`src/runtime/auth.ts`（`saveProviderApiKey` 等，`:46-...`）
- 服务运行时配置：`src/shared/provider-config.ts`（`serviceRuntimeConfig`），连接测试：`src/shared/provider-connection.ts`
- 以扩展形式把桌面服务凭据交给 worker（不落 CLI 参数/文件）：`src/extensions/provider.ts:14-33`
- worker 启动时注入凭据环境变量：`agent-host.ts:218-224`（`TETHER_DESKTOP_PROVIDER_CONFIG/KEY`）
- 启动时解析桌面托管服务：`src/main/index.ts:1175-1176`、`:1190-1197`

### 3.5 skills
- 判定与命令解析：`src/shared/skills.ts`（`parseSkillCommands`：`:19`，`skillSlashCommand`：`:14`）
- 本地发现（用户全局 + 项目根）：`src/main/skills-fs.ts:31-56`（根目录列表 `SKILL_ROOTS`：`:6-11`）
- IPC：`app:list-skills`（`src/main/index.ts:574`）、`app:reveal-path`（`:563`）
- worker 侧 skill 命令随快照 meta 回传：`agent-host.ts:143-162`（`parseSkillCommands(commands.commands)`，`:160`）

### 3.6 浏览器子系统
- **共享定义**：`src/shared/browser-tools.ts:25`（`BROWSER_TOOLS`）、参数校验 `validateBrowserParams`：`:60-83`
- **worker 扩展**：`src/extensions/browser.ts`
  - `requestBrowser`（Node IPC 私通道，非 HTTP/密钥文件）：`browser.ts:14-46`
  - `browserExtension`（仅在 `process.send` 存在时注册工具）：`browser.ts:48-72`
  - 截图需视觉模型校验：`browser.ts:58-60`
- **主进程实现**：
  - IPC 注册 `registerBrowserIpc`：`src/main/browser/ipc.ts:107-...`（`browser:register-tab` `:112`、`browser:webview-preload-path` `:116`、下载/密码子通道 `:146-217`）
  - 自动化核心 `BrowserAutomation`：`src/main/browser/automation.ts:40`（按 runtime 隔离的工作标签与队列 `:12-21`、`:49-71`；`register`：`:73-90`）
  - 其它：`windows.ts`（独立窗口）、`popups.ts`（弹窗分流）、`downloads.ts`、`passwords.ts`、`page-operations.ts`、`accessibility.ts`
  - 主进程接线：`index.ts:166`（`new BrowserAutomation`）、`index.ts:194-195`（注入 host）、`index.ts:2061`（`registerBrowserIpc`）
- **渲染层**：
  - `src/renderer/browser/browser-panel.tsx`（`registerTab` 于 `:189`，`presentationReady` 于 `:413`，guest preload 路径 `:153`）
  - `src/renderer/browser/use-browser-panels.ts:5-42`（多标签面板状态 + 主进程 presentation 事件订阅）
  - 布局：`src/renderer/browser/panel-state.ts`、`workbench-panels.tsx`、`browser-window.tsx`（独立窗口）
- **guest preload**：`src/preload/webview-browser.ts:80-...`（链接激活拦截 + 密码助手）

---

## 4. 构建与测试布局

**tsup（主进程/worker，多入口）** `tsup.config.ts:3-43`：
- `src/main/index.ts` → `dist-electron/main/index.mjs`（esm，external electron）：`:5-13`
- `src/preload/{index,webview-browser}.ts` → cjs `.cjs`：`:15-23`
- `src/extensions/{vision,provider,browser}.ts` → esm `.js`：`:25-32`
- `src/runtime/rpc-entry.ts` → `dist-electron/runtime/rpc-entry.js`（comment：依赖从 node_modules 解析）：`:34-42`

**vite（渲染层双入口）** `vite.config.ts`：
- 端口 5177 strictPort（与 `package.json:13` 的 dev 脚本一致）：`vite.config.ts:7-11`
- 双入口 `index.html` + `browser-window.html`：`vite.config.ts:16-21`
- vitest：include `src/**/*.test.ts`、`environment: node`、globalSetup `vitest.global-setup.ts`：`vite.config.ts:23-27`

**测试前置** `vitest.global-setup.ts:6-10`：调用 `ensureRuntimeBuilt()`，因为主进程集成测试会真实 spawn `dist-electron/runtime/rpc-entry.js`（`scripts/ensure-runtime.mjs`）。

**脚本** `package.json:10-24`：`dev`（vite + electron）、`build:electron`（tsup）、`build:renderer`（vite build）、`test`（`vitest run`）、`typecheck`（`tsc --noEmit`）、`test:browser`（`scripts/test-browser.mjs` 冒烟）。

**测试与源码对应关系**：几乎每个模块旁挂同名 `.test.ts`（如同目录 `src/main/agent-host-faults.test.ts`、`src/runtime/tools/delegate.test.ts`、`src/renderer/conversation.test.ts`、`src/shared/delegation.test.ts`）。另有 Playwright 风格冒烟脚本在 `scripts/`（`browser-smoke.ts`、`workbench-smoke.ts` 等，`scripts/*`）。

**tsconfig**：`tsconfig.json`（`typecheck` 使用）。

---

## 5. 最核心的 5 个文件

1. `src/main/index.ts` —— 主进程总装、全部 `ipcMain` 通道、`createAgentHost`、委派协调器接线、启动流程（`index.ts:533`、`:1120`、`:1255`、`:180-208`、`:1991-2081`）
2. `src/main/agent-host.ts` —— 单会话 RPC 子进程宿主，事件打标/回放、浏览器与委派桥 IPC、进程树回收（`agent-host.ts:39`、`:96`、`:243`、`:341`、`:415`）
3. `src/main/agent-manager.ts` —— 会话↔runtime 映射与命令路由（`agent-manager.ts:51`、`:97`、`:138`、`:192`）
4. `src/shared/types.ts` —— 跨层 IPC/事件/委派契约（`types.ts:130`、`:145`、`:178`、`:261-330`）
5. `src/renderer/App.tsx` —— 界面状态机：发送、事件订阅去重、快照+回放补齐、会话切换（`App.tsx:755-845`、`:1260-1302`、`:1364-1400`）

（紧随其后的是 runtime 双核：`src/runtime/rpc-entry.ts` 与 `src/runtime/extension.ts`。）

---

## 6. 扩展点：需要改哪些文件

### 6.1 新增一个 IPC 通道（请求/应答式）
最小改动 3 处 + 校验与测试：
1. **契约**：`src/shared/types.ts` 对应命名空间接口内新增方法（如 `app`：`types.ts:180-192`，`workspace`：`:199-209`）。
2. **preload 绑定**：`src/preload/index.ts` 对应命名空间加 `ipcRenderer.invoke("ns:channel", …)`（示例 `index.ts:22-31`、`:41-45`、`:62-65`）。
3. **主进程处理**：在 `registerIpc()` 内加 `ipcMain.handle("ns:channel", …)`，函数起点 `src/main/index.ts:533`（参考 `app:list-skills` `:574`、`workspace:list` `:775`）。
4. **（推荐）输入校验**：`src/main/ipc-validation.ts`（`IPC_LIMITS`：`:12-37`，`requireString`：`:44` 等）。
5. **（推荐）测试**：新增 `src/main/ipc-validation.test.ts` 同类或对应模块测试（`src/**/*.test.ts` 自动纳入，`vite.config.ts:24`）。

若为**主进程 → 渲染层推送**通道（如 `agent:event`）：preload 用 `subscribe`（`index.ts:9-13`），主进程用 `webContents.send(...)`（如 `index.ts:183`、`:187`、`:501`）。

### 6.2 新增一个子代理角色
- **方式 A（无需改代码 / 用户定义）**：在 `~/.tether/subagents/<name>.md` 放入带 frontmatter 的文档，经设置页 `subagents:save` 落盘（IPC 见 `src/main/index.ts:582`，存储与合并见 `src/runtime/subagents.ts:138-197`）。
- **方式 B（内置角色，需改代码）**：
  1. 在 `src/runtime/subagents.ts` 的 `BUILTIN_SUBAGENTS` 数组新增定义（数组起点 `subagents.ts:36`；示例 explorer：`:37-51`）。`tools` 取值必须来自 `SUBAGENT_ASSIGNABLE_TOOLS`（`src/shared/subagents.ts:12-21`）。
  2. 角色名会被 `delegate` 工具/协调器按名解析：`src/main/delegation-coordinator.ts:167-169`（`loadEnabledSubagents().find(item => item.name === role)`）。
  3. 渲染层设置页会自动列出（`subagents:list`，`src/main/index.ts:578`；界面 `src/renderer/subagent-settings.tsx`），无需额外改动。
  4. 若需默认关闭/开启：启用状态在 `~/.tether/subagents.json`（`src/runtime/subagents.ts:27-29`、`:177-197`）。
  - 注意：可写子代理（含 `exec_command` 等）由 `subagentCanMutate` 判定（`src/shared/subagents.ts:102-106`），且实际权限不超过父会话（相关生效逻辑见 `delegation-coordinator.ts` 的 permission 归一，`:60-68`、`:173`）。

---

## 7. 不确定 / 未深挖项

- `src/main/browser/page-operations.ts`、`accessibility.ts`、`windows.ts`、`popups.ts`、`downloads.ts`、`passwords.ts` 的内部实现细节本次仅确认存在与调用点（`browser/ipc.ts:12-36`、`automation.ts:4-7`），未逐行展开。
- `src/runtime/tools/*` 各工具的权限/沙箱细节（`policy.ts`、`sandbox.ts`、`workspace.ts`）未逐行核对；相关入口为 `extension.ts:153-181`。
- `src/extensions/vision.ts` 的 OCR/视觉流程细节未逐行展开（仅确认导入与工具注册入口 `vision.ts:24-40`）。
- `src/renderer/ui.tsx` 与各设置对话框的组件细节未逐一核对（`App.tsx` 为其主要消费者）。
- “运行中会话注册表”的持久化格式（`loadedSessions*`）细节见 `index.ts:212-296`，未逐字段核对。

以上均为可继续深入的方向；本报告中的架构、数据流与扩展点结论均有前述 `文件:行号` 直接支撑。

---

# 二、code-reviewer 子代理报告：缺陷与风险

# TACode 只读缺陷审查报告

审查范围：`src/`（主进程 / preload / runtime / renderer）与 `package.json`。未运行构建或测试，未修改任何文件。以下按严重级别排序，并标注「已确认缺陷」或「可疑但未验证」。

---

## 高

### 1. 主密钥解密失败会静默重建并覆盖，导致已保存密码永久不可恢复
`src/main/browser/passwords.ts:86-102`（catch 在 91，覆盖写在 99-101）
**已确认缺陷**。`getMasterKey()` 把「读取 `vault.key` + `safeStorage.decryptString` 失败」与「密钥文件不存在」当成同一分支：只要解密抛错（macOS Keychain 临时锁定、OS 大版本升级、迁移用户目录等），就进入 catch，随后无条件生成 32 字节新密钥并 `fs.writeFile(KEY_FILE, …)` 覆盖原密钥。
触发条件：`vault.bin` 已存在，但某一刻 `safeStorage.decryptString` 抛错。
失败模式：`vault.bin` 用新密钥无法解密 → `loadVault()` 的 catch（`:119-122`）返回空库且不报错 → 下一次 `savePasswordRecord`（`:197`）经 `persistVault`（`:133` rename）把空库+新记录写回，**全部历史密码被静默清除**，且用户没有任何提示。
修复建议：把「密钥文件缺失」与「解密失败」分开处理；解密失败时抛出显式错误（拒绝读写）而不是重建密钥；确需重建时先备份 `vault.bin`/`vault.key` 并提示用户，且不要在解密失败时继续执行写回。

### 2. `tetherPasswordBridge.find` 把明文密码交给网页 JS
`src/preload/webview-browser.ts:233-236`（save 在 `:238`）
**已确认缺陷（安全默认值问题）**。guest preload 通过 `contextBridge` 把 `find(): Promise<{username,password}>` 暴露到页面主世界，浏览器 webview 以 `webpreferences="sandbox=no,contextIsolation=yes"` 运行（`src/renderer/browser/browser-panel.tsx:645`）。
触发条件：任意在该 origin 上运行的脚本（页面自身、第三方统计/广告脚本、该站点的 XSS）调用 `tetherPasswordBridge.find()`。
失败模式：无需用户交互即可拿到明文密码；`find` 不要求页面存在可见密码框，因此比「DOM 里被自动填充的 value」多出一条独立、可静默批量读取的通道（主进程 `guestOriginFrom` 只校验 origin，不校验调用来源脚本）。
修复建议：仅在渲染层显式触发填充时回填，不给页面暴露返回明文的方法；或改为返回可用凭据的布尔/掩码，实际填充只走 `tryAutofill` 内部 IPC。

---

## 中

### 3. Markdown 使用 `rehypeRaw` 但无净化，`dompurify` 是死依赖
`src/renderer/ui.tsx:32,1245`；`package.json:34`
**已确认缺陷（缺净化）**。`Markdown` 的 `rehypePlugins={[rehypeKatex, rehypeRaw]}` 未配 `rehype-sanitize`，渲染源来自模型输出与工具结果（其中可包含 agent 读到的文件/网页内容）。全仓库检索 `dompurify` 仅出现在 `package.json` 与 lock 文件，源码零引用，属未使用的声明依赖。
触发条件：模型或被抓取内容里出现原始 HTML（`<style>`、伪造审批卡片、`<iframe src="harness-preview:…">` 等）。
失败模式：注入内容进入特权渲染进程（该进程持有完整 `window.harness`：`workspace.read`、`agent.command`、`auth.readApiKey`）。当前 `index.html:8` 的 CSP（`script-src 'self'`）挡住了内联脚本执行，但 `style-src 'self' 'unsafe-inline'` 仍允许 CSS 注入 → 视觉欺骗/界面覆盖（例如伪装成审批弹窗诱导确认）；CSP 是该风险唯一的防线，任何放宽都直接变成渲染进程 XSS → 密钥与文件窃取。
修复建议：加 `rehype-sanitize`（或按需白名单 schema），移除或真正使用 `dompurify`；不要把安全完全押在 CSP 上。

### 4. `classifyCommand` 对引号包裹的破坏性命令失效
`src/runtime/tools/policy.ts:71-77`（shell 语法兜底在 `:79`）
**已确认缺陷（启发式漏洞）**。危险判定正则要求命令名前是行首或空白：`/(^|\s)(rm|rmdir|sudo|…)\b/i`。`sh -c "rm -rf X"` 中 `rm` 前面是 `"`，不匹配；随后 `/[;&|><`$()\n\r]/` 也不含这些字符（只有 `"`），于是返回 `needs-approval` 而非 `dangerous`。`approveToolCall`（`src/runtime/extension.ts:622`）只在 `externalMcp || dangerousCommand` 时于 `auto` 模式弹确认。
触发条件：auto（工作区）权限下执行 `sh -c "rm -rf …"`、`bash -c 'git reset --hard'` 等。
失败模式：本应二次确认的破坏性命令直接执行（破坏面被 Seatbelt 限制在工作区内，故不是全盘删除，但与策略声明的「危险命令必须确认」不一致）。
修复建议：先剥离引号/做 token 化再分类，或对 `sh -c`/`bash -c`/`env…` 等包装器整体升级为 `dangerous`；补充针对引号变体的单测。

### 5. 委派 `continue` 的「重启后恢复」分支永远不会执行
`src/main/delegation-coordinator.ts:280-282` 与 `:289-309`
**已确认缺陷（死代码 / 功能不可达）**。`:280` 先判断 `!entry.host || !entry.host.isRunning()` 并直接抛错；`:289` 才写「无 host 就新建 host 重启」的分支，因此 `:289-309` 恒不可达。而 `hydratePersistedEntries`（`:491-517`）只会重建无 host 的 `interrupted` 条目。
触发条件：应用重启后对历史委派调用 `continue`。
失败模式：代码表面支持「续跑中断的委派」，实际永远返回 “Delegation worker is no longer available”，恢复能力与注释/实现不符。
修复建议：把 `:289` 的重启逻辑上移到 `:280` 之前，或删除死分支并明确不支持跨重启续跑。

### 6. 持久化委派丢失 `permission`，水合后一律显示为 `auto`
`src/main/delegation-coordinator.ts:419-431`（persist 未写 permission）、`:505`（水合写死 `"auto"`）
**已确认缺陷（状态失真）**。`persist` 只写 title/status/goal/report/error/completedAt/preview；水合时 `permission: "auto"` 是硬编码。UI 与 `get/list` 返回的权限与实际不符；`continue` 的 startPayload（`:299`）也读取该字段。
触发条件：重启后查看/操作历史委派。
失败模式：原本以 `plan`/`ask` 运行的委派在快照中表现为 `auto`（默认工作区直跑），权限语义丢失，若后续恢复路径（见 5）被修好则直接构成越权。
修复建议：持久化真实 permission 与水合时回读，缺失时取更保守值（如 `ask`/`plan`）而非 `auto`。

### 7. `loadVault` 缓存被拒绝的 Promise，一次失败永久失效
`src/main/browser/passwords.ts:109-124`（缓存写入 111、返回 124）
**已确认缺陷（错误不可恢复）**。`vaultPromise` 只在为空时创建，失败后不重置。若首次调用时 `getMasterKey()` 抛错（例如 `safeStorage.isEncryptionAvailable()` 为 false，`:94-98`），后续所有 `loadVault` 都返回同一个已拒绝的 Promise。
触发条件：首次保存/查询密码时系统密钥环不可用。
失败模式：即使用户随后启用/解锁密钥环，密码库在本进程生命周期内一直报错，必须重启应用；表现为「保存密码一直失败」。
修复建议：失败时 `vaultPromise = null` 以允许重试（或缓存 `{ok,value,error}`）。

### 8. 安全边界与进程回收模块缺直接测试
`src/main/browser/ipc.ts`、`src/main/browser/passwords.ts`、`src/runtime/extension.ts`、`src/runtime/tools/managed-process.ts`、`src/main/process-tree.ts`、`src/runtime/tools/process-tree.ts`（对照 `src/main/browser/*.test.ts` 只有 accessibility/automation）
**已确认缺陷（测试缺口）**。密码 IPC 的 `guestOriginFrom` 同源校验、保险库加解密、权限继承/plan 白名单（`extension.ts`）、沙箱子进程回收（两处 `process-tree`）均无 `.test.ts` 直接覆盖；`extension.ts` 的 `classifyCommand` 只由 `policy.test.ts` 间接覆盖。
风险：这些正是「越权/泄露/进程泄漏」类回归不会在 `pnpm test` 中被发现的地方。
修复建议：为 `passwords.ts`（密钥轮换、坏密文、并发写）、`ipc.ts` 的 origin 校验、`process-tree.ts` 的组回收补单测。

### 9. `AgentManager.queues` 无界增长，失败的 host 留在 `runtimes`
`src/main/agent-manager.ts:220-225`（queues 只写不删）、`:184-190`（createHost 立即注册）
**已确认缺陷（缓慢泄漏）**。每次 `enqueue(key, …)` 都 `this.queues.set(key, …)`，键包含 `start:<sessionPath|cwd>`，从不清理；`createHost` 先 `runtimes.set`，若随后 `host.start` 抛错（如 spawn 失败），该 host 仍留在 `runtimes`，`list()` 会把它作为 `running:false` 的条目列出且不清除。
触发条件：长期运行 + 打开/切换大量不同会话或工作区。
失败模式：长会话内存与 `runtimes`/`queues` 条目持续增长，`agent:runtimes` 结果含僵尸条目。
修复建议：队列以 runtimeId 为键并在空闲后删除；`startOn` 失败时从 `runtimes`/`index` 回滚。

### 10. `ManagedProcessRegistry` 完成记录在 `start` 路径不清理
`src/runtime/tools/managed-process.ts:102-108`（close 只置 running=false）、`:140-141`（仅 interact 删除）
**已确认缺陷（缓慢泄漏）**。命令在 `yieldTimeMs` 内结束时不返回 `process_id`，agent 通常不会再调用 `write_stdin`，记录（含 `BoundedOutput(80_000)` 与 `pending` 缓冲）会一直留在 `records` 直到 `dispose()`。
触发条件：一个会话里大量执行快速完成的 `exec_command`。
失败模式：单会话内内存随命令数线性增长；`/jobs` 也会列出大量已完成项。
修复建议：`close` 后延迟删除记录（保留一次结果读取窗口），或对已完成记录设上限/LRU。

---

## 低

### 11. `toast.backgroundSessionDone` 占位符写成双层花括号
`src/shared/i18n.ts:127`（en 同名键 `:781`）
**已确认缺陷**。值分别为 `"后台会话已完成：{{title}}"` / `"Background session done: {{title}}"`，而 `t()`（`:1352`）只替换 `{title}`。`App.tsx:1383` 传入 `{ title }`。
触发条件：后台会话结束时的完成提示。
失败模式：显示为 `后台会话已完成：{会话名}`，多出一对大括号。
修复建议：改为 `{title}`；并给 i18n 增加占位符一致性检查（现有 `i18n.test.ts` 仅覆盖 3 个键，类型只保证键存在、不保证占位符匹配）。

### 12. `crashPage` 用 `JSON.stringify(target)` 内联到 `<script>`，未转义 `<`
`src/main/browser/windows.ts:49,53`
**可疑但未验证**。显示分支做了 `target.replace(/[<>&]/g,"")`，但脚本分支 `window.location.href = ${JSON.stringify(target)}` 未处理 `</script>`；若 `target` 含字面 `</script>` 即可闭合脚本标签。
缓解事实：该页以 `data:text/html;charset=utf-8,${encodeURIComponent(...)}` 加载，而 `target` 来源于 `webContents.getURL()`——WHATWG URL 解析会把路径/查询里的 `<`、`>` 百分号编码，正常情况下拿不到字面 `<`，故实际难以触发。
修复建议：改用 `JSON.stringify(target).replace(/</g,"\\u003c")`，或干脆用 `encodeURIComponent`/`data:` 传参由页面自行解析。
附带可疑点：该窗口 `preload` 仍是完整 `../preload/index.cjs`（`windows.ts:106`），即使加载 `data:` 崩溃页也保留 `window.harness`；一旦上述注入成立即等同渲染期 IPC 越权，建议对 data: 页禁用该 preload。

---

## 我检查过、未发现缺陷的部分

- `src/main/ipc-validation.ts`：上限与类型校验覆盖完整，调用点（`agent:command`、`agent:ui-response`、`workspace:restore/read`、`browser:*`）均落到 `requireString`/`assertPayloadLimit`/字节上限，未见漏检或整数溢出。
- `src/main/index.ts:1564-1618` `resolveInWorkspace`：做了词法 + `realpath` 双重越界校验，且对「待创建路径」用最近存在祖先回退，设计正确。
- `src/main/index.ts` 主窗口与独立窗口均 `sandbox:true / contextIsolation:true / nodeIntegration:false`（`:450-456`、`windows.ts:105-112`）。
- `src/preload/index.ts`：`agent.start` 的 token 防过期路由、`agent.stop` 清理活动句柄、`agent:command` 哨兵还原为 rejection，逻辑自洽。
- `src/main/agent-host.ts`：pending 超时清理、`pending.delete` 前后一致、`killProcessTree` 兜底、stdout 单行超限丢弃，未见事件丢失的确定性缺陷（snapshot 与 replay 的序号对账逻辑经推演无重复/缺口）。

**结论**：最高优先级是第 1 条（密钥被覆盖 → 密码库静默清空）与第 2 条（明文密码经桥接暴露给页面脚本）；第 3 条依赖 CSP 单点防护，建议按纵深防御补齐 `rehype-sanitize`。
