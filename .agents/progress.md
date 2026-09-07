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
