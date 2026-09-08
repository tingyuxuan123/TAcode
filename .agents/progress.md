# 模型供应商管理进度

## 2026-09-07：实现与验证完成

- 用户范围：参考 `/Users/yfdl/Downloads/PI-Desktop-main`，只实现添加/管理模型供应商，不扩展其它 AI 服务功能。
- 交付分支：`codex/provider-management`；隔离目录：`/Users/yfdl/project/TAcode/.worktrees/provider-management`。
- 主仓库原有工作保存在 `stash@{0}: codex preserve preexisting provider work`，已应用到该 worktree；未删除 stash，未合并主分支。

### 已实现

- 设置 → AI 服务：预设/自定义服务、可编辑 URL 与接口格式、独立密钥、启停/删除、默认服务/模型。
- 模型自动发现（包括无密钥本地服务）、手动添加、上下文/输出限制、图片输入、推理等级。
- 用户触发的真实短生成连接测试，显示结果、错误和费用提示。
- 主进程串行、原子替换供应商元数据；每服务独立 CredentialStore 条目；编辑空密钥保留、更换端点需重填，存储失败尝试恢复原凭据。跨系统凭据/文件写入并非崩溃原子事务。
- RPC 子进程内注册供应商，不覆盖全局 OpenAI/DeepSeek 凭据；模型配置接入实际请求，下一次发送应用变更。
- 支持 Chat Completions、Responses、Anthropic Messages、Google Generative AI、OpenCode Go（Chat Completions）；不提供不受运行时支持的 Pi Messages/Codex Responses 登录模式。
- README 中英文说明同步；界面沿用 tether-ui 的纸面/墨色变量。

### 主要文件

- `src/main/provider-store.ts`、`src/main/providers.ts`：配置、凭据、IPC。
- `src/shared/provider-config.ts`、`provider-connection.ts`、`openai-models.ts`、`types.ts`：契约、验证与协议。
- `src/extensions/provider.ts`、`src/main/agent-host.ts`、`src/main/index.ts`：实际 Agent 接入。
- `src/renderer/provider-dialog.tsx`、`ui.tsx`、`App.tsx`、`styles.css`、`src/shared/i18n.ts`：服务管理、状态同步与界面。
- 对应配置、仓储、发现、连接和真实 RPC 测试；`tsup.config.ts` 打包新扩展。

### 验证

- `pnpm typecheck`：通过。
- `pnpm exec tsup`：通过。
- `pnpm build:renderer`：通过，有 Vite 大于 500 KB 的 chunk 提示，不影响构建。
- 五个供应商相关测试文件：43/43 通过；其中四种协议均运行真实 `tether-agent-core` RPC 子进程请求本地模拟服务，验证模型、地址、配置、独立认证和生成响应。
- `pnpm test`：178/179 通过；唯一失败为修改前已存在的 `src/renderer/conversation.test.ts:308`，期望 `GLM-4V 识图 · glm-4v-flash · MinerU OCR`，实际 `识图 · glm-4v-flash · MinerU OCR`。未修改或弱化该无关测试。
- `git diff --check`：通过。

### 边界与后续

- 未连接真实云厂商、未使用用户真实密钥，未完成 GUI 人工/视觉验收；不能把模拟协议通过视为每家网关均已验证。
- 原生 PDF 配置、跨模型自动调度不在此次范围，PDF 继续使用现有 OCR 流程。
- 如需继续：先在隔离分支做 GUI 验收（添加两个同厂商服务、重启后保留、切换默认后实际发送）；用户确认后再处理合并。不要重复迁移实现或自动恢复主仓库 stash。
- 无关识图文案失败单独处理，验收条件为原有 conversation 测试通过；来源为本次基线及最终测试。未创建/勾选 features.json 验收项。

## 2026-09-07 12:45 GMT+8：修复自定义服务首次提问启动失败

- 用户现象：首页选择 `deepseek-v4-flash-vision-exp` 后提问，Agent 以 code 1 退出，提示 `OpenAI API is not configured`。
- 已确认根因：桌面服务使用内置 `openai` 槽位；`tether-agent-core@0.1.19` 在扩展加载前调用 `ensureFirstRunAuth`，不识别 `TETHER_DESKTOP_PROVIDER_KEY`。原 RPC 测试预设了全局 OpenAI 假密钥，未覆盖无 OpenAI 凭据环境。
- 修改 `src/main/agent-host.ts`：仅对桌面自定义服务的 RPC 子进程设置非秘密启动占位值 `OPENAI_API_KEY=desktop-session-key`；真实请求仍由现有扩展解析服务专属密钥，不修改父进程环境或全局凭据文件，不改变普通 OpenAI 启动逻辑。
- 更新 `src/main/provider-runtime.test.ts`：直接使用实际 `AgentHost.start`；覆盖五种接口格式与无 OpenAI 凭据、冲突凭据、无密钥服务三类环境，并保留普通 OpenAI 无凭据拒绝启动的负向测试。断言实际端点、模型、认证、回复、父进程环境和凭据文件未被修改。
- 修复前新增场景中 8 个重现相同启动错误；修复后定向测试 16/16 通过。
- `pnpm typecheck`、`pnpm build`、`git diff --check` 通过。构建仍有现有大于 500 KB 的 renderer chunk 提示。
- `pnpm test`：190/191 通过；唯一失败仍为修改前已有的 `src/renderer/conversation.test.ts:308` 识图标题断言，未修改该测试或相关逻辑。
- 验证使用真实 RPC 与本地 HTTP 模拟服务，未使用用户真实密钥或请求云端模型，未完成用户真实渠道的 GUI 发问验证。
- 已在当前项目根重新构建；现有开发服务位于 `127.0.0.1:5177`，未停止用户进程。需完整重启 Electron 应用加载新的主进程代码，仅刷新窗口不生效。未提交或发布。

## 2026-09-07 13:13 GMT+8：修复推理等级配置与菜单不一致

- 用户现象：Anthropic 兼容服务的 `deepseek-v4-flash-vision-exp` 勾选 `low/medium/high/max`，聊天菜单仅显示前三档。
- 独立 RPC 探针确认当前扩展能够完整保留显式 `thinkingLevelMap`，core 不会按这个模型名删除 `max`。界面原先缺少启动前的服务能力数据，模型预览优先按名称推断，并忽略元数据中的推理更新；另有 `minimal` 被过滤、`xhigh/max` 被合并的问题。
- `ProviderStatus` 增加不含密钥的模型能力信息；前端优先使用显式能力，设置关闭刷新和模型切换后同步菜单。异步 RPC 同步检查会话、模型及选中等级，旧服务实例不再覆盖新配置的选择。收到运行时推理元数据后重新查询当前状态。
- 推理菜单按 `minimal/low/medium/high/xhigh/max` 保留所有支持项；补齐中英文标签，`xhigh=极高`、`max=最高`，设置展示相同中文标签及原始等级 ID。仅有 off 时正确归一化为 off。
- Anthropic 显式声明 `max/xhigh` 的模型使用 SDK 原生 `compat.forceAdaptiveThinking`，将等级发送为 `output_config.effort`；`minimal` 在该模式映射为 `low`。未显式声明最高档时保持预算模式，设置默认等级与运行时均为 `minimal/low/medium/high`。该策略将显式最高档配置视为支持 adaptive effort 的能力声明，真实网关仍须支持对应协议。
- 新增真实 RPC + 本地 HTTP 请求测试，覆盖截图模型、模型切换、`high/max/xhigh/minimal` 的状态及出站字段、预算模式 token 数和非推理模型；修复前测试复现缺少 adaptive/effort 字段，修复后通过。
- 用隔离 IPC fixture 加载实际 React App 完成浏览器验收：四档菜单包含最高且可选择；取消 max、保存、关闭设置后，菜单立即更新为三档并将已选 max 回退到中。检查了截图。fixture 只在本次会话工作台，无真实凭据或网络请求，测试浏览器已关闭。
- 定向测试 44/44 通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。全量 `pnpm test` 为 199/200，唯一失败仍是修改前已有的 `src/renderer/conversation.test.ts:308` 识图标题断言。构建仍有现有 renderer 大 chunk 提示。
- 保留前轮启动认证修复，未更改用户服务数据、密钥或依赖版本，未进行真实云端验证、提交或发布。已重新构建，需完整重启 Electron 应用以加载主进程中的新能力数据与映射。

## 2026-09-07：供应商分组模型菜单与思考深度滑块

- 按用户参考图实现独立模型选择器：弹层内固定搜索栏、供应商分组、当前项高亮与勾选、滚动、方向键/回车选择、Escape/点击外部关闭。搜索匹配供应商与模型名称；同名模型使用服务 ID 与模型 ID 联合标识。
- auth:status 返回全部启用桌面供应商的无密钥状态。选择器复用 providers.setDefault 保存服务与模型；下一次发送复用 ensureModelReady 重启不同服务的运行时并恢复会话，不中断正在生成的回答。保留旧版单供应商数据回退。
- 思考选择改为模型能力驱动的离散 range 滑块及可点击刻度，保留所有受支持等级，仅在支持时提供 off。非推理模型隐藏入口；不支持原等级时回退到可用推理档位，不意外关闭。
- 用户追加要求入口可辨认当前等级：脑形图标后直接显示等级文字，关闭置灰，悬停/展开时浅色背景；按语言固定按钮宽度，切换档位不挤动邻项。中文低档改为“低”，max 改为“最大”，沿用现有主题变量。
- 新增 lucide-react 用于选择器图标；锁文件仅保留此依赖的增量，撤销安装工具产生的无关解析变动。未覆盖工作期间出现的 provider-dialog.tsx、styles.css、i18n.ts 中其他设置页改动。
- 新增 6 项共享逻辑测试。全量 pnpm test 为 205/206，唯一失败仍为修改前已存在的 conversation.test.ts:308 识图标题断言；类型检查、生产构建与 diff whitespace 检查通过，仍有原有 renderer 大 chunk 提示。
- 工作台 preview/ 下用实际 React App 与隔离 IPC fixture 完成 11 项浏览器断言，并在 760px iframe 内重跑通过：完整档位、等级文字、off 置灰、Escape、同名模型供应商区分、档位回退、搜索空态、首轮启动参数、跨服务下一轮恢复参数、无运行时错误及弹层边界。完成分组菜单及滑块截图检查；后续窄窗口截图工具返回 UnknownVizError，未把该截图记为通过。没有真实云端请求或密钥访问。
- 已重新构建，需要完整重启 Electron 加载主进程多供应商状态。未提交、发布或修改 AGENTS.md。

## 2026-09-07：思考与执行流展示

- 用户批准参考 Proma 的阅读层级与流式节奏，在当前目录新建 `codex/execution-flow` 分支实施。独立使用 Tether 现有 React/CSS/lucide 组件实现，没有复制 Proma 源码或修改许可。
- 新增 `execution-flow.tsx`：运行中默认展开、约320px限高过程视口、思考四行预览/全文切换、普通Markdown阶段说明、轻量工具行及按需结果详情；末尾答复独立显示，正常结束且用户未交互时延迟收起。失败、停止、等待确认和缺结果状态保持可发现，审批卡仍在过程外。
- `conversation.ts` 新增展示投影与稳定历史分组引用；按模型消息边界维护work作用域，同一块快照修订替换旧文本，不以内容包含关系合并不同步骤。历史工具缺结果显示中性状态；工具update保留首次开始时间。
- 新增有序帧事件批处理、后台兜底、短文本缓冲与独立滚动跟随；区分用户阅读意图和程序滚动，处理会话重建/观察器绑定，主区与过程区提供回到最新入口。
- 通过独立审查补齐自然完成与停止竞态、同会话新run隔离、首token前停止和宿主错误状态；使用已有stopReason恢复明确的aborted标志，不补造未知历史终止原因。未扩展runtime、RPC、权限或模型协议。
- 新增25项测试均通过。`pnpm test`为230/231，唯一失败仍为原有 `conversation.test.ts:308` 识图标题断言。原阶段说明测试补齐分立模型消息的message_start事件，未弱化内容顺序断言。`pnpm typecheck`、`pnpm build:renderer`和`git diff --check`通过，仍有现有renderer大chunk警告。
- 工作台 `3902fd90-16b8-4ee1-912f-59ee01eccd97/preview/` 用真实App和隔离IPC检查运行/完成、工具详情保持、等待确认、手动回看不跳及切会话无旧文本污染；查看1440/1024/760px及白色/深色/纸面主题截图。400余条历史消息追加80次快照，被监测历史正文DOM未变化，回放无捕获到的运行时异常。详细证据见该会话 `verification.md`。
- 减少动态效果分支已实现但未切换真实OS设置验收；没有真实云端请求、打包安装或发布。保留项目现有 `127.0.0.1:5177` 开发服务，已更新renderer生产构建。未修改主进程、用户服务数据、AGENTS.md或依赖版本，未提交。

## 2026-09-07：主题与字体设置（字体 + 字号）

- 在现有“主题”页新增字体与字号区：两字体选择器（界面与正文 / 代码）、三字号步进框（界面 / 对话 / 代码）、自定义字体名、恢复默认；配色与字体字号同页独立分区，底部预览展示实际效果。
- 新增 `shared/typography.ts` 管理配置校验、localStorage 保存与 CSS 变量：`--sans`/`--mono` 随字体切换；`--ui/--chat/--code-font-scale` 按比例套用，默认均为 1，不改变现有字号层级。启动前在 renderer/main.tsx 恢复。
- 字号用 `calc(<px> * var(--<scale>))` 接入：正文/对话为 chat，代码块、终端、路径为 code，按钮/侧栏等界面元数据为 ui；行内 `code` 保留原文比例。修正 `.markdown pre code` 让内层 code 继承外层字体（原来被浏览器默认 monospace 覆盖，导致代码字体切换看不出效果）。
- 字体可用性用本地 canvas 测量判定；未安装提醒并回退默认；非等宽字体在代码分类被拒绝。代码字体预设含 Menlo / Monaco / Courier New / Consolas / JetBrains Mono（本机未装则置灰标注未安装）。自定义字体留空时提示需填名称。
- 翻译补齐中/英文；`settings.appearance` 改名“主题与字体”。
- 16 项新增 typography 单测通过；类型检查、`pnpm build:renderer`、`git diff --check` 通过。全量 `pnpm test` 仍为 246/247，唯一失败为修改前已存在的 `conversation.test.ts:308` 识图标题断言，未改动该测试。
- 隔离 IPC fixture 加载真实 App 完成浏览器验收：切换代码字体为 Menlo 后代码块计算字体跟随（`code` 由 monospace 变为 Menlo 栈）、代码字号步进即时生效、重载后从 localStorage 恢复（menlo / 13px）、无运行时错误；截图确认三区块布局与窄窗口。未读取真实凭据、未请求云端模型。
- 预览工具对相同 URL 有资源缓存，旧 CSS 在旧标签残留属工具现象；源码与生产构建产物均已确认包含 `font-family: inherit` 修复。未提交、未发布、未改 AGENTS.md。

## 内置浏览器移植（Snow App → Tether，2026-09-08）

- 范围确认：Snow 全量浏览器功能；两仓库 MIT。分层：A 核心浏览器 / B 独立窗口 / C 凭据与登录态 / D 调试与代理 / E Agent 浏览器工具。
- Layer A 完成：主窗口 `webviewTag`，`src/main/browser/{popups,downloads,ipc}.ts`（弹窗分流 + guest `_blank` 中继去重、will-download 保存对话框与下载面板、clear cache/cookies、DevTools、截图写剪贴板）；`src/preload/webview-browser.cjs` guest 入口（tsup 多入口）；`DesktopApi.browser` 契约；渲染端 `src/renderer/browser/*`（多标签 webview、地址/搜索、页内查找、缩放、下载、截图、菜单、首页 localStorage）；接入右侧面板 PanelTabs（浏览器标签，flush 布局）。
- Layer B 完成：`browser-window.html` 独立入口（vite 多入口），`windows.ts` 独立窗口（query 携带 instanceId/URL/tabs 快照），「在新窗口中打开 / 还原为标签页 / 独立窗口关闭回位」全链路（restore-to-main、detached-window-closed 广播）。
- i18n：`browser.*` 中英文案并入 `src/shared/i18n.ts`；PanelTabs 新增 flush 形态。
- 验证：`pnpm typecheck` 通过；`pnpm test` 254 例中 253 过（`conversation.test.ts:308` 识图标题为存量失败，干净树复现，与移植无关）；`pnpm build` 通过，产物含 webview-browser.cjs 与 browser-window.html。
- Layer C/D/E 未开始：C 需用 safeStorage+node:crypto 重写密码保险库与登录态归档（导入功能 Rust-only，计划按平台降级）；D 含网络记录/路由 mock/CDP 白名单/右键菜单/代理；E 为 Pi extension + 本地桥 + 渲染端执行器（browserMcpOperations 移植）。计划文档在会话工作台 plan/snow-browser-port.md。

- Layer C 核心完成（commit 210043f）：`src/main/browser/passwords.ts` 密码保险库（safeStorage 包裹 AES-256 主密钥 + AES-256-GCM 记录库，~/.tether/browser-passwords，临时文件 + rename 原子写，safeStorage 不可用拒绝落盘）；guest preload 扩展自动填充/提交捕获（`browser-passwords:find/save` 带 webview sender + senderFrame origin 双重校验）；管理 IPC list/get/save/delete/delete-batch 仅限窗口渲染进程。`tetherPasswordBridge` 暴露给页面脚本。
- Layer C 余项：密码管理设置 UI、登录态归档（依赖 CDP，随 D 层）、浏览器数据导入（Snow 为 Rust/DPAPI/Keychain，TS 仅 macOS Chromium 现实可行，需产品决策降级边界）。
- Layer D/E 未开始（计划与会话工作台 plan/snow-browser-port.md 同步）。
- 白屏修复（commit daf3009）：沙箱 preload 无 __dirname，guest preload 路径改由主进程 `browser:webview-preload-path` 提供（file: URL），BrowserPanel 拿到路径后再挂 webview；同时修正独立窗口 preload/icon/page 的 bundle 相对路径（tsup 单入口把 browser/* 并入 dist-electron/main，基准是该目录而非 browser/ 子目录）。ELECTRON_ENABLE_LOGGING 复现验证：preload 正常、React 正常挂载。
- 面板标签交互重构（对齐参考设计）：空态为面板内嵌「打开标签页」选择器（PanelPicker）；已有标签时「+」弹出锚定下拉菜单（panel-add-menu），单实例类型（审查）已打开即从菜单隐藏；审查单实例、浏览器可多开（每标签独立 instanceId/webview/独立窗口迁移）；独立窗口关闭广播携带 instanceId。全屏遮罩式 TabPicker 与 panel-empty 空态移除。


## 2026-09-08：补齐 Agent 浏览器操作链（10:49，Asia/Shanghai）

- 根因：已有 webview UI，但没有浏览器 Pi extension 与主进程 Agent 命令通道。参考 Proma 的工具/提示词/超时与引用机制，以及 Snow 的 AX 快照、原生输入与 guest 路由，补齐 Layer E 基础操作。
- 新增 `src/extensions/browser.ts`、`src/shared/browser-tools.ts`、`src/main/browser/{automation,accessibility,page-operations}.ts`。17 个浏览器工具经 AgentHost 私有 Node IPC 驱动已登记 webview，无需外部 MCP 或 Playwright；现有 Runtime plan/ask/auto/full 权限 hook 继续生效。
- 功能覆盖导航/搜索、Observe/Find/ref、点击/悬浮、完整字段填写、键盘、等待、正文分页、滚动、原生下拉、开放 Shadow DOM 固定 CSS 操作、截图和标签管理。Agent 工作标签与用户查看标签独立；浏览器面板/侧栏切换保留 guest；操作前等待 React 展示 ACK。
- 可靠性：导航和新快照作废旧 ref；跨标签 ref 拒绝；观察期间导航拒绝；新 loader 就绪后返回导航结果；超时/停止取消排队动作；悬浮后重新验证原节点及点击点；大元素使用可见命中点；取消后短时释放可能按住的鼠标/键盘。独立审查发现的 3 项边界已修复。
- UI 展示中文浏览器操作名称，修复 localhost/about:blank 解析；README 双语增加使用方式与权限说明。新增 `pnpm test:browser` 隔离 Electron smoke 命令。
- 验证：`pnpm typecheck`、完整构建、真实 Electron BrowserPanel 本地页面 smoke、`git diff --check` 通过；真实 Agent RPC + 本地模型 fixture 验证工具可见性及 IPC 回环。新增 25 项浏览器相关单测全部通过；全量 278/279，唯一失败仍为 `conversation.test.ts:308` 既有识图标题断言。
- 生效方式：重启 Tether 并重新启动 Agent 会话。未操作真实账号、未请求云端模型，未重启用户当前进程，未提交/发布。保留同期 UI 菜单/样式改动；AGENTS.md 未修改。详细证据在会话工作台 `3d29745f-5635-4f1b-96ca-3a1165dc7f29/verification.md`。
- Layer D 网络/代理、Layer C 管理 UI/归档，以及文件上传/任意 JS 等未在本次实现；跨窗口迁移会重建 guest，需重新列出标签。


## 2026-09-08：修正默认外部打开（11:03，Asia/Shanghai）

- 用户截图显示“打开项目 web 端”后 Agent 执行 `open http://localhost:9001/unibest/`。只读核验当前 RPC worker 参数，仍仅加载 vision/provider，没有 browser.js；运行中的旧 Electron 主进程尚未更新，因此新建对话也无法获得上一轮浏览器工具。必须完全退出并重启 Tether，再启动 Agent 会话。
- 新增 `src/extensions/browser-routing.ts` 与 tool_call guard：普通网页请求阻止常见系统 open/xdg-open/start/Start-Process/python webbrowser 及开发服务 --open，返回改用 browser_navigate 的具体提示；明确外部浏览器请求保留，文件打开/服务启动/文档字符串不误拦。该检测用于路由常见命令，不是完整 shell 安全解析器。
- 浏览器提示词明确区分“启动开发服务器”与“在内嵌面板打开真实端口/路径”，并禁止缺失工具时悄悄回退外部浏览器。双语 README 强调完全重启与仅刷新/新建对话的区别。
- 验证：33 项命令路由测试和 2 项真实 RPC 测试通过；后者用不会启动真实浏览器的临时 open fixture，确认外部命令被阻止并能改用 browser_navigate。类型检查、构建、diff 检查通过。全量 312/313，唯一失败仍是既有 conversation.test.ts:308 识图标题断言。
- 未重启或终止用户正在运行的 Tether/Agent 进程；本次修复将在应用完全重启后加载。日志在本会话工作台 browser-routing-build.txt / browser-routing-tests.txt。


## 2026-09-08：右侧面板松开后仍跟随鼠标的修复（11:16，Asia/Shanghai）

- 用户截图及反馈：拖动浏览器右侧区域宽度后，松开鼠标仍左右改变宽度。核验 Chat 原实现仅监听 window pointerup/pointercancel，无指针捕获、buttons 检查、失焦或卸载清理；webview 获取释放事件时，旧 pointermove 监听会持续工作。
- 新增 `src/renderer/panel-resize.ts` 并接入 Chat。主指针捕获；每次 move 在改宽度前检查左键仍按下；pointerup/pointercancel/lostpointercapture、blur、页面隐藏、面板收起/移除及组件卸载统一结束；恢复原 cursor/userSelect，保存宽度，移除监听。忽略右键与其他指针。
- `.is-resizing-panel` 仅在拖动时暂时禁用 webview/iframe 的鼠标命中，防止 guest 抢走释放事件；结束后恢复。原宽度计算与边界保持。
- 验证：9 项状态回归通过，覆盖释放事件丢失、失焦、捕获丢失和卸载。新增真实 Electron 原生鼠标测试：跨入实际 BrowserPanel webview 拖动、松开、随后左右移动，宽度固定且网页交互恢复。`pnpm test:browser`（含完整构建）、`pnpm typecheck`、diff 检查通过；全量 321/322，唯一仍为既有 conversation.test.ts:308 识图标题断言。
- 本轮是 renderer 修复。建议刷新一次 Tether 主窗口，清除旧代码可能残留的拖拽监听。未重启/中断用户会话。本会话未执行 Git 提交；收尾检查发现相关代码已由工作区其他操作纳入 `bf57c87`。日志：本会话工作台 panel-resize-smoke-results.txt / panel-resize-tests.txt。


## 2026-09-08：浏览器统一顶部单层标签（11:43，Asia/Shanghai）

- 用户批准合并顶部面板标签与浏览器内部标签。主面板现在每个网页对应一个顶部标签，按网页标题显示（未取得标题时显示域名或新标签文案）；地址栏下方直接显示网页。长标题省略并保留完整提示，标签过多时横向滚动，选中项自动进入可见区域，+ 始终可用；只剩浏览器可添加时直接新建。
- 新增 browser/panel-state.ts、use-browser-panels.ts、workbench-panels.tsx，集中管理顶部页面/选择/迁移。状态 hook 仍放在 App 生命周期，保留切换/移除项目期间接收独立窗口还原事件的能力。各网页保持挂载，标题或导航更新不会修改初始化参数并重载 guest。
- 网页前台链接、中键后台打开、手动 + 和 Agent 新建统一进入顶部；后台打开保持当前选择。Agent 关闭主模式页面会关闭对应顶部标签，不再隐式创建首页。独立窗口保留内部多标签，还原时每页独立回到顶部，并处理随后窗口关闭广播，避免覆盖已还原页面。
- BrowserPanel 单独保存实际页面 URL，窗口迁移快照使用已导航地址，不使用最初 src 或地址栏编辑草稿；页内 iframe 导航不改写顶层地址。跨窗口仍按原机制重建 guest，不承诺保留跨窗口表单/滚动状态。
- 验证：新增8项状态测试通过；pnpm typecheck、pnpm test:browser（完整构建 + 两组真实 Electron 回归）、git diff --check通过。新增隔离 fixture 直接复用生产 WorkbenchPanels/BrowserPanel，覆盖唯一标签栏、标题、前台与原生中键后台链接、手动与AI新建/关闭、输入与guest保留、实际URL及多页还原、320px窄窗口长标题和滚动。旧浏览器操作与原生拖拽测试继续通过。
- 全量测试329/330，唯一失败仍为既有 conversation.test.ts:308 识图标题断言。双语README已更新。未重启用户进程、未发布或提交、未修改AGENTS.md。验证日志与截图在会话工作台 single-tabs-tests.txt / single-tabs-smoke.txt / single-tabs-electron.png。


## 2026-09-08：放宽右侧网页面板上限（12:04，Asia/Shanghai）

- 用户反馈 Web 端在右侧过于拥挤。定位 Chat 在拖动、读取和保存三处共用固定480px上限；取消该上限，新增 panel-width.ts，按实际 chat-body 宽度动态计算，正常窗口保留320px对话区域，极窄窗口仍让两侧可见。
- 通过 ResizeObserver 适配实际容器尺寸；区分用户偏好与当前显示宽度，窗口变窄时临时收缩，重新放大恢复原偏好，不覆盖已保存的大宽度。修正缺失/异常本地配置的默认值，读取和保存不再截断至480px。
- 8项新增宽度测试、类型检查、完整构建通过；全量337/338，唯一失败仍为既有 conversation.test.ts:308 识图标题。真实Electron新增实际Chat验收：1440px窗口/240px项目栏下网页可拖到880px，对话320px；缩小后自动收窄、放大后恢复880px，同一guest保留，刷新仍恢复880px。旧单层标签、原生中键后台打开、跨webview拖拽释放等回归通过。
- 回归中发现网页title事件可早于guest登记；将原有测试等待改为同时确认标题和登记数量，保留断言。首轮整组测试在该时序上失败，修正后node scripts/test-browser.mjs全组通过。
- 证据：本会话工作台 panel-width-tests.txt / panel-width-smoke.txt / expanded-panel-electron.png。未重启用户进程、未提交/发布、未改AGENTS.md。


## 2026-09-08：左侧菜单可收为图标窄栏（12:18，Asia/Shanghai）

- 用户希望右侧网页拉大时，左侧项目菜单可以像参考图那样最小化。SidebarNav 新增手动收起/展开按钮，252px完整菜单收为56px图标栏，释放196px空间；收起后保留新对话、项目、设置入口和中文/英文可访问名称。
- localStorage 记住折叠状态；项目与会话节点仅隐藏，不卸载。设置菜单沿用原AccountMenu及其portal，通过真实入口验证仍可打开。macOS下折叠按钮位于红黄绿控制下方，聊天标题左侧为跨出窄栏的窗口按钮留位。
- 与上一轮动态宽度联动：侧栏变窄后，chat-body ResizeObserver获得额外空间，可继续拖宽网页；展开左栏时临时限制右侧宽度，再收起时恢复偏好。不会重建guest或触发网页刷新。
- 扩展真实Electron fixture，直接复用生产SidebarNav、AccountMenu、Chat、WorkbenchPanels；原生输入验证折叠、展开、三个图标入口、设置菜单、节点/guest保持、macOS位置及重载持久化。1440px窗口中实际侧栏252px时网页最大868px，收为56px后可达1064px，均保留320px对话区域。
- pnpm typecheck、pnpm test:browser（完整构建+全部真实浏览器/拖拽/侧栏回归）、git diff --check通过。全量337/338，唯一失败仍为既有conversation.test.ts:308识图标题断言。双语README更新；截图与日志位于本会话工作台 collapsed-sidebar-electron.png / sidebar-smoke.txt / sidebar-tests.txt。未重启用户进程、未提交或发布，未修改AGENTS.md。


## 2026-09-08：修正窄栏遗漏项目与会话（12:38，Asia/Shanghai）

- 用户指出收起后看不到项目和会话。上一版将thread-list整体隐藏，只保留通用操作入口，未满足窄栏仍能切换项目/会话的需求。本轮移除隐藏，沿用现有项目列表与SessionRow，折叠状态显示名称前两个字符，完整title及aria-label保留，当前项目和会话高亮。
- 窄栏列表可滚动、各项目分组和会话条目可直接点击，展开态继续显示完整名称；会话置顶标记、右键菜单保留，重命名输入框显示在窄栏右侧，避免在56px内输入。未改原项目/会话切换回调或展开状态。
- 扩展真实Electron回归：两个项目、四个真实SessionRow；原生点击切换项目/会话且保持56px，缩短窗口验证列表滚动，原生右键重命名并检查活动状态，展开/收起保持节点及guest。旧标签/动态宽度/拖拽释放回归继续通过。
- pnpm typecheck、完整构建与pnpm test:browser、git diff --check通过。全量337/338，唯一仍为既有conversation.test.ts:308识图标题断言。README双语更新。证据：sidebar-navigation-smoke.txt / sidebar-navigation-tests.txt / collapsed-sidebar-electron.png（本会话工作台）。未重启用户应用、未提交或发布、未改AGENTS.md。


## 2026-09-08：拖大右侧自动收起左栏与线性动画（13:04，Asia/Shanghai）

- 用户要求右侧拉大到一定程度时自动收起左栏，给会话区留空间，动画更线性。新增sidebar-layout.ts管理手动与自动折叠状态，App及真实fixture共享。拖大后会话可用空间不足420px触发自动收起；缩回保持收起，用户可手动展开，自动状态不覆盖已保存的手动选择。
- 侧栏252→56px采用180ms linear宽度过渡，遵循系统减少动态效果偏好。调整min-width与flex约束使宽度过渡生效，溢出文字不进入会话区。既有项目/会话窄栏导航与右键菜单保持可用。
- 拖动中保留目标宽度，侧栏释放空间时仍能向指针对应宽度变化；松开时将当下实际宽度固定并保存，剩余动画仅扩大会话区。修正越过面板最小宽度时从220反跳到默认268的问题。
- 真实Electron验证：剩余440px不触发、400px触发并增加196px到596px；线性0.18s样式与单调中间帧；同一拖动中反向移动不展开，继续拉大可到1064px且保留320px会话；手动展开、动画中快速松开后宽度稳定、窗口缩放/刷新、guest和手动偏好保持。旧浏览器工具/单层标签/拖拽释放/窄栏导航及重命名回归通过。
- pnpm typecheck、pnpm test:browser（含完整构建）、git diff --check通过；全量342/343，仅既有conversation.test.ts:308识图标题断言失败，新增5项单测通过。README双语更新。证据：会话工作台auto-sidebar-smoke.txt / auto-sidebar-tests.txt / expanded-panel-electron.png（本轮自动收起后的截图）。未重启用户应用，未提交/发布，未改AGENTS.md。


## 2026-09-08：右侧标签上移至窗口标题栏（13:22，Asia/Shanghai）

- 用户附红框与Proma参考图，希望「审查 / 网页 / ＋」占据窗口最顶部原空白区域，与左侧会话标题同高，从而增加网页内容高度。Chat标题栏拆分为会话标题区和与右侧面板同宽的标签区，面板开关与窗口控件继续在右端。
- PanelTabs通过上下文提供的稳定DOM容器，仅将现有标签栏Portal到标题栏；网页内容保留原组件树及guest，独立/无Chat容器场景仍在面板内渲染标签。标签、加号明确no-drag，空白区域可拖动窗口；macOS窄侧栏避让只作用于会话标题区域，右侧边界不受padding干扰。
- 新增scripts/workbench-header-smoke.ts并接入真实Electron回归：测量标题与面板边界一致、地址栏紧接标题栏、内容增高37px；原生点击切换/关闭标签、新建页、加号菜单、关闭/打开面板，无窗口位移，guest及输入保留。验证长标题提示与溢出、窄窗口，随后完整跑动态宽度/自动收起/动画中松开/窄栏导航回归，均通过。
- pnpm typecheck、完整构建与pnpm test:browser、git diff --check通过。全量342/343，唯一仍为既有conversation.test.ts:308识图标题断言。README双语更新。证据：会话工作台top-tabs-smoke.txt / top-tabs-tests.txt / top-tabs-electron.png。未操作用户Google页，未重启用户应用、未提交或发布、未改AGENTS.md。

## 2026-09-08：移除待办浮层旁的回到底部箭头（18:46，Asia/Shanghai）

- 用户附红框截图，要求去掉底部待办进度胶囊右侧的圆形 ↓ 按钮。progress-overlay.tsx 删除任务存在时并排渲染的 progress-overlay-jump 按钮，styles.css 移除对应两条规则并更正区块注释；无任务时的独立回到底部箭头（conversation-latest）保留，atBottom/onFollowLatest 仍为该分支服务。
- 顺手修复全量测试唯一红项：conversation.test.ts:308 识图标题断言仍期望 ca17ab5（8-21）多供应商改造前的「GLM-4V 识图」前缀，与 vision-api.test.ts 及现实现（「识图 · 模型」）不一致，HEAD 上即失败；已对齐为「识图 · glm-4v-flash · MinerU OCR」。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。含上一会话未提交的进度浮层聚合改动（collectProgressTasks + ProgressOverlay）。未提交/发布，未改AGENTS.md。

## 2026-09-08：优化回到底部按钮与任务列表浮层样式（18:52，Asia/Shanghai）

- 回到底部独立箭头（conversation-latest）从右缘 26px 方钮改为居中 32px 圆形悬浮钮：与进度胶囊同视觉语言（line-strong 描边、88% 表面模糊、raised 阴影），hover 上浮 1px，不再贴着滚动条。
- 任务列表浮层（progress-overlay-popover）：12px 圆角 + 94% 表面模糊；表头粘性置顶带底部分隔线，右侧新增「完成数/总数」计数 chip（progress-overlay.tsx）；任务行加高至 7px 8px、8px 圆角，运行中行加 accent 7% 底色高亮，已完成文字弱化为 ink-3，失败状态文字标红。
- 新增浮层区域 prefers-reduced-motion 守卫：禁用相关过渡与 progress-spinner 旋转，hover 不再位移。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：移除停止时的「正在停止…」toast（19:13，Asia/Shanghai）

- 用户附截图红框，要求暂停/停止时不再弹出提示。App.tsx 停止流程（agent abort）删除 setToast(t("toast.stopping"))；i18n.ts 移除中英 toast.stopping 词条（已无引用）。stopping 状态本身保留，仍用于流式收尾与 ExecutionFlow 状态文案。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：进度胶囊兼任一键回到底部（19:17，Asia/Shanghai）

- 用户反馈：任务浮层显示期间没有回到底部入口（上一轮移除了胶囊旁的箭头）。方案：不新增悬浮钮，进度胶囊按状态分流——不在底部时点胶囊/回车即回到底部（先收起已展开列表再 followLatest，title 为「回到最新」）；已在底部时维持原行为展开任务列表。
- 胶囊尾部图标随状态切换：非底部显示 ↓（提示回到底部），底部显示 ›/⌄（提示展开列表）。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：一键到底滚动动画丝滑化（19:21，Asia/Shanghai）

- 原实现（use-follow-scroll.ts followLatest）：每帧走剩余距离 50%，但距离超过一屏直接 done=true 瞬移到底——用户反馈一键到底不丝滑的根因。
- 改为时间基动画：指数趋近（时间常数 45ms，帧间隔换算、帧率无关）叠加每帧限速（max(48, 视口高 30%) px/帧@60fps 等比缩放），近距离指数收尾、远距离有界匀速滑行，任何距离都不瞬移；流式追加内容时 target 每帧重算持续跟随；reduced-motion 仍瞬时到位；保留 lastAssigned/currentTop 记账避免 scroll 监听把程序滚动误判为用户意图。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：到底部后继续滚动不再误显回到底部箭头（19:23，Asia/Shanghai）

- 根因：use-follow-scroll.ts 的 intent（wheel/touchstart/pointerdown/方向键）无条件判为「离开底部」，已贴底时继续向下滚或触控板回弹也触发，箭头误显示。
- 修复：intent 先算当前距底距离，≤16px（与滞回恢复阈值一致）直接返回，不打断跟随；真正离开底部后才取消跟随并显示箭头。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：输入框图片改为卡片式附件预览（参考 Proma-main AttachmentPreviewItem）（19:59，Asia/Shanghai）

- 之前图片贴在 contentEditable 文本流里（.prompt-upload 行内 28px chip），改为独立状态数组 attachments + 输入区上方卡片行（68px 缩略图、圆角 10px、hover 右上角黑色半透明圆形 ×、点击开 lightbox）。
- ui.tsx：新增 attachments 状态与 removeAttachment/addUploads（写 state 取代 DOM chip）；sendNow 用 attachments 生成 dataUri 列表；blank 与 attach 按钮 disabled 改用 attachments.length；移除 makeUploadChip/insertNodeAtCaret/collectPromptImages/promptSvg 死代码与 contentEditable 的 chip 删除 onClick；新增 lightbox portal（复用 .modal/.lightbox）。
- styles.css：.prompt-upload 系规则替换为 .prompt-attachments/.prompt-attachment{,-img,-remove}；删掉 .prompt-input .prompt-upload 两条。
- 发送后消息气泡里的图片展示（UserTurn 缩略图）暂保留原样，后续再按 Proma MessageAttachments 对齐。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：发送后用户消息图片展示对齐 Proma MessageAttachments（20:04，Asia/Shanghai）

- ui.tsx UserTurn：图片区分单/多图——单图较大等比缩放（≤500px，object-contain），多图 280px 方块网格（object-cover），均圆角 12px 点击看大图；每张 hover 底部右下角黑色半透明「保存」悬浮按钮（Download 图标，data-URI 直接下载）。新增 Download 导入。
- styles.css：.user-images 改为 flex-wrap gap 8px；新增 .user-image-wrap/{single}/.user-image-save；单图 object-contain、多图 object-cover 规则替换原统一 140px。
- 注：Proma 的保存走 electronAPI.saveImageAs(localPath)，Tether 无此桥接，改用锚点下载 data-URI；无左右翻页（图片数据即 data-URI，可后续按需加）。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。
