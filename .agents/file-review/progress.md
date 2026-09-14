# 文件与审查专项进度

## 2026-09-13 初始化

- 在原工作区只读核对后，建立 codex/file-review-workbench 独立分支与工作树，起点 fdc2627。
- 原任务正在实现 UX-09 文件索引；本任务先做可独立交付的新界面/编辑器/diff 样板和 Git 服务，文件索引与预览后续吸收 main 的已提交改动。
- 已保存完整范围 docs/file-review-workbench.md 与 15 条专项验收 .agents/file-review/features.json。
- 当前项 FR-01。下一步完成独立依赖/基线测试，接入 CodeMirror 6 / @pierre/diffs，真实 Electron 样板验证与截图。
- 全部产品目标仍未完成，当前不修改既有 UX 清单的 passes。

## 2026-09-13 FR-01 完成

- 新增 CodeMirror 编辑器、固定行高虚拟文件树、文件/审查组件、@pierre/diffs 连续 diff 与本地 Worker；浅色按参考图取色，支持局部深色、中英文、分栏与折叠。
- 独立 Electron 构建通过真实输入/快捷键、CRLF、只读、筛选、文件跳转、统一/左右布局、折叠、分栏及离线高亮。缓存键和显示版本分别维护；修复尺寸监听循环及筛选后的布局一致性问题。
- 全量 120 文件 / 1027 用例、typecheck、diff check 通过。既有文件监听断言因 macOS 约 1 秒事件合批而在全量下超时，调整等待上限至 3 秒后通过，未改该生产服务。
- 证据与边界：docs/file-review-fr-01.md；原始结果 docs/file-review-reference/fr-01-result.json；截图在当前任务 visualizations 的 file-review/fr-01 目录。
- 下一项 FR-02，独立 Git 读取；FR-01 的保存/Git 按钮目前由夹具回调验证，真实后端尚未接入。总目标保持 active。
- main 已有 UX-09（2ffc3ac）/UX-10（d18d584）提交；另一任务继续 UX-11。本分支先完成独立 Git 模块，在 FR-06 前吸收文件索引/预览提交。

## 2026-09-13 FR-02 完成

- 独立 GitProcess / GitReader / 补丁解析模块及 shared/git.ts，提供四种真实比较范围、仓库/分支信息和不可变快照；没有改动主界面或原工作区。
- index/working、HEAD/index、指定提交第一父提交、分支 merge-base 语义完成。Git 对象批量读取；支持 worktree、根提交、重命名/二进制、BOM/CRLF、特殊路径、冲突 index 和子模块指针。
- 路径父目录 realpath/O_NOFOLLOW、异步子进程和取消/超时/输出边界；两次核对发现读取竞态后有界重试。未跟踪文本有总量预算，超限和空/二进制分开；行数仍来自 Git。
- 定向 26 用例通过；全量 121 文件 / 1053 用例、typecheck、diff check 通过。详细证据见 docs/file-review-fr-02.md。
- 下一项 FR-03：Git typed IPC、项目隔离和实时订阅，接入 ReviewWorkbench。FR-04/05 的写操作、FR-06 起的生产文件服务、评论/AI 及总验收仍未完成；目标保持 active。

## 2026-09-14 FR-03 完成

- 生产 Git IPC / preload、GitReviewService 与原生监听接入审查标签，四种真实范围、分支/提交选择、全路径筛选、统计、布局/上下文和文件定位可用。非文本/空/冲突/超限元数据独立于源码；历史只读，计划确认与 Agent /undo 保留在聊天。
- 主 frame / 已打开项目授权、每项目查询合并、旧响应隔离、取消中授权与读取、隐藏面板/窗口的订阅及 Worker 释放，监听失效时显式轮询。针对真实布局循环记录 @pierre/diffs 的局部 pnpm 补丁。
- 文件：src/main/git/{git-service,git-watch,git-ipc}、shared/git、preload、App、renderer/workbench 组件/状态及本地化；真实 Electron scripts/git-review-smoke.ts、夹具、22 项定向回归与依赖补丁。
- 验证：全量 125 文件 / 1075 用例（maxWorkers=4）、typecheck、build、diff check 通过；组件及生产 Git Electron smoke 通过，外部刷新 385 / 390 ms，0 网络请求、0 renderer 错误、关闭后 0 订阅/读取。默认并发旧 state.test 刷新超时，单独及限制并发全量均通过，未改其断言。详情 docs/file-review-fr-03.md。
- 下一项 FR-04：批量/文件/hunk 暂存、取消暂存、还原，快照校验、补丁预检与本地恢复点。另一任务仍在原工作区运行；本分支继续隔离，FR-06 前再整合其已提交变化。总目标保持 active。

## 2026-09-14 FR-04 完成

- 新增真实 Git 暂存、取消暂存和还原服务，支持整批/文件/hunk 粒度；私有 index/临时工作树预检，确认时复核 snapshot、HEAD、index、项目授权和原始文件指纹；common-dir 写队列与 `index.lock` 保护避免并发覆盖。
- 已暂存还原同步逆向 index 与工作树，保留非重叠未暂存编辑；重叠补丁、同 hunk 空格变化、锁竞争和后来文件变化明确拒绝。文件事务保留原始字节、BOM/CRLF、权限、符号链接，失败回滚；本地恢复点可跨 renderer reload/服务实例恢复，和 Agent `/undo` 独立。
- 文件：`src/main/git/git-mutations.ts`、`git-recovery.ts`、`git-worktree-files.ts`、`src/renderer/workbench/git-mutation-actions.tsx`，以及 Git IPC/preload/shared、审查面板、diff viewer、i18n、样式、生产烟测和第三方 diff 补丁。
- 验证：定向 22 项；全量 **126 文件 / 1098 用例通过**（`--maxWorkers=4`）；`pnpm typecheck`、`pnpm build` 通过。生产 Electron Git 烟测 13 阶段通过，外部刷新 **342 / 307 ms**，0 网络请求、0 renderer 错误，关闭后项目/订阅/读取均为 0。结果见 `docs/file-review-fr-04.md` 与 `docs/file-review-reference/fr-04-result.json`；Windows 尚未实机验证。
- 下一项 FR-05：提交与推送闭环。总目标保持 active，原工作区及其运行任务未修改。

## 2026-09-14 FR-05 完成

- 新增 `GitCommitService`、提交 IPC/preload 契约、共享 Git 写队列和工作台提交/推送对话框。真实暂存路径、增删统计、提交信息、分支/远端目标在确认前展示；支持仅提交、仅推送、提交并推送，无上游时选择远端和分支。
- 提交和推送复用 snapshot、项目授权、HEAD/分支/上游/index 版本校验以及 AbortSignal；实际推送 URL 以私有摘要复核。规范化目标分支后明确推送 `HEAD:refs/heads/<branch>`，保留旧同名本地分支。子目录提交拒绝项目外暂存内容。
- 排队/执行期间均可取消，准备期间关闭会清理迟到 token；取消 post-commit hook 后仍展示已生成的本地提交。hook、身份、鉴权、拒绝推送和部分成功结构化展示；远端 URL 及错误详情去除凭据。
- 定向提交/IPC/store **3 文件 / 30 回归**通过；生产 Electron Git 烟测 **23 个阶段**通过，包含本地裸仓库提交推送、不同名称目标分支、hook 拒绝、非快进拒绝、取消、子目录范围保护、reload/关闭清理；refresh **305 / 311 ms**，0 网络请求、0 renderer 错误，关闭后项目/订阅/读取为 0。另通过文件组件 5 阶段 Electron 烟测。详情及截图见 `docs/file-review-fr-05.md` 和 `docs/file-review-reference/fr-05-result.json`。
- 最终全量 **127 文件 / 1121 用例**（`--maxWorkers=1`）、typecheck、build、diff check 均通过。构建与全量测试必须顺序执行，避免清理正在使用的 RPC 产物；此前 macOS 文件通知用例在并行负载下抖动，未放宽断言，最终单进程通过。Windows hook/凭据/权限和大规模性能仍由 FR-15 验收；总目标保持 active。
- 下一项 FR-06：吸收生产文件索引和读取服务，原工作区及其运行任务未修改。

## 2026-09-14 FR-06 开始

- 在独立工作树吸收 UX-09/10：原提交 `2ffc3ac` / `d18d584`，本分支 `1eebeda` / `ee1a0d5`。进度文档冲突保留两套记录，退出清理合并文件监听与 Git IPC，未修改原工作区。
- 正在补完整文件 API：目录/搜索分页、版本读写、路径订阅、项目绑定预览。FR-06 尚未验收，passes 保持 false；本轮不开始 FR-07。

## 2026-09-14 FR-06 完成

- 生产 `DesktopApi.files`、主 frame IPC、目录稳定分页/缓存、共享完整路径检索、UTF-8 文档版本读取/原子保存及项目路径订阅完成。正常文件树和 `@` 保持共享索引；隐藏/忽略目录可显式浏览与检索，页游标变化会报过期。
- 文档区分空/缺失/二进制/非法编码/截断，4 MiB 完整编辑与超限字节分块只读。保存保留 BOM/CRLF/mode，并在 rename 前复核版本、权限、路径授权和 owner；并发同版本写入只有一个成功。补齐非法 UTF-8 前导字节回归和退出等待在途读/订阅初始化的资源核对。
- 旧预览读取、HTML 文件面板/抽屉和 BrowserAutomation 统一项目绑定 URL，未知/旧 workspace host 禁止回退活动项目。两个同名 HTML 的相对图片、fetch 资源与 localStorage 在 Electron 保持项目隔离；主 frame 导航、进程退出和销毁释放路径订阅，原生失败有明确 polling 状态。
- 文件：`src/main/files/*`、`src/shared/files.ts`、main/index、atomic-file、workspace-file-index、preload、共享 preview、BrowserAutomation/preview-target 和两个旧 HTML 预览入口；新 `scripts/file-service-smoke.ts` 与运行器。两个既有 Vite 烟测夹具对齐生产 ES Worker 配置，修复默认 IIFE 无法构建 diff worker 的夹具错误。
- 验证：最终 **134 文件 / 1145 用例**（`pnpm test --reporter=dot --maxWorkers=1`）、typecheck、build、diff check 通过。新文件服务定向 **14 回归**通过；`pnpm test:file-service` 4 阶段、`pnpm test:file-review` 5 阶段、`pnpm test:git-review` 23 阶段、实际 BrowserPanel 本地预览/live reload、UX 文件索引与预览 Electron 回归通过。文件服务更新 **133.5 ms**，订阅/根 watcher/在途读取计数均为 0，网络与 renderer 错误为 0；Git 外部刷新 355/316 ms，旧文本预览 245.8 ms。证据与边界见 `docs/file-review-fr-06.md`、`docs/file-review-reference/fr-06-result.json`。
- 既有 UX App 夹具仍打印未注册的 Git subscribe/unsubscribe，文件读/列表失败为主动注入；该夹具用于文件索引/预览验收，Git 由独立生产 IPC 烟测覆盖。构建与全量测试顺序执行；Windows 和整体性能仍待 FR-15。原工作区 main/b1f3d97 未修改、切换或重置。
- 下一项 FR-07：生产文件树与统一标签；本轮未开始 FR-07，专项完成 **6/15**，完整复刻目标保持 active。
## 2026-09-14 FR-07 开始

- 接续独立工作树中的 FR-07 改动：统一项目/路径文档，按项目/会话持久化标签及阅读位置，接入生产文件树和聊天/审查的文件入口。
- 正在完成预览替换、固定、排序、关闭其他文件及滚动恢复验收。FR-07 passes 保持 false；编辑保存属于下一项 FR-08。

## 2026-09-14 FR-07 完成

- 生产 `ProjectFilePanel` / `ProjectFileTree` 接入共享项目+路径文档和完整索引；Markdown、工具过程、变更摘要、Git 审查及文件树统一打开工作台标签，展开外层抽屉，移除 App 的旧 FileDrawer 挂载。真实冒号文件名和 Markdown 行/列引用分别处理。
- 项目/会话独立保存标签、预览/固定状态、顺序、树筛选/展开/宽度和滚动/选区。原生双击固定、菜单、指针拖动与键盘排序、关闭其他文件、方向键搜索定位可用；隐藏会话保留显示版本，激活时应用共享磁盘更新，精确恢复阅读位置。
- 修复 CodeMirror 整段替换后的测量/滚动补偿和隐藏文档更新写入零位置；原生验收保持精确像素/选区断言。对齐既有工作台转录/报告与草稿 fillToken 夹具，文件索引监听用例先观察真实通知；另修复 backdrop-filter 下极窄 Composer 菜单坐标，边界断言未放宽。
- 验证：最终 **137 文件 / 1157 用例**（`pnpm test --reporter=dot --maxWorkers=1`）、typecheck、build、diff check 通过。新共享文档/状态/标签定向 **4 文件 / 41 用例**、生产文件工作台 **7 阶段**、文件组件 **5 阶段**、生产 Git **23 阶段**、完整工作台/消息列表、真实 App 文件索引与文档、BrowserPanel/live reload/resize 回归通过。工作台刷新 **43.0 ms**、App 文档刷新 **175.6 ms**；工作台网络/renderer 错误为 0，关窗后文件及 Git 资源计数为 0。详见 `docs/file-review-fr-07.md` 和 `docs/file-review-reference/fr-07-result.json`，中英文最终截图已保存并检查。
- 本阶段生产文档只读；下一项 **FR-08：编辑、保存、版本冲突和未保存内容保护**。专项 **7/15**，完整目标保持 active。原工作区及另一运行任务未修改、切换或重置，既有 UX passes 未改。
