# FR-01：文件与审查基础组件验收

2026-09-13，独立工作树 `codex/file-review-workbench`。

## 实现

- `src/renderer/workbench` 提供白底工具栏、面包屑、文件类型图标、右侧可调宽文件树，以及文件/审查两个可复用区域。
- CodeMirror 6 负责实际编辑、保存回调、撤销重做、查找替换、定位、换行、只读及按需加载语言；保留文本 CRLF。
- `@pierre/diffs` 的 CodeView 负责连续多文件差异、统一/左右布局、单词差异、上下文和文件折叠、导航及虚拟滚动。Shiki 和两个 ES Worker 均从本地构建加载。
- 参考图语法色取样为 `#00880a`、`#bd5800`、`#d53638`、`#751ed9`、`#0071ea`；浅色覆盖只作用于新区域。另有局部深色 token 映射。
- 文件树采用固定 28 px 行高的窗口化列表。ResizeObserver 只测量视口，通过 animation frame 更新，避免测量/写入循环。
- diff 内容缓存与显示版本分开：新增/删除文件也有缓存键，折叠时发布新的显示版本；筛选时保持未变化 diff 对象的身份，避免异步高亮与布局不一致。

## 证据

`pnpm test:file-review` 构建独立 Electron 页面、临时用户数据及本地 Worker，关闭所有 HTTP/HTTPS/WS/WSS 请求，使用 `webContents.sendInputEvent` / `insertText` 操作实际组件。窗口不显示，不抢占另一个任务的桌面输入。

通过项目：中文输入、保存快捷键、撤销/重做、查找、根目录搜索深层文件、切文件、只读输入保护、CRLF 保留、离线 Worker、高亮、连续多文件虚拟滚动、统一/左右视图、文件跳转、折叠/展开、树与 diff 同步筛选、分栏键盘调整/收起、动作回调、历史范围隐藏写操作、600 px 窄面板、局部深色及英文控件。

- macOS Darwin 25.6.0 / Apple M5，Electron 37.10.3 / Chromium 138.0.7204.251。
- 文件视口 820 × 785，审查视口 836 × 740，DPR 2，缩放 1。
- 首屏挂载 1 / 9 个 diff 文件，242 个着色 token；两个 Worker 成功初始化并写入 diff 缓存。
- 网络请求 0，渲染器错误 0。原始运行结果见 `file-review-reference/fr-01-result.json`。
- 全量 **120 个测试文件 / 1027 个用例通过**；`pnpm typecheck`、`git diff --check` 通过。
- 全量检查发现既有 session-index 文件监听测试在默认 1000 ms 边界上失败，单独运行约 862 ms 通过。仅将该系统事件断言上限改为 3000 ms，并保留通知/关闭后无回调的断言；全量随后通过。

截图目录：`/Users/yfdl/.codex/visualizations/2026/09/13/01a099c7-0f72-74d0-bd86-89ddf4e353bf/file-review/fr-01`。已检查 `files-default`、`files-filter`、`review-unified`、`review-split`、`review-narrow`、`review-dark` 等截图。

## 阶段边界

本阶段是生产组件的独立集成验证。夹具提供示例文档、diff 和动作回调；实际文件读写、Git 暂存/还原/提交、持久化和 AI 审查仍由 FR-02～13 完成。当前截图使用本仓库代码样本，最终与参考图逐项对齐及旧入口替换归 FR-14；Windows 与规模性能证据归 FR-15。

下一项 FR-02：独立 Git 读取服务和真实临时仓库测试。
