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
