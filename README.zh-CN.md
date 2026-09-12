<div align="center">

<img src="build/icon.png" width="96" alt="TACode logo" />

# TACode

**基于 Pi 生态构建的本地优先 AI 编程工作台**

让 DeepSeek 与 OpenAI 兼容模型安全地阅读、修改和验证你的代码仓库。

[English](README.md) · [简体中文](README.zh-CN.md) · [下载最新版](https://github.com/tingyuxuan123/TAcode/releases/latest)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-lightgrey)](https://github.com/tingyuxuan123/TAcode/releases/latest)

</div>

TACode 是一个面向真实代码仓库的 Electron 桌面 Agent。它把模型调用、文件工具、终端命令、权限审批、会话记录与 Diff 审查放进同一个本地工作台；你的界面与会话数据保存在本机，模型请求直接发送到你配置的服务商或本地网关，不经过 TACode 中转。

## 为什么是 TACode

- **DeepSeek 优先**：支持自定义 Base URL、模型发现和推理强度设置，也可连接 OneAPI、Ollama、vLLM 等 OpenAI 兼容端点。
- **可见、可控**：实时展示工具调用、命令输出、文件改动和上下文用量。
- **权限隔离**：提供仅规划、编辑时询问、工作区权限与完全访问四种模式。
- **安全改动**：每次补丁保存文件检查点，可通过 `/undo` 恢复上一轮修改。
- **本地优先**：设置、凭据与会话存放在 `~/.tacode`，无遥测、无 TACode 云端代理。改名前的数据目录会在首次启动时一次性拷贝过来，并保留作回退。
- **桌面体验**：项目会话树、`@` 文件引用、生成中插话、图片输入、主题（纯白 / 纸质 / 暗色）、Diff 预览和中英文界面。

## 基于 Pi 的哪些部分

TACode 没有重复实现 Agent 基础设施，而是直接依赖 [Pi 生态](https://github.com/earendil-works/pi)，并在 [`src/runtime`](src/runtime) 中自持运行时层：

| Pi 包 | TACode 使用的能力 |
| --- | --- |
| `@earendil-works/pi-agent-core` | Agent 状态、消息流、工具调用与思考级别类型 |
| `@earendil-works/pi-ai` | 模型与提供商协议、消息/图片/用量类型、OpenAI API 适配基础 |
| `@earendil-works/pi-coding-agent` | Coding Agent 扩展系统、会话与设置、项目信任、RPC Client/Worker |
| `@earendil-works/pi-tui` | Runtime CLI 的文本组件、主题与终端交互基础 |

在此之上，TACode 增加：

- DeepSeek 默认配置与 OpenAI 兼容网关体验
- 四级权限模型、macOS Seatbelt 与实验性 Windows sandbox helper（需安装并启用）
- 工作区约束工具、托管命令、文件补丁与持久化 Checkpoint
- MCP、Hooks、Skills、计划与子 Agent 集成
- `~/.tacode` 本地数据约定和 Electron/React 桌面工作台

Pi 提供运行基础；TACode 负责产品边界、安全策略和桌面交互。感谢 Pi 生态维护者提供的开源基础。

## 架构

```text
React Renderer
  对话、Diff、设置、项目与会话 UI
        │  contextBridge / Electron IPC
        ▼
Electron Main
  窗口、工作区、凭据与 Agent 进程托管
        │  JSON-RPC over stdio
        ▼
TACode Runtime（src/runtime）
  权限、沙箱、工具、会话、凭据与 RPC 入口
        │
        ▼
Pi ecosystem
  Agent loop · model protocol · coding-agent extensions · RPC · TUI
```

渲染进程不直接访问 Node.js；所有桌面能力都通过 `src/shared/types.ts` 定义的 IPC 契约进入主进程。Agent 在独立工作进程中运行，崩溃后可以从已落盘会话继续对话，但不会自动重放未完成命令。

## 模型与图片

在「设置 → AI 服务」中添加模型供应商：选择预设或自定义服务，填写名称、API URL 和密钥，再发现模型或手动输入模型 ID。预设地址和接口格式也可以编辑。每个模型可设置上下文、最大输出、图片输入与推理等级。

- 支持 Chat Completions、Responses、Anthropic Messages、Google Generative AI，以及按 Chat Completions 接入的 OpenCode Go。只提供当前运行时支持的格式，不包含 Codex OAuth 登录。
- 可编辑、删除、启用/禁用服务，并选择默认服务与模型；同一厂商可添加多个独立服务。未设置桌面服务时保留原有 DeepSeek 配置。
- 「测试连接」会向所选模型发送一次短生成请求，可能产生少量费用；模型列表获取成功不代表模型一定可以生成。
- 每个服务使用独立凭据条目，密钥不写入供应商元数据。凭据由 TACode CredentialStore 管理（具体使用系统凭据库还是文件存储取决于运行时配置）；元数据位于 Electron userData 下的 `providers.json`。
- 修改服务后关闭设置，在下一次发送时应用配置。原生 PDF 配置和跨模型自动调度不在本功能范围；PDF 继续使用现有 OCR 流程。

粘贴图片时：

- 识图可用官方 DeepSeek Vision，或自行配置 GLM-4V 等兼容接口。
- MinerU 用于 OCR 解析，目前会将图片发送到 MinerU 服务，不应视为离线本地 OCR。

## AI 操作内置浏览器

选择项目并启动会话后，Agent 会自动加载 `browser_*` 工具，可直接操作工作台中的浏览器，无需额外安装浏览器 MCP 或 Playwright。例如：

> 打开 localhost:5177，找到搜索框，输入“中文测试”，提交并确认结果。

> 打开这个网站，找到文档入口，把相关内容整理给我；需要保留页面时新建标签。

支持导航与搜索、无障碍快照、按角色/名称查找、真实鼠标点击、完整字段填写、键盘、条件等待、正文分页提取、滚动、原生下拉、悬浮、固定 CSS 操作及视口截图。快照为元素提供 `ref`；重新观察、导航或元素替换后应重新获取引用。开放 Shadow DOM 可通过 `host >>> button` 定位。截图需要支持图片输入的模型。

左侧项目菜单可通过顶部按钮收为 56px 窄栏。向左拖大右侧面板，使会话区不足 420px 时，菜单会自动收起以释放空间；收起和展开采用 180ms 线性宽度动画，并遵循系统的减少动态效果设置。自动收起后保持窄栏，可手动展开；手动选择会被记住，自动收起不会覆盖该偏好。项目和会话显示短名称，悬停可查看完整标题，点击直接切换；当前项高亮，列表可滚动。新对话、项目和设置入口继续可用。松开分隔线后，右侧宽度保持稳定，剩余动画释放的空间留给会话区；调整布局不会重载网页。

新会话发送第一条消息后，会使用当前选中的模型在后台生成简短标题，同步到顶部和左侧会话列表。命名只发起一次独立的短请求，不阻塞正常回复；生成失败时保留截短的首条消息，手动改名始终优先。自动标题最多 32 个字符，顶部显示宽度最多 320px，空间不足时显示省略号，悬停可查看完整标题。

右侧顶部只保留一层标签，网页与“审查”并列，标签显示网页标题。标签栏位于窗口最上方，与左侧会话标题同高，并随右侧面板宽度对齐；浏览器地址栏紧接其下，网页内容多出原标签行约 37px 的高度。点击“+”、网页新开链接或 Agent 新建页面都会进入顶部；中键后台打开会保留当前选择。独立浏览器窗口保留自己的标签栏，还原时每个页面分别回到顶部。

Agent 工作标签与用户当前查看的标签独立。切换右侧面板或收起侧栏会保留浏览器页面；操作前自动展示目标标签并等待布局就绪。独立浏览器窗口也可操作；窗口迁移会重建 guest，Agent 需重新列出标签。

本地文件不需要静态服务器：`browser_navigate` 也接受工作区内的 HTML 文件路径（`path`，如 `demo/index.html`），经 `harness-preview://` 协议加载，相对资源与 storage 可用；预览文件或同目录资源变更后，页面会自动刷新。只有页面确实依赖 HTTP 接口或目录服务时才启动开发服务器。

工具遵守运行时权限：Ask 模式走原有确认流程，Plan 模式当前不允许浏览器工具。发送、发布、购买等最终动作仍需要用户授权。导航支持 HTTP、HTTPS、localhost、`about:blank` 与上述工作区文件预览。

“打开项目 Web 端”默认通过内嵌浏览器工具打开；开发服务启动后使用其实际端口和路径。Agent 误用系统 `open` / `xdg-open` / `start` 或开发服务 `--open` 时会被纠正，只有用户明确要求外部浏览器才允许这些启动方式。

更新主进程或扩展代码后需要**完全退出并重新启动 TACode**，再启动/重建 Agent 会话；仅刷新界面或新建对话不会更新旧主进程。回归检查可运行 `pnpm test:browser`，它使用临时配置目录和本地测试网页，不访问真实账号或请求云端模型。

## 权限模式

| 模式 | 行为 |
| --- | --- |
| `plan` | 只读分析与规划；诊断命令可在只读沙箱中运行 |
| `ask` | 写入、网络或越界操作前请求确认 |
| `auto` | 自动执行工作区内的常规操作，越界时请求确认 |
| `full` | 关闭工作区沙箱，适用于用户明确授权的可信项目 |

沙箱是纵深防御，不替代代码审查。执行未知仓库中的命令前仍应检查 Agent 给出的操作。

## Agent Skills

Skills 由 Pi 运行时加载。标准路径：

| 范围 | 路径 |
| --- | --- |
| 项目（需信任） | `.agents/skills/<name>/SKILL.md`、`.pi/skills/<name>/SKILL.md` |
| 用户全局 | `~/.tacode/skills/<name>/SKILL.md`、`~/.agents/skills/<name>/SKILL.md` |

每个 skill 目录包含 `SKILL.md`，frontmatter 需有 `name` 与 `description`。输入 `/skill:名称` 调用；设置 → Agent Skills 可查看已加载列表；输入 `/` 时也会出现在补全里。

## 子代理

内置 `explorer`、`code-reviewer`、`test-runner`、`fixer` 分别负责探索、独立审查、指定验证和机械修改。主代理只委派可独立交付的工作，通常同时使用 1–3 个子代理，负责设计与最终整合；角色可在设置 → 子代理中配置。

任务应包含目标、路径、已知事实、约束和完成条件。报告用 `complete` / `partial` / `blocked` 区分完成度，给出结论、证据与限制。派发、等待、自定义定义和模型配置见 [子代理工作流](docs/subagent-workflow.md)。

## 使用

从 [GitHub Releases](https://github.com/tingyuxuan123/TAcode/releases/latest) 下载：

- macOS：Apple Silicon / arm64
- Windows：Windows 10/11 x64

首次启动后：

1. 打开项目目录。
2. 在设置中填写 DeepSeek API Key 或自定义兼容端点。
3. 输入任务，审查工具执行与文件 Diff；需要时使用 `/undo`。

### 生成中插话

生成过程中仍可输入并回车，内容会作为插话立刻交给当前轮次（显示在输入框上方），而不是排队等本轮结束后再发。`/` 命令不会作为插话发送。换对话、新对话或换项目会清空未完成的插话展示。

当前 macOS 包使用开发签名。若 Gatekeeper 拦截，请右键应用选择“打开”，或执行：

```bash
xattr -cr /Applications/TACode.app
```

## 本地开发

要求 Node.js `>=22.19` 和 pnpm。

```bash
git clone https://github.com/tingyuxuan123/TAcode.git
cd TAcode
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

Agent 运行时位于本仓库 `src/runtime`（RPC 入口、工具、沙箱、凭据与会话），直接依赖 `@earendil-works/pi-*`。`pnpm build:electron` 会把 worker 编译到 `dist-electron/runtime/rpc-entry.js`；`pnpm test` 通过 `scripts/ensure-runtime.mjs` 按需构建。

## 致谢

TACode 的 Agent 运行时基于开源 [Pi 生态](https://github.com/earendil-works/pi)（`@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui`）构建。TACode 自有的运行时层（`src/runtime`）补充 DeepSeek 默认体验、权限模式、沙箱、后台命令托管与本地数据布局。Pi 依赖保留各自的许可证与版权。

## 隐私说明

TACode 不运行遥测或模型代理服务器。会话、设置与凭据保存在本机；但为了完成任务，提示词、相关代码上下文与图片会发送给你选择的模型、网关或 OCR 服务。使用第三方服务前请阅读其隐私政策，敏感项目可连接本地兼容端点。

## License

[MIT](LICENSE)。Pi 生态依赖保留各自的许可证与版权。
