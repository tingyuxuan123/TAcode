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
