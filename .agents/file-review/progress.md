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

## 2026-09-14 FR-08 开始

- 在独立工作树接入共享编辑状态、真实版本保存和应用恢复目录。关闭标签/切项目/退出采用保存、放弃、取消；外部更新和保存期间的新输入不得覆盖未保存文字。
- 验收范围包括 BOM/CRLF/权限、查找替换/撤销重做/定位/换行、保存失败/冲突、重启恢复和真实 Electron 生命周期。FR-08 passes 保持 false，本轮不开始 FR-09。

## 2026-09-14 FR-08 完成

- 生产 CodeMirror 接入共享文档编辑、版本校验和原子保存，保留 BOM/CRLF/mode；真实查找替换、定位、撤销重做、换行和保存可用。外部变化保留本地草稿，比较捕获的磁盘版本并拒绝过期覆盖；修复保存期间新输入及撤销到旧基线、外部 CRLF 转 LF 的竞态。
- 新增 `src/main/files/file-drafts.ts`、`src/main/window-close-guard.ts`、`src/renderer/workbench/file-editing.tsx` 及回归，扩展 shared/preload/生产 App、共享文档、标签和文件面板。恢复记录按项目/路径隔离且原子持久化；关闭单个/其他文件、切项目、重载、关窗及退出支持保存/放弃/取消，正常离开可保留并等待备份，完整独立进程重启恢复准确文字。
- 最终全量 **139 文件 / 1170 用例**（`pnpm test --reporter=dot --maxWorkers=1`）、typecheck、build、最终 renderer 构建及 diff check 通过；恢复/关窗/文档定向 **18 用例**通过。新增 `test:file-editing` 两个独立 Electron 进程 **12 阶段**、`test:file-editing-app` 完整未替换生产 main/preload/App **3 阶段**通过，均自然退出码 0，恢复文字与磁盘隔离由父进程核对。
- 文件工作台 **7 阶段**、文件组件 **5 阶段**、生产 Git **23 阶段**、BrowserPanel/live reload/resize、完整工作台/消息列表、真实 App 文档及深层/201/8000+ 文件检索回归通过。工作台刷新 **129.8 ms**、App 文档 **167.4 ms**、Git **334/335 ms**；专项网络/renderer 错误和关窗后文件/Git 资源为 0。证据见 `docs/file-review-fr-08.md` 和 `docs/file-review-reference/fr-08-*.json`，中英文窄窗冲突、生产退出及重启恢复截图已检查。
- 正常离开等待备份；强制结束或断电仍可能丢失尚未进入 200 ms 合批的最后输入，无自动三方合并。Windows、整体性能与分支整合留待 FR-15；既有 FR-07 证据和 UX 清单保持原样。
- 专项 **8/15**；下一条仅 **FR-09：文件管理与外部打开**，本轮未开始。提交仍在 `.worktrees/file-review-workbench` / `codex/file-review-workbench` 隔离分支，未合并；原工作区及另一运行任务未修改、切换、重置或停止，完整目标保持 active。

## 2026-09-14 FR-09 开始

- 继续在隔离工作树实施文件/目录新建、重命名、原生废纸篓、相对/绝对路径复制、文件管理器定位和已安装编辑器打开；原工作区不修改。
- 结构操作与保存共享写队列，复核项目、路径、owner 和确认时的版本，拒绝覆盖已有目标；重命名/删除先处理受影响的未保存文档，并同步跨会话标签与持久阅读状态。FR-09 passes 保持 false，下一项 FR-10 尚未开始。

## 2026-09-14 FR-09 完成

- 新增生产 `FileManagement` / `FileExternal`、typed IPC/preload 和文件操作菜单。真实空文件/目录创建、重命名/移动、系统废纸篓、路径复制、文件管理器定位和已安装 VS Code/Cursor 打开及行列定位可用；“打开”菜单只包含应用和定位命令。
- 保存与结构操作共用串行队列；确认版本覆盖目录后代，复核路径/项目/owner/权限并拒绝已有目标。管理链接本身且拒绝通过项目外链接写入，保护 Git 元数据别名、Unicode/平台名称；真实 APFS 大小写重命名保留字节。取消/并发写入清理自身占位，失败保留源与目标。
- 未保存文件先保存/放弃/取消，保存改变版本后二次确认，跨会话子树锁防止新编辑；关闭和重载等待在途结构/外部操作。成功迁移所有会话标签、活动文件和持久精确阅读/展开状态，迟到清理写入转向新路径；废纸篓移除标签、另一个项目隔离，损坏存储键不阻断后续迁移。
- 最终全量 **141 文件 / 1190 用例**（96.61s，`--maxWorkers=1`）、typecheck、build、diff check 通过；新原生 `test:file-management` **10 阶段**自然退出码 0，包含菜单/IPC/生产 service 的实际系统 Trash。唯一临时文件恢复并清理；外部测试 CLI 核对准确参数，用户编辑器未启动。专项网络/renderer 错误和关闭后文件/Git 资源为 0；最终中英文截图已检查。
- 完整生产 App **3 阶段**、两个独立编辑/恢复进程 **12 阶段**、文件工作台 **7 阶段**、文件组件 **5 阶段**、生产 Git **23 阶段**，以及 BrowserPanel/live reload/resize、完整工作台/消息列表、App 文档与深层/201/8000+ 文件检索回归全部通过。工作台刷新 **170.5ms**、App 文档 **168.8ms**、Git **327/333ms**；编辑运行器支持独立报告路径，既有 FR-07/08 证据未覆盖。
- 详情、原始报告和截图见 `docs/file-review-fr-09.md`、`docs/file-review-reference/fr-09-*.json`。测试的系统打开/定位为参数适配器，Windows 实际执行和分支整合仍待 FR-15；不实现跨卷复制移动。本轮仅 FR-09，专项 **9/15**，下一条 **FR-10：多格式预览与大文件**，尚未开始；完整目标保持 active。
- 提交仍在独立工作树 `.worktrees/file-review-workbench` / `codex/file-review-workbench`，未合并；原工作区及另一运行任务未修改、切换、重置或停止，既有 UX 清单未改。

## 2026-09-14 FR-10 开始

- 在隔离工作树补多格式预览、版本绑定的超限分块只读和持久阅读状态；HTML 快照绑定独立项目预览域，预览未保存文字不写磁盘。
- 本轮仅 FR-10，验收前 passes 保持 false；FR-11 尚未开始，原工作区不修改。

## 2026-09-14 FR-10 完成

- Markdown/HTML 源码与预览切换、相对图片/链接、图片与 SVG 预览（签名识别、缩放/适应窗口）、二进制类型大小与显式项目打开、空/缺失/失败/重试/加载/截断状态分别呈现；HTML 快照按项目隔离脚本、相对资源、fetch 和存储，无 Node/工作台桥，未保存文字不落盘。
- 4 MiB 边界完整可编辑并真实保存；超限按 256 KiB 分块只读、可遍历到尾部且无缝隙，生产服务的部分写回被拒。字节区间工具栏支持开头/上一下一段/末尾和字节直达，每个分块独立保存精确滚动与选区，外部版本刷新、renderer reload 和窄窗英文布局都保持当前页。
- 阅读位置与视图状态按项目+会话+路径持久化：源码位置、预览滚动、图片缩放、当前分块和各分块位置互相独立，越界/损坏数据丢弃。新增 HTML 快照注册表（owner/项目绑定、4 MiB+8 KiB 单份、16 份/64 MiB 上限、导航/崩溃/销毁释放）与生产预览协议承载快照。
- 修复本轮发现的真实缺陷：HTML 预览重新激活偶发 15 秒不刷新（修复前 22 次运行失败 4 次，约 18%）。快照时间线证明新快照已创建却没有协议请求，iframe 的 `src` 与活动子 frame 不一致。原因是 effect 依赖整个 document 对象、每次状态变化都改写活动 iframe 的 `src`，在旧文档仍加载时 Chromium 丢弃导航。改为只依赖文档版本、每份快照独立 iframe 元素、替换后才释放旧快照、卸载释放显示中的快照；修复后同一烟测连续 **12 次全部通过**，重复建快照同步减少。
- 最终全量 **142 文件 / 1197 用例**（110.32s，`--maxWorkers=1`）、typecheck、build、diff check 通过。原生 `test:file-formats` **10 阶段**、遍历 **32 个分块**、准确保存 4 MiB，结束后文件/Git 资源与 HTML 快照为 0，网络与 renderer 错误为空（[fr-10-result.json](docs/file-review-reference/fr-10-result.json)）。
- 回归：编辑/重启恢复 **12 阶段**（[fr-10-editing-result.json](docs/file-review-reference/fr-10-editing-result.json)）、完整生产 App 退出 **3 阶段**（恢复文字精确、磁盘未改写）、文件工作台 **7 阶段**（刷新 **162.8 ms**，[fr-10-workbench-result.json](docs/file-review-reference/fr-10-workbench-result.json)）、文件组件 **5 阶段**、生产 Git **23 阶段**（刷新 **324/340 ms**）、BrowserPanel/live reload/resize、真实 App 文档（**127.2 ms**）与深层/201/8000+ 文件检索全部通过；专项网络、renderer 错误和关闭后资源为 0，中英文最终截图已检查。
- 夹具修正：`scripts/fixtures/file-workbench.html` 的 CSP 与生产 `index.html` 对齐（预览 frame、blob 图片、wasm），App 文档烟测的超限文案断言更新为新的分块只读文案（仍断言截断状态出现），未放宽任何行为断言。
- 详情与边界见 `docs/file-review-fr-10.md`。分块只读是设计约束，不实现大文件流式编辑；Windows、性能和分支整合仍待 FR-15；渲染层快照生命周期由原生烟测覆盖，仓库无 DOM 单测环境。
- 专项 **10/15**；下一条仅 **FR-11：最近一轮审查**。提交仍在本工作树隔离分支、未合并；原工作区及另一运行任务未修改、切换、重置或停止，既有 UX 清单未改。

## 2026-09-14 FR-11 完成

- 在真实运行时事件流上建立轮次边界：`agent_start`（用户请求开始）到 `agent_settled`/停止；主进程按 `runtimeId`、会话文件和会话 cwd 驱动，委派子会话与侧聊不参与，不靠工具计数或消息文本推测。
- 每轮开始与结束各用项目私有 index（`GIT_INDEX_FILE` + `git add -A --ignore-errors` + `write-tree`）抓一份工作区树并写入仓库对象库，审查范围 `baseTree..targetTree` 复用既有 Git 读管线（布局、折叠、上下文、高亮、二进制/超限/空文件元数据、文件树），范围只读、无写入口，不碰用户 index/HEAD/refs。
- 覆盖本轮同步命令、已完成异步命令、patch 与未跟踪文件的实际落盘差异；结束时仍在运行的命令在快照上标记命令文本与 `processId`，说明其改动不在快照内。快照生成后其后变化只进实时范围，不重写已记录的一轮；没有记录（旧会话/非仓库）、对象被回收、抓取失败、正在抓取四种状态分别提示，且都不显示任何 diff，绝不用当前内容冒充历史。
- 新增 `TurnSnapshotService`：按项目隔离、抓取串行、在途可等（`idle()`）、失败原因持久化、每项目保留最近 8 份清单并原子写入；范围栏显示快照摘要、未结束命令与覆盖限制，「最近一轮」选项启用。
- 验证：`TACODE_GIT_REVIEW_REPORT=docs/file-review-reference/fr-11-git-result.json pnpm test:git-review` **27 阶段**通过（原 23 + 新 4），外部刷新 **325/335 ms**，样例仓库本轮抓取基线 **16 ms** / 目标 **10 ms**，网络与 renderer 错误 0、关窗后资源 0；新增 `turn-snapshot.test.ts` **8 用例**；最终全量 **143 文件 / 1206 用例**、typecheck、build、diff check 通过，格式烟测 **10 阶段**、文件工作台 **7 阶段**、组件 **5 阶段**、编辑/重启 **12 阶段**、生产 App 退出 **3 阶段**、BrowserPanel 与真实 App 文档（185.1 ms）回归全部通过。
- 详情与边界见 `docs/file-review-fr-11.md`：快照对象为无 ref 的悬空对象，主动回收后报失效；基线与首个写入并发时给出覆盖告警；同一项目两会话并发时各自区间会包含窗口内对方的写入；不覆盖 `.gitignore` 忽略的文件，也不代表提交历史。Windows 与 2 万文件性能仍待 FR-15。
- 专项 **11/15**；下一条仅 **FR-12：行级意见与持久化**，本轮不启动。提交仍在本工作树隔离分支、未合并；原工作区及另一运行任务未修改、切换、重置或停止，既有 UX 清单未改。

## 2026-09-14 FR-12 完成

- diff 行号列上按下拖动或按下后 shift 点击选中单行/多行，选中处展开输入框；`Mod-Enter` 或「添加意见」写入，带 IME 保护。每条意见绑定比较范围、快照、文件版本、路径、侧与行区间，并保留创建时的原始片段；代码变化后在行内卡片和右侧列表都标为「已过期」，不把旧意见画在新代码上。
- 新增右侧「审查意见」列表：勾选/定位/标记解决/重新打开/删除、显示已解决，以及把勾选的意见连同序号、路径、侧、行区间、快照短标识、片段和正文一次性写入当前对话草稿（沿用既有 `onUsePrompt` 通道，用户发送后再进入修复流程，本阶段不自动发送、不写仓库）。
- 意见按项目 + 会话隔离、跨渲染层重载保留；损坏/越界/超长/重复条目丢弃，单次上限 200 条、正文与片段各 4 KiB。注释状态用渲染期按 scope 重置 + 纯函数更新，避免切项目时把上一个 scope 的意见写进新 scope。
- 验证：`TACODE_GIT_REVIEW_REPORT=docs/file-review-reference/fr-12-git-result.json pnpm test:git-review` **32 阶段**通过（原 27 + 新 5），外部刷新 **328/333 ms**，网络与 renderer 错误 0、关窗后资源 0；新增 `review-comments.test.ts` **6 用例**；最终全量 **144 文件 / 1212 用例**、typecheck、build、diff check 通过，文件工作台 **7 阶段**（164.7 ms）、文件组件 **5 阶段**、格式烟测 **10 阶段**、BrowserPanel 与真实 App 文档（183.6 ms）回归全部通过。
- 详情与边界见 `docs/file-review-fr-12.md`：意见只在本机工作台存储，不进仓库/会话文件，不随分支移动；过期基于范围+快照+文件版本，不自动挪行号；行内卡片按钮可能被底部动作条覆盖，需要滚动，同时提供 Mod-Enter。AI 审查、视觉核对与性能/发布验收待 FR-13～15。
- 专项 **12/15**；下一条仅 **FR-13：AI 审查**，本轮不启动。提交仍在本工作树隔离分支、未合并；原工作区及另一运行任务未修改、切换、重置或停止，既有 UX 清单未改。

## 2026-09-14 FR-13 开始（仅摸底，未落代码）

- 接手本轮已完成 FR-10 / FR-11 / FR-12，三项都已提交并带原生证据（`1a2cf2a`、`b3125cf`、`98c9366`）；本次到这里停止，不开始 FR-13 的实现，避免留下未验证的半成品。
- 已确认 FR-13 可直接复用的既有基础：运行时内置角色 `code-reviewer`（`src/runtime/subagents.ts`，`read_file`/`list_files`/`search_files`/`exec_command` + `execPolicy: "readonly"`、`thinkingLevel: "high"`）；子会话委派链路 `src/main/delegation-coordinator.ts` + `src/shared/delegation.ts`（`DELEGATION_COMPLETION_CONTRACT`：空闲后取最后一条带文本的 assistant 消息，不能把工具旁白当报告）；`AgentHost`/`AgentManager` 每会话一个 RPC worker；本轮新增的 `TurnSnapshotService.resolve(snapshotId)` 可作为「冻结范围」的来源，`GitReader` 已支持 `{kind:"turn"}` 只读范围，`ReviewWorkbench` 已具备范围栏、右侧栏与行级锚点（意见卡片的 annotation 机制可直接复用来渲染 AI 发现）。
- FR-13 尚未开始实现，`passes` 保持 false。下一条仍为 **FR-13：AI 审查**。
