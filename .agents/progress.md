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
