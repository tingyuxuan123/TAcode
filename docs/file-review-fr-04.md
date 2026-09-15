# FR-04：Git 暂存、取消暂存与可恢复还原

2026-09-14，独立工作树 `codex/file-review-workbench`。本阶段把 FR-03 的不可变 Git 快照接到真实写操作，并保留和 Agent `/undo` 分开的恢复语义。

## 操作语义

- 未暂存范围：暂存把选定文件/代码块写入 index；还原以当前 index 为基准，保留已暂存内容。
- 已暂存范围：取消暂存仅改变 index；还原同时逆向处理 index 与工作文件，额外未暂存内容必须能完整保留，重叠时拒绝。
- 整批、文件、Git 原始 hunk 三种粒度；历史范围不允许写入。请求引用主进程持有的不可变快照，不接收渲染层补丁或绝对文件路径。
- 准备阶段在私有临时 index/目录中预检。确认还原前显示实际路径，执行时再次核对快照、index、HEAD 和原始工作文件版本。
- 同一仓库串行写入，持有标准 index.lock；还原在修改前持久化本地恢复点，恢复只处理该次涉及的路径，后来同路径变化不会被自动覆盖。
- Git 还原与聊天的 Agent `/undo` 独立。Git 锁、冲突、补丁不匹配和恢复失败展示具体状态。

## 实现边界

主进程 `GitMutationService` 只接受订阅绑定的 snapshotId 和 file/hunk 标识，渲染层不提交补丁、绝对路径或 index 内容。准备阶段以私有 index 和临时工作树生成候选结果，确认时重新核对项目授权、HEAD、index 字节版本和原始文件指纹；同一 common-dir 的写操作按队列串行。发布使用标准 `index.lock` 与文件事务，目标文件出现并发变化、锁已存在或回滚失败都会保留现有内容并返回具体错误。

暂存整批/文件使用 `update-index` 和对象写入，hunk 使用冻结补丁；取消暂存只改 index。未暂存还原以 index 为基准，已暂存还原同时逆向处理 index 与工作树，非重叠的额外编辑保留。Git 仅在严格补丁校验失败且“只归一化行尾”的副本仍严格匹配时使用空白回退，因此 CRLF 可以通过，用户在同一 hunk 内的空格编辑会拒绝。文件事务以原始字节、BOM、CRLF、权限和符号链接目标为单位，恢复点保存前后版本并排他发布。

恢复点位于 TACode 数据目录的私有目录，manifest 和每个 blob 均排他创建并同步目录；渲染层重载后仍可列出，恢复只处理记录路径且要求 index 处于记录的 before/after 状态。后来同路径变化、HEAD 变化、不同项目或重复恢复都会返回 `recoveryConflict`，不会覆盖新内容。

## 验证

`src/main/git/git-mutations.test.ts` 共 **22 项**真实临时仓库用例，覆盖：整批/文件/hunk 暂存与取消暂存；未暂存和已暂存还原；重命名、二进制、空文件、未跟踪/删除、unborn index、split index、中文和特殊路径；BOM/CRLF、权限和符号链接；重叠补丁、同 hunk 空格编辑、过期确认、并发 index.lock、并行写入、文件事务回滚、恢复点跨实例/跨 reload、后来修改冲突、冲突 index 与历史只读边界。

最终仓库检查：`pnpm test --reporter=dot --maxWorkers=4` **126 个测试文件 / 1098 个用例通过**；`pnpm typecheck`、`pnpm build` 通过。构建保留既有的大 chunk 提示；默认测试并发偶尔会让既有 `state.test.ts` 的真实会话目录刷新超过 5 秒，限制为 4 个 worker 后稳定通过，未修改该断言。

生产 Electron Git 烟测使用真实 preload、IPC、React 工作台和临时仓库，13 个阶段全部通过：hunk/file/batch stage、unstage、discard；还原确认取消；重叠补丁和 index.lock 保护；保留额外未暂存编辑；恢复点跨 renderer reload；二进制；项目切换/历史只读；窗口关闭后订阅、读取和 diff worker 均为 0。最新两次外部刷新耗时 **342 / 307 ms**，网络请求 0，renderer 错误 0。结果文件：`file-review-reference/fr-04-result.json`；截图和原始 JSON 在 `/Users/yfdl/.codex/visualizations/2026/09/13/01a099c7-0f72-74d0-bd86-89ddf4e353bf/file-review/fr-04/`，早期失败记录已移入其 `earlier-failures/`。

验证环境为 macOS Darwin 25.6.0 / Apple M5 / Electron 37.10.3 / Chromium 138 / Node 22.21.1。Windows 的锁、权限、符号链接和换行边界尚未在实机验证；大规模性能与提交/推送仍由 FR-05、FR-15 验收。
