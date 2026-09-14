# FR-06：完整文件服务

本阶段在 `codex/file-review-workbench` 独立工作树完成文件服务，不修改原工作区。吸收 UX-09/10 的已提交索引与预览改动：原提交 `2ffc3ac` / `d18d584`，本分支 `1eebeda` / `ee1a0d5`。

## 生产行为

- `DesktopApi.files` 经生产 preload 与主 frame IPC 提供目录分页、完整路径搜索、文档读取/保存、项目预览 URL 和路径订阅。请求必须包含绝对 `projectRoot` 与项目相对 `path`；错误为独立结构化结果。
- 默认页 200 条，最多 500 条；目录缓存至多 64 项，并发扫描合并，按真实目录身份与纳秒 mtime/ctime 核对。游标绑定项目、路径、查询、忽略选项和清单摘要，清单变化时返回 `staleCursor`，不会静默跳过或拼接两个版本。
- 正常工作区搜索与旧文件面板、`@` 复用 `WorkspaceFileIndex`；全部路径参与匹配，不受 UI 展示页数限制。显式隐藏/忽略目录可直接浏览、搜索；根目录可用 `includeIgnored` 展示。显式忽略子树搜索按需重新扫描，以免原有 watcher 对生成目录的过滤产生过期结果。
- UTF-8 文档区分 `text` / `empty` / `missing` / `binary` / `truncated`；正文不包含提示。元数据有大小、读取字节、BOM、换行、权限、编码、可写状态和字节分页位置。非法 UTF-8 单独标记 `encoding: invalid` 并只读。
- 完整编辑上限 4 MiB。超限文件只读分块，读取不会切断末尾 UTF-8 字符；`nextOffset` 可继续读取。读取前后核对文件身份、时间、大小、权限及项目真实路径，持续变化返回可重试错误。完整文件版本同时包含字节摘要，超限版本仅使用文件元数据。
- 保存要求 `expectedVersion`，同真实路径写入排队。同目录临时文件、同步和原子替换复用 `writeFileAtomic`；发布前重新核对版本、权限、项目授权和 owner 生命周期。保留 UTF-8 BOM、CRLF 和 mode；失效版本、截断文件、非法文本及只读文件拒绝写入。符号链接允许安全范围内读取，但编辑只读。
- 路径订阅携带项目、路径、订阅 ID、递增序号。项目根原生 watcher 在路径消费者间共享；周期指纹核对补偿目录删除/重建和遗漏，原生监听失败会明确返回/发送 polling 状态。无消费者时停止 watcher、合批 timer 和轮询；主 frame 导航、进程退出与销毁释放 owner。
- 旧预览读取、文件抽屉、HTML 标签和 BrowserAutomation 使用同一项目 URL 绑定。每项目 `workspace-<32 hex>` origin 保持相对资源与存储隔离；`workspace`、未知 host、越界链接和未授权根返回错误，不回退到活动 cwd。

## 验证

- 临时实盘回归覆盖 205/8105 文件、目录后页与后部路径、分页失效、隐藏/生成目录、空/缺失/二进制/非法编码、UTF-8 尾部块、BOM/CRLF/可执行权限、同大小外部修改、并发保存、发布前外部变化、导航取消、越界链接和 watcher 回收。
- 最终 `pnpm test --reporter=dot --maxWorkers=1` **134 文件 / 1145 用例**、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；新文件服务定向 14 回归通过。构建和全量测试顺序运行，不清理正在使用的 RPC 构建产物。
- `pnpm test:file-service` 通过生产 Electron、preload、IPC 和预览协议。两个项目同名 HTML 的相对图片、fetch 资源和 localStorage 分别属于自己的 origin，子页面没有 workbench API；外部修改通知 **133.5 ms**，reload/关窗并等待后订阅、watcher 和在途读取为 0，网络请求与 renderer 错误为 0。最终测量见 `docs/file-review-reference/fr-06-result.json`。
- `pnpm test:file-review` 5 阶段、`pnpm test:git-review` 23 阶段、`TACODE_SMOKE_ONLY=smoke node scripts/test-browser.mjs`、`TACODE_FILES_SMOKE=1 node scripts/test-session-activity.mjs` 与 `TACODE_PREVIEW_SMOKE=1 node scripts/test-session-activity.mjs` 通过；Git 外部刷新 355/316 ms，旧文本预览 245.8 ms。已查看文件/审查组件截图，生产统一文件树/标签仍属下一阶段。
- 首次 Electron 夹具的 `data:` 页面无法完成本地预览，改为与生产一致的文件页面；测试脚本返回监听解除函数导致 structured clone 失败，改为返回普通值。Electron profile 清理改到子进程退出后，避免 Session Storage 写入与清理竞态。这些失败均未放宽业务断言。
- 两个既有 Vite 夹具默认 IIFE Worker 无法构建现在的 diff worker，已对齐生产 `worker.format: es`。既有 UX App 夹具仍打印未注册的 Git subscribe/unsubscribe；其文件读取/列表失败是主动注入。文件服务和 Git 另有完整生产 IPC 烟测，不把该简化夹具的输出称为零主进程错误。

## 后续边界

- FR-06 交付生产服务和既有预览项目绑定；新文件树与统一标签属于 FR-07，新编辑/未保存流程属于 FR-08，多格式界面属于 FR-10。本阶段不宣称完整复刻完成。
- 文档保存用于已存在的普通文件；文件/目录创建、重命名和移入废纸篓留给 FR-09。混合换行保留原文本；不推断任意非 UTF-8 编码。
- 应用内同路径保存不会互相覆盖；任意外部程序在最后校验和操作系统 rename 之间的极短窗口仍可能写入，跨平台原子替换不提供文件级 compare-and-swap。读取竞态、版本冲突和预先存在的越界链接有实盘证据，不把它称作对恶意并发文件系统操作的完整隔离。
- Windows 实机、2 万文件性能和隐藏面板整体暂停/恢复由 FR-15 验收；本阶段的计时仅适用于临时本地 APFS 项目。
