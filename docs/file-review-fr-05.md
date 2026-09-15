# FR-05：Git 提交与推送闭环

2026-09-14，独立工作树 `codex/file-review-workbench`。本阶段把 FR-04 的真实暂存区接到提交与推送流程，提交和推送仍与其他 Git 写操作共享同一仓库队列。

## 操作语义

- 提交对话框读取当前真实暂存内容，展示文件路径、增删统计、当前分支、上游、远端和目标分支；提交信息在确认前预览。
- 打开仓库子目录时，暂存区若包含项目外改动，提交会明确要求先打开仓库根目录，防止把预览中未展示的内容一并提交；暂存内容全部位于项目内时仍可正常提交。
- 支持仅提交、仅推送、提交并推送。没有暂存内容时可直接处理推送；没有上游时要求用户选择已配置的远端和经过 Git 校验的目标分支。
- 准备阶段绑定当前订阅快照，确认阶段再次核对项目授权、HEAD、当前分支、上游、index 字节版本和比较内容；推送目标的实际 URL 以私有摘要复核，历史比较保持只读。
- 提交使用 Git 原生 hook、身份和 index 语义；推送使用非交互 Git 子进程。hook 拒绝、身份缺失、鉴权失败、远端拒绝、其他推送错误、过期快照和取消均返回结构化结果与详情。
- 提交成功而推送失败时，结果保留本地提交记录并明确提示部分成功。排队和执行期间均可取消；页面关闭后不会继续准备或执行操作，迟到的确认 token 会被取消。Git 已更新 HEAD 后取消 post-commit hook 也会保留并展示本地提交结果。
- 确认对话框执行中可取消，AbortSignal 会终止 Git 子进程；成功结果关闭对话框并在工作台显示状态。
- 远端 URL 及错误详情在传给渲染层前去除 URL 用户名和密码；推送测试只使用本地临时裸仓库，不访问网络。
- 提交表单、确认信息和目标控件使用工作台局部样式；窄面板工具栏将文字命令缩为带提示的图标，必要时换行，420px 英文窗口中的提交控件仍可点击且不溢出。

## 实现边界

主进程 `GitCommitService` 只接受订阅绑定的 snapshotId、提交信息和远端/分支目标。渲染层不提交路径、补丁或 index 内容。IPC 校验绝对项目绑定、快照摘要、动作枚举、目标远端和分支字符边界；同一 `commonDir` 的提交、推送、暂存和还原操作由共享 `GitWriteQueue` 串行化。

提交通过 `git commit --file=-` 将用户信息写入 stdin，随后读取真实 HEAD；推送使用 `git push --porcelain -- <remote> HEAD:refs/heads/<branch>`，需要设置上游时追加 `--set-upstream`。目标分支保存经过验证和去除首尾空白后的值；目标同名的旧本地分支不会被推送或修改。错误分类保留脱敏后的 Git stderr 作为详情，渲染层用中英文文案显示可行动的原因。

## 验证

新增 `src/main/git/git-commit.test.ts` 的 22 项回归，覆盖真实暂存摘要、身份/远端/上游、仅提交并保留未暂存编辑、提交并推送、不同名称目标分支与旧同名本地分支、分支规范化、无暂存/无上游、身份缺失、hook 拒绝、非快进拒绝、排队/执行取消、准备期间关闭、提交后取消、确认期间切换分支和修改远端地址、子目录提交范围保护与正常提交。鉴权与连接错误使用拦截 push 的 GitProcess 子类验证分类和凭据脱敏，绝不发起网络请求。`git-ipc.test.ts` 增加提交请求和目标边界校验，store 的既有订阅测试补全 GitApi mock，真实提交穿线由生产 Electron 烟测验证；定向检查共 3 文件 / 30 用例。

生产 Electron 烟测使用真实 preload、IPC、React 工作台和临时本地仓库，23 个阶段全部通过：

- 暂存摘要与路径、提交信息预览、仅提交；
- 无上游时选择 `origin/main` 并完成提交并推送；
- 已有上游的仅推送；
- 推送当前 HEAD 到不同名称的远端分支，保留旧同名本地分支；
- hook 拒绝且不创建提交；
- 非快进推送拒绝并保留本地提交；
- 执行中的提交取消且 index 未被写入；
- 准备期间关闭后取消迟到的确认 token；
- 取消 post-commit hook 时已生成的本地提交可见；
- 打开项目子目录时，实际对话框阻止提交项目外暂存内容；
- reload/关闭资源释放、浅色/深色与中英文界面。

最终烟测结果：`refreshMs` **305 / 311 ms**，网络请求 **0**，renderer 错误 **0**，关闭后 projects/subscriptions/reads 均为 **0**。归档结果见 `docs/file-review-reference/fr-05-result.json`；完整临时产物：`/var/folders/qp/05fwrn6x61n2qt8cr8bh3m9w0000gn/T/tacode-git-review-artifacts-XA3JOi`。共享布局修改另通过 `pnpm test:file-review` 的 5 阶段 Electron 组件烟测。

截图：[中文提交确认](file-review-reference/fr-05-commit-preview-zh.png)、[420px 深色英文提交表单](file-review-reference/fr-05-commit-narrow-dark-en.png)。

最终全量 `pnpm test --reporter=dot --maxWorkers=1`（**127 文件 / 1121 用例**）、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。8MB 二进制恢复夹具在并行负载下约 25.8 秒完成，测试上限调整为 120 秒以避免资源竞争误报，不改变生产行为。构建会清理 `dist-electron`，因此必须和依赖 RPC 构建产物的全量测试顺序执行；一次并发运行出现 8 项 RPC 产物缺失及 1 项文件通知抖动，随后 4 worker 顺序全量只剩文件通知抖动，最终单进程全量通过，未修改这些生产模块或放宽断言。验证环境为 macOS Darwin 25.6.0 / Apple M5 / Electron 37.10.3 / Chromium 138 / Node 22.21.1；Windows 的 Git hook、凭据和文件权限仍由 FR-15 实机验收。

下一项 FR-06：吸收生产文件索引和读取服务。提交/推送专项完成不代表整个复刻目标完成，总目标继续保持 active。
