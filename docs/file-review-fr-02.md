# FR-02：独立 Git 读取服务验收

2026-09-13，独立工作树 `codex/file-review-workbench`。

## 接口与语义

- `src/shared/git.ts`：项目/仓库信息、四种比较范围、不可变快照、文件两侧状态、hunk、分支和错误类型。
- `src/main/git/git-process.ts`：异步 Git 子进程，参数数组，禁用 shell；清理继承的 Git 仓库/index 重定向，关闭 optional locks、外部 diff、textconv 和 fsmonitor 命令；支持取消、超时和输出上限。
- `src/main/git/git-diff.ts`：NUL 分隔的 raw/numstat 与补丁解析，支持空格、中文、tab、换行文件名；依据 Git 原始 hunk 重建完整新文本，保留 BOM 和末行换行状态。
- `src/main/git/git-reader.ts`：`inspect()`、`branches()`、`read(comparison)`。显式项目路径，识别独立 worktree 的 gitdir/index 和共享对象目录；子目录项目只返回其范围内的文件。

未暂存比较 index → working tree，并包含未跟踪文件；已暂存比较 HEAD → index。指定提交比较第一父提交 → 该提交，根提交从空树开始；相对分支比较 merge-base → HEAD，排除当前 index/工作区变化。

冲突文件读取真实 index 1/2/3 阶段；未暂存展示 ours → 工作文件并标记冲突，已暂存侧明确为 conflict，不把当前磁盘内容冒充已暂存结果。嵌套仓库/子模块以 commit 指针呈现，不遍历其文件。

历史两侧来自批量读取的 Git blob；实时新文本来自 Git 补丁和冻结的旧 blob，因此 CRLF/clean 转换后的 Git 结果保持一致。读取完成后再次核对补丁、HEAD、index 和未跟踪列表；变化时最多重试一次，持续变化返回具体错误。工作文件同时保存原始磁盘指纹供后续写入校验。

## 内容与资源边界

文本单文件上限默认 8 MiB；子进程单次输出和批量 blob 读取有 64 MiB 上限，未跟踪文本按路径顺序分配剩余预算。超限内容用 `tooLarge` 独立状态返回，保留文件条目和真实 Git 行数；空文本始终是空字符串。非 UTF-8、NUL 数据以及 Git 属性/驱动指定的二进制均独立表示，不用替换字符污染可编辑内容。

工作区文件读取使用 realpath 验证父目录、O_NOFOLLOW（平台支持时）、读取前后文件身份检查；符号链接只读取链接文字。读取器没有 Electron 依赖、全局活动 cwd、监听器或仓库写入操作。

## 验证

`src/main/git/git-reader.test.ts` 共 **26 项**，使用真实临时仓库和真实 Git：

- 同文件部分暂存，index/working 与 HEAD/index 分离，读取前后 index 字节不变。
- 新增、空文件、点目录、忽略规则、中文/空格/tab/换行/路径通配字符；生成的新增补丁通过 `git apply --cached --check`。
- 删除、重命名、二进制、可执行权限；未初始化 HEAD、根提交、合并第一父提交、分支 merge-base、worktree 和子目录边界。
- BOM/CRLF/末行无换行；非 UTF-8；不执行 external diff/textconv/fsmonitor；继承 Git 环境重定向不会串仓库。
- index lock 下可读；SHA-256 对象库；符号链接越界拒绝；冲突阶段、嵌套仓库；取消与输出上限。
- 读取中发生修改会重新捕获，持续变化有界失败；未跟踪路径变化会改变快照身份；总文本预算不丢文件条目；20 万行未变化前缀不会触发参数栈溢出。

全量结果：**121 个测试文件 / 1053 个用例通过**，`pnpm typecheck`、`git diff --check` 通过。日志位于 `/tmp/tacode-file-review-fr-02-tests.log` 和 `/tmp/tacode-file-review-fr-02-full-tests.log`。本阶段验证环境为 macOS；Windows 实机与规模性能仍在 FR-15 验收。

下一项 FR-03：typed IPC、按项目的订阅/版本保护，以及真实审查界面的实时刷新。暂存、还原和提交尚未实现。
