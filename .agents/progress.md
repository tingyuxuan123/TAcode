# 模型供应商管理进度

## 2026-09-12：思考行对齐 ZCode——默认收起 / 预览 / 微光 / 纯文本展开 + 工具行调色（08:00-09:50，Asia/Shanghai）

- 起因：用户逐条对照 ZCode（本机 /Applications/ZCode.app，直接解包它的 asar 拿到渲染层组件与样式做参照）迭代会话过程区的观感。共五条反馈，逐条落地：
  1. **思考默认收起**（此前流式中全文展开、结束后裁成 800 字预览）：收起成一行「🧠 思考 · 预览」，点击展开；`expanded[item.id]` 状态与工具行共用。收起态零内容渲染——93k 字符思考在折叠态不再白付那帧 127ms 的整段渲染（CLIPPED_PREVIEW_CHARS 路径连同 ResizeObserver 溢出测量一并删除，i18n 的展开/收起两个 key 移除）。
  2. **预览**：取思考文本最后一个非空行（尾部 600 字符内，>140 字截断），流式时实时跟着「正在想的那句」走；标签 flex:none+nowrap，修复长预览把「思考」两个字挤成竖排的 bug。
  3. **微光动画替代加载圈**：进行中整行文字 shimmer（去掉 LoaderCircle）。第一版用 --ink-2/--ink 两端，用户反馈「浅色主题看不见」——改为 color-mix 朝透明推的端点（亮带=--ink，基色=--ink 30% 透明度），对比度从主题文字色派生，任何主题都有强扫过感；专用 keyframe 每周期完整划过一次。
  4. **展开态 = 纯文本 pre-wrap**（对齐 ZCode ReasoningContent 的 whitespace-pre-wrap：思考是草稿不是正文，代码块就是原始字符，不做 markdown/Shiki）：320px 高度上限 + 块内滚动（隐藏滚动条）+ 上/下 20px 渐隐遮罩（对齐 ZCode 的 scroll-mask，滚动位置实时切换 top/bottom/both/none）+ 流式中贴底自动跟随、上翻即停（ResizeObserver 同时观察容器与内容层）；已结束的思考展开时从顶部读起。废弃的 .flow-thought-text 全套规则与落字光标选择器清理干净。
  5. **工具行调色**：静态预览（plan/preview/tool-rows.html + 真实 styles.css）与 ZCode 截图并排对比——结构/文案本来就逐字一致（`写入 N 行 · 文件名`、`执行 N 条命令 · 命令`），差在标签用了 --ink-2 显得重；调成 --ink-3 统一弱灰（字重 500 保留）。用户随即指出层级又反了：思考展开正文（--ink-2）比工具行（--ink-3）还深——正文与「思考」标签一并统一到 --ink-3，最终层级：回复正文(--ink) > 工具行/思考行/思考内容(--ink-3)。
- 顺带修上一轮遗留的跳转回归：`scrollToAnchor` 校正循环全部改走 virtua 自己的 `scrollToIndex`、只在测量安静 120ms 后间歇补正（最多 8 轮）——直接写 box.scrollTop 会跟 virtua 的待定补偿互相拉锯（带栈追踪实测每帧 0↔226px 互写、297 次不收敛且位置单调漂移，根因是测量补偿按跳转前的旧内部偏移计算）；冒烟断言改为「等收敛后的落点」（跳进未测量区域首次可见时带一次估算误差的回弹，不能当契约）。
- ZCode 参照要点（解包 app.asar 实证，非猜测）：ReasoningContent = `max-h-60(240px) overflow-auto whitespace-pre-wrap text-foreground-subtlest`，default 形态 `ml-2 border-l pl-3.5`；折叠态动画类 `animated-gradient-text`；工具行/思考行同为弱灰层级。Electron 主进程 ESM 入口**顶层 await 会永久挂起**（本次又踩一次，探针脚本必须包 async fn）。
- 验证：`pnpm typecheck` 通过；思考纯文本化前跑过 `pnpm test`（85 文件 775 用例）与 message-list 冒烟（含改后的收敛断言）全绿；之后的微光调色/层级调整是纯 CSS，按用户要求不再跑测试，由用户实测验收。未提交（本次提交一并入库）、未发布、未改 AGENTS.md。

## 2026-09-12：对齐 ZCode 会话效果——逐词淡入 / 落字光标 / 跳转收敛 / 高度缓存（00:00-00:50，Asia/Shanghai）

- 起因：用户「会话展示卡卡的、不够丝滑，想做成 ZCode 那种效果」。前两轮已修 Markdown 子树重建与流式分段，这轮先量化再动手：新增 `scripts/message-list-perf.mjs`（真实 Electron 窗口跑 150 轮生产组件链路，量流式跟随/翻历史/锚点跳转的帧间隔与 scrollTop 逆向写入）；另用合成会话对 App 每帧重算的 9 个收集器做了微基准（150 轮合计 0.38ms/帧）。
- 结论修正：**收集器不是主因**（微基准），生产构建下流式跟随与翻历史本来就满帧（p95≈18ms、逆向 0 次）。真正的三个问题：①流式首帧增长有 155ms 的孤立长帧（每帧全量对账已挂载条目）；②锚点跳进「从未测量过」的区域时落点漂移（实测差 38 条 ≈14k px，锚点根本没挂载）；③观感层缺 ZCode 那种「逐词淡入 + 落字光标」。
- 改动：
  1. `message-list.tsx`：条目套 `MemoItem`（item 引用不变则整棵子树跳过对账）；新增跨会话的已测高度缓存（按 `cacheKey\0条目key`，virtua 挂载时以 `cache` 快照注入，defaultSize 用已测高度中位数）；`scrollToAnchor` 校正循环重写——目标未挂载时**等安静 150ms 再补一次 `scrollToIndex`（最多 8 轮）**。关键教训：逐帧去抢会跟 virtua 的测量补偿拉锯（实测 0↔226px 每帧互写、297 次不收敛且位置单调漂移），必须让它自己消化测量、间歇校正。
  2. `App.tsx`：`listItems` 按组缓存（流式帧只重建末条；signature 覆盖 running/awaiting/stopping/recovered/streak/showRetry），全命中时保持数组引用稳定；`collectTodos`/`collectProgressTasks` 复用已算好的 `sessionTools`（原来内部各扫 1-2 遍）。
  3. `codeblock.tsx`：高亮 token 按行稳定化——追加式更新下文本未变的行复用上一份 token 数组（非追加式编辑全量取新），ShikiLines 的 memo 由此生效，流式中不再每 80ms 全量重建整块 span。
  4. `ui.tsx` + `execution-flow.tsx` + `styles.css`：启用 Streamdown 自带逐词淡入（`animated` + `isAnimating`——**只传 animated 不生效**，插件挂链要 isAnimating 为真；keyframes 由宿主 CSS 提供，`fill-mode: both` 接错线会导致新文字不可见，已用生产构建验证 `animationName: sd-fadeIn` 且文字可见）；流式文本容器加 `.live`，落字光标用 `p:last-child::after` 伪元素（Streamdown 自带 caret 依赖 Tailwind，本仓库没有）；工具行状态图标切换加淡入；重内容展开（思考全文/更早步骤）改 `useTransition` 延迟渲染 + 按钮降透明度示意；`:root { interpolate-size: allow-keywords }` 让过程区收起的 height auto↔0 过渡真正生效；以上动画全部有 prefers-reduced-motion 降级。
- 量化对比（同 fixture 同驱动，生产构建）：流式最差帧 **155.1ms → 35.8ms**（>20ms 帧 4→3~4，p50/p95 持平 16.7/18）；滚动 p95 17.8→17.7 持平满帧；锚点跳转落点误差 **~14k px（差 38 条）→ 200px**，重开会话（高度缓存生效）后 **28px**；跳转校正拉锯写入 297→有界（≤8 轮间歇校正）。冒烟回归（窗口化/跳转/底部留白/跟随）通过。
- 已知边界：①`MemoItem` 缓存靠 groupConversation 的前缀复用，中途插入消息（undo/重试）会整体重建一轮，属预期；②高度缓存在页面整刷（reload）后失效（模块级 Map 在渲染进程内存里），只覆盖会话切换；③探针的「重开跳转」其实是 reload，测不到高度缓存收益，28px 那格来自 virtua 自身测量收敛——缓存收益要在真实「切走再切回」里才可见；④stream-live-text 夹具的自动开播在 StrictMode 下被 started ref 挡掉（既有问题），验证时手动调 `__streamPerf.start()`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 85 文件 775 用例通过；`TACODE_SMOKE_ONLY=message-list pnpm test:browser` 冒烟通过；探针 A/B 数字见上。逐词淡入/光标需真实流式确认观感（待用户发消息后用 `profile-dev-app.mjs --watch` 收尾）。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：修「会话运行中很卡」——流式渲染每帧重建 Markdown 子树（11:00-11:25，Asia/Shanghai）

- 起因：用户贴活动监视器截图——`Electron Helper (Renderer)` 101% CPU、常驻内存 ~975MB，父进程是 TACode，说「会话运行中很卡」。
- 量化先行：新增真实渲染探针 `scripts/stream-perf.mjs`（+ `scripts/stream-perf-main.mjs`、`scripts/fixtures/stream-perf.{html,tsx}`）。用生产组件 `AssistantTurn` → `ExecutionFlow` → `useStreamText` → `Markdown` → `CodeBlock` 复现流式，采帧率/长任务/DOM 增删/代码块重建次数/落字延迟，主进程侧采 `app.getAppMetrics().cpu.cumulativeCPUUsage` 对齐活动监视器口径，并用 CDP `Profiler` 抓真实 CPU profile 做自耗时归因。用法：`node scripts/stream-perf.mjs reply,reply-code,thinking,long,huge <label> [turns]`（场景内容由 fixture 生成，五次重复同源文本，前后可直接对比）。基线用 HEAD 的临时 worktree 跑同一套探针（fixture 与驱动是 untracked，复制过去即可），保证 A/B 内容完全一致。
- 基线复现（生产 React 构建，用户日常 dev 下 StrictMode 还会再翻倍）：12.2k 字符长回复 `122% CPU`、流式 38.9s（16ms/块应约 19.5s，说明主线程已饱和）、51.4fps；7.5k 字符 81%；7.3k 字符带代码块 102%。与截图 101% 同一量级。
- 根因（profile + DOM 计数双向取证）：`ui.tsx` 的 `Markdown` 把 `components` 对象写在渲染函数里，`pre/code/table/th/td` 都是内联箭头函数。`hast-util-to-jsx-runtime` 直接拿 `components[tagName]` 当元素类型，于是**每帧都是新类型** → React 判定「换了类型」→ 卸载并重建整棵 Markdown 子树。866→756 次/733 帧的 `code-block-wrapper` 增删即为此（代码块连同 shiki 高亮状态每帧重挂）。附带两个放大器：`Markdown` 每帧重跑 `repairMarkdownTables`/`compactFencedCode` 等预处理；`CodeBlock` 的 80ms 节流只挡 `setState`，**分词在判断节流之前**，等于每帧跑一次 oniguruma 全量高亮。
- 改动（三处，均为最小改动）：① `ui.tsx`：`components`、`remarkPlugins`/`rehypePlugins` 提到模块级常量（类型引用稳定），并把预处理与 `ReactMarkdown` 元素按 `source` memo（文本不变时元素引用不变，父组件因其他状态重渲染时整棵子树直接 bail out）。② `codeblock.tsx`：先判 80ms 节流再分词，新增 `latestRef` 让延迟补算拿最新代码（原实现用的是调度那次渲染捕获的旧文本，会停在旧高亮）。③ `stream-text.ts`：新增 `streamEmitInterval(chars)` 分档（≤1.2k 不节流 / 24 / 48 / 80 / 120ms），动画器冷却帧只比一次时间、不分词不落字；`emit(value, at)` 用 rAF 时间戳计时，避免与注入时钟混用时间基。把「Markdown 解析次数」从 60Hz 解耦到与文本长度相称的量级，长文本不再随长度线性压满单核。
- 复测（同一 fixture、同一文本，baseline = HEAD worktree / fixed = 工作区）：`reply` 7500 字符 81%→30%、`reply-code` 7330 字符 102%→29%（代码块重建 782→1）、`thinking` 5481 字符 70%→31%、`long`（40 轮历史）65%→22%、`huge` 12217 字符 **122%→19%**（流式 38.9s→20.8s，DOM 增删 21591/21201→530/97）。各档 CPU 占比从此随长度发散变成基本持平。
- 已知剩余：`long` 换 200 轮历史时固定开销 22%→33%，即每帧仍有与历史轮数成正比的 React 遍历成本（探针只量渲染层，真实 App 每帧还重算 `groups`/`recoverableStreaks`，比探针更重）。用户侧暂未报长会话卡顿，未处理，需要时再做窗口化/切片渲染。
- 验证：`pnpm typecheck` 通过；`pnpm test` 74 文件 655 用例通过（`stream-text.test.ts` 新增节流与分档 4 条）；探针 5 场景各跑两遍取第二轮。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：清掉全部 tether 命名（标识符 / 对外身份 / 注释 / 文档）（10:26-11:00，Asia/Shanghai）

- 起因：上一条（10:13）改完数据目录后我列了「有意保留的 tether」，用户回「这个不要了」。追问边界后确认：持久化标识符只写新名、接受旧数据不兼容；对外身份一起改（官网换成仓库地址）；历史记录只把路径改现状、叙述中性化、不动结论与日期。
- 标识符（只写新名，无回退）：localStorage `tether.theme` / `.typography` / `.effort` / `.sidebarCollapsed` / `.inspectWidth` / `.browserHomepage` → `tacode.*`；会话 JSONL 的 `customType` `tether-checkpoint` / `-undone` / `-plan-state` / `-permission` → `tacode-*`；子进程 IPC `tether:browser:request|response|cancel` → `tacode:*`；拖拽 MIME `text/tether-path` → `text/tacode-path`；状态槽 `setStatus("tether")` → `"tacode"`；guest preload 的 `tetherPasswordBridge` → `tacodePasswordBridge`；`dataset.tetherFilled` → `dataset.tacodeFilled`。
- 兼容面明确移除：`tacodeEnv()` 不再读 `TETHER_*` 别名；`TETHER_DESKTOP_PROVIDER_CONFIG/KEY`、`TETHER_WRITABLE_ROOTS`、脚本用的 `TETHER_WORKBENCH_FIXTURE` / `TETHER_COMPOSER_ONLY` / `TETHER_BROWSER_ARTIFACTS` 一并改 `TACODE_*`；用户级 skill 根不再扫 `~/.tether/skills`；工作区忽略/跳过集合去掉 `.tether`；迁移标记改 `~/.tacode/.migrated.json`。钥匙串服务名 `tether-agent-core` → `tacode-agent-core`，历史钥匙串凭据需重输（桌面壳固定 file 存储，实际影响面小）。
- 对外身份：`update-check` 的 releases API、`ui.tsx` 的官网按钮与反馈链接、`release.yml` 的 checkout 名与 Feedback、README 徽章与克隆地址，统一到 `github.com/tingyuxuan123/TAcode`；关于页官网改成仓库地址（原 tether-code.xyz 无新域名可指）。
- skill：`.agents/skills/tether-ui` → `tacode-ui`（`.cursor/skills` 同步改名），SKILL.md / tokens.md 里的产品名与 `tether-ai` / `tether-site` 引用改为「本仓库」「营销站仓库（不在本仓库内）」。
- AGENTS.md（用户授权）：第 3 行「Agent 循环、沙箱、会话在 npm 包 `tether-agent-core`」已过时（已自持 `src/runtime`、直接依赖 Pi），改为自持运行时的描述并在「地图」补一行 `src/runtime/index.ts`；用户全局 skill 路径与 skill 路径同步。
- 注释：`Tether 时代` / `Tether Runtime` / `Tether 的` 共 7 处改成「改名前的版本 / 自持实现 / 旧运行时」等中性表述；`docs/DEVELOPMENT*.md` 的 checkpoint 约定、userData 迁移说明、扫描根一并同步。
- 历史记录：两份 `docs/subagent-*-2026-09-10.md` 顶部各加一行「成稿于 2026-09-10，路径已按现状更新」；本档旧条目里指向同一物件的路径改现状、产品名改陈述口径，写明「当时仍为 …」的地方保留时间事实；`.pi/plan/tether-使用稳定性加固方案-…md` 改名为 `tacode-…`。
- 未动（不是命名残留）：代码里必须知道旧目录名的地方——`LEGACY_HOME_DIR_NAME = ".tether"` 与 userData 迁移链 `["DSHarness","Tether"]`，它们是迁移来源本身。
- 验证：`pnpm typecheck` 通过；`pnpm test` 74 文件 652 用例通过；全仓 `grep -i tether` 只剩上述迁移来源引用。未提交、未发布。

## 2026-09-11：数据目录改名（~/.tether → ~/.tacode）+ userData 改名（10:13-10:25，Asia/Shanghai）

- 起因：用户指出子代理定义存在 `~/.tether/subagents/*.md`，「这个子代理存的位置不对，我现在不叫 tether 了」。根因是 `getTacodeHome()` 默认仍是 `~/.tether`（home.ts 注释里留的「迁移 `~/.tacode` 未做」一直没做），子代理只是最显眼的一处。
- `src/runtime/home.ts`：默认目录改 `~/.tacode`（`HOME_DIR_NAME` 常量）；新增 `getLegacyTacodeHome()` 与 `migrateLegacyHome(home, legacy)`，在 `initializeTacodeHome()` 里、且仅在 `TACODE_HOME` 未显式设置时执行。用 `fs.cp(..., { force: false, errorOnExist: false })` 合并到新目录并写标记 `~/.tacode/.migrated.json`（记来源路径与时间），旧目录只读保留。有标记即跳过；失败不写标记，下次启动重试；目标里已存在的文件不被旧目录覆盖。
- `src/main/index.ts`：userData 迁移链扩成 `["DSHarness","Tether"] → TACode`（倒序取最近一个还存在的旧目录 `renameSync`），沿用原有改名先例，旧目录不保留；桌面壳改设 `TACODE_CREDENTIALS_STORE`。
- 其余：`local-logger` 默认文件名 `tether.log` → `tacode.log`；i18n 的子代理与 MCP 提示改成 `~/.tacode/...`；README 与 DEVELOPMENT 的数据目录说明同步。（其余 tether 命名见本档上一条。）
- 真实落地时点：10:18 全量测试中 `src/main/agent-host-faults.test.ts` 会真启动 RPC worker 却没隔离数据目录，把开发机 `~/.tether` 误迁了一次（随即删掉）；给该测试加临时 home + `credentialStore: "file"`（对齐 `agent-subagents.test.ts`）后复跑确认不再创建真实目录。10:22 用户重启 `pnpm dev` 后，新构建做了正式迁移：`~/Library/Application Support/Tether` → `TACode`、`~/.tether` → `~/.tacode`（旧目录均保留），并把当时的迁移标记改成现名 `~/.tacode/.migrated.json`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 74 文件 652 用例通过（新增 `src/runtime/home.test.ts`）。未提交、未发布。
- 附注：`~/.tacode` 是测试期间意外生成的副本，已删除；用户退出 TACode 后由新构建重新干净迁移一次。

## 2026-09-11：AI 服务列表卡片排版优化（09:47-10:00，Asia/Shanghai）

- 用户附截图：要求优化 AI 服务列表样式。上一轮（09:42）去掉了卡片上的重复下拉后，剩余问题：①「默认」墨底方角徽章插在 meta 文本中间，位置突兀；②一条旧布局残留 `.provider-row-model { margin-top: 12px }` 把 meta 行往下坠，行距不均、卡片松散；③非默认卡片边界太淡、无 hover 反馈；④ meta 行「N 个模型」「默认模型 xxx」灰字连排无分隔，模型名与中文标签混在一个 mono 片段里截断。
- `src/renderer/provider-dialog.tsx`：信息区拆出 `.provider-row-title`（名称 + 「默认」徽章同 row）；meta 行改为「N 个模型 · 默认模型 <模型名>」，标签用新 i18n key，模型名独立成 `.provider-row-model-value`（mono、自行 ellipsis）。
- `src/shared/i18n.ts`：`settings.rowDefaultModel`（含 {model} 占位）改为 `settings.rowDefaultModelLabel`（中英两处）。
- `src/renderer/styles.css`：卡片 padding 11px 14px、圆角 12px，hover 描边 `--line-strong`（默认卡 hover 保持墨边）；`.provider-row-default` 改全圆胶囊（规范允许徽章全圆）；meta 子项之间用 `+ *::before` 加发丝点分隔；删除 7439 行的 `margin-top: 12px` 残留。
- 验证：静态预览（会话工作台 `plan/preview/provider-list.html` + 同目录 styles.css 副本；proma-file:// 协议下相对路径跳出会失败，需复制 css 到预览目录旁）核对普通/默认/停用三种卡片。`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过；`pnpm build:renderer` 已重建。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：AI 服务卡片去掉重复的下拉 + 收拾版面（09:42-09:47，Asia/Shanghai）

- 用户反馈：AI 服务页显示得有点丑，并问每张卡的「默认模型（选择后设为默认服务）」下拉有什么用，没用就移。
- 结论：确实重复，已移除。它做的事：同时把全局默认服务 + 默认模型设成这张卡（主进程 `provider-store.setDefault(id, model)` 会写 `provider.defaultModelId`、`store.defaultProviderId`、`store.defaultModelId`）。而这三件事都有现成入口——行尾图钉设默认服务；输入框的模型选择器选模型时会调 `providers.setDefault(serviceId, model)`；服务自己的默认模型在「编辑服务 → 服务默认模型」里改。卡片上再放一个下拉既重复又占高度。
- `src/renderer/provider-dialog.tsx`：删掉 `.provider-row-model` 下拉；meta 行改为只读的一行「N 个模型 默认模型 <modelId>」（值 = 默认服务用全局默认模型，其他服务用各自的 `defaultModelId`），鼠标悬停提示改在哪里改。
- 排版打磨：`.provider-row-default`（默认标记）之前写的 `color: var(--accent-bg)` 并不存在，颜色回落到继承值（低对比度，看着脏），改为 `var(--surface)`；`.provider-row-url` 改用等宽小字，与同行的模型名对齐。
- i18n：删掉已无引用的 `settings.defaultServiceModel`，新增 `settings.rowDefaultModel`；`settings.serviceModel` 改成提示文案（指到哪里改）。
- 验证：静态预览（会话工作台 `plan/preview/provider-cards.html`，真实 styles.css）核对浅/深色下的新卡片、默认标记对比度。`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过；`pnpm build:renderer` 已重建。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：规划列表「等待中」换成时钟图标（09:38-09:41，Asia/Shanghai）

- 用户反馈：规划/任务列表里「等待中」的图标不对，不符合含义，要求换一个。
- 原因：`progress-overlay.tsx` 的 `statusGlyph` 对 pending 直接落到兜底分支，用的 `ListTodo`（清单图标）——那是「无活动任务」的图标，与行尾文字「等待中」对不上。
- 改：pending 单独返回 `Clock`（时钟 = 排队/等待），并新增 `.progress-pending { color: var(--ink-3) }` 与行尾状态文字同色（比“已完成/失败”弱一档）；`ListTodo` 保留作无任务时的兜底。
- 验证：静态预览（会话工作台 `plan/preview/plan-list.html`，真实 `.progress-overlay-popover` 结构 + 真实 styles.css，图标为 lucide 1.41 真实节点）核对四种状态：已完成圆圈勾、进行中旋转环、**等待中时钟**、失败告警圆。`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过；`pnpm build:renderer` 已重建。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：修进度胶囊遮挡转写最后几行（09:32-09:36，Asia/Shanghai）

- 用户附截图（「遮挡内容」）：任务进度胶囊浮在写作区底部，盖住了「思考」块最后一行（Analyzing bicycle SVG coordinates）。
- 根因：`.progress-overlay` / `.conversation-latest` 是相对 `.chat` 绝对定位的悬浮层（`bottom: calc(var(--dock-clearance) + 8px)`，即输入区上方 8px），而转写内容 `.messages` 只有 20px 底部内边距——滚到底时最后 ~66px 的内容就落在胶囊背后。
- 修：`App.tsx` 在 `progressTasks.length > 0` 时给 `.messages` 加 `has-progress`；`styles.css` 新增 `.messages.has-progress { padding-bottom: calc(20px + 52px) }`（胶囊 top 在滚动区底边上方约 66px，故留 72px）。无任务时不加内边距，底部不会多出空白。
- 验证：静态预览（会话工作台 `plan/preview/progress-pill.html`，真实 `.chat/.conversation/.messages/.progress-overlay` 结构 + 真实 styles.css）量得：不带 `has-progress` 时最后一行 bottom=426 > 胶囊 top=386（重叠，复现问题）；带上后 bottom=374 < 386，间隙 12px。`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过；`pnpm build:renderer` 已重建。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：修「AI 服务」设置页不能滚动（09:28-09:33，Asia/Shanghai）

- 用户附截图：「ai 服务里面不能滚动」，第三张服务卡片被截断（红框标出列表区）。
- 根因：设置壳 `.settings-body` 是 `overflow: hidden`（保留），滚动必须由各页自己的内层容器提供——vision（`.custom-api-card-list`）、外观（`.theme-page`）、子代理（`.subagent-list`）、skills（`.skills-list`）都有 `overflow-y: auto` + `min-height: 0`，**唯独 AI 服务的 `.provider-list-page` 没有**；它作为 flex 子项 `min-height: auto` 又压不下去，超过壳高就被直接裁掉。卡片变高（每个服务多了「默认模型」下拉）后就踩到了这个旧缺口。
- 修：`.provider-list-page` 加 `flex: 1 1 auto; min-height: 0` 并把底部 padding 改为 0，`.provider-list` 自己成为滚动容器（`overflow-y: auto; min-height: 0; padding-bottom: 4px`）——与子代理页一致，头部（说明 + 添加）留在原位不跟随滚动。
- 同类预防：`.shortcut-list` 与 `.about-body` 同样没有滚动容器（内容超长就会被裁），一并补上 `flex/min-height: 0 + overflow-y: auto`。
- 验证：静态预览（会话工作台 `plan/preview/provider-list.html`，把窗口压到 620px + 7 张卡片）量得 `.provider-list` scrollHeight 977 > clientHeight 486、可滚动，滚后头部 y 坐标不变，`.settings-body` 自身不溢出（无双滚动条）。`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过。产物已重建（`pnpm build:renderer` + `pnpm build:electron`，两者均 09:31）。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：浏览器工具修「tabId 空串就整次失败」+ 工作区 HTML 直接预览（09:13-09:30，Asia/Shanghai）

- 用户贴两张图：TACode 里 Agent 生成了 `pelican-bike.html`、用户追问「这种你不应该打开浏览器给我看效果吗」，随后「打开网页」与「新建浏览器标签」两次调用都报 `参数为空或过长：tabId`（执行异常，50s）。要求参考 `/Users/yfdl/Downloads/PI-Desktop-main` 实现。
- 根因（已从会话文件取证）：模型给可选参数补了空串，实际发出的是 `{"tabId":"","url":"http://127.0.0.1:4173/pelican-bike.html"}`；`validateBrowserParams` 对所有非 `text` 的字符串参数一律 `!value.trim()` 判非法，于是在到达浏览器之前就整体抛错。全库浏览器工具调用只有 3 次，其中 2 次死在这个校验上。
- 参考 PI-Desktop 的两点：①它的 `Browser` 工具是单工具 + `action` 枚举，参数一律 `String(args?.x ?? "")` 容错，不会因为可选参数没值而失败；②它的 work-panel browser 支持直接打开工作区 HTML 文件并 live reload（`resolveLocalFile` + `navigateAndWait`），不必起静态服务器。差别在承载方式：它用主进程 `WebContentsView`（可直接 `file://`），TACode 是渲染进程 `webview`，`file://` 会被拦成 “Not allowed to load local resource”，所以改用仓库既有的 `harness-preview://` 特权协议。
- `src/shared/browser-tools.ts`：新增 `normalizeBrowserParams()`，把空串/空值可选参数按「未提供」丢弃后再校验（`text` 与 select 的 `value` 例外，清空输入框语义保留）；`validateBrowserParams` 必填项改为「缺失或空白」都报错；`browser_navigate`/`browser_new_tab` 新增 `path` 参数（工作区内 HTML 文件），`browser_navigate` 由「必须有 url」改为「url 或 path 二选一」；`BROWSER_GUIDANCE` 增加「刚生成的本地页面用 path 预览，不要再跑 `python -m http.server`」与「默认标签要省略 tabId，别传空串」。
- `src/shared/preview.ts`（新）：`workspacePreviewUrl(相对路径)`；`src/renderer/ui.tsx` 里原本私有的 `previewUrl` 改为复用它（图片预览与页面预览同一协议）。
- `src/main/browser/preview-target.ts`（新）：`resolveWorkspacePreview(input, root, {explicit})` → `{file, url}`。`explicit` 区分「模型明确给的是文件路径」与「url 参数里碰巧像文件」；两道校验（词法拦 `../` 与绝对路径逃逸 + realpath 复查符号链接逃逸），要求工作区内真实存在的文件。
- `src/main/browser/automation.ts`：构造函数新增第二个可选参数 `getWorkspaceRoot`（`index.ts` 传 `() => activeAgentCwd`，与 `servePreview` 的解析根一致）；`perform`/`create`/`navigate` 走新的 `destination()`；`navigate` 带 preview 时用 `fs.watch` 盯预览文件所在目录，250ms 防抖后 `guest.reload()` 并清 ref（对齐 PI-Desktop live reload，最多同时 6 个监听，标签移除/重置会话时关掉）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过（新增 `preview-target.test.ts` 5 条：相对/绝对/file:// 解析、目录与不存在文件、工作区外与符号链接逃逸、无工作区根）；`pnpm test:browser` 的浏览器 smoke 全绿，并在其中新增端到端用例：`browser_navigate {tabId:"", url}`（回归）、`path` 预览（断言 guest URL 是 `harness-preview://`、相对资源 `./app.js` 生效、改文件后自动刷新出新内容、不存在的 path 报「未找到该工作区文件」）。
- 已知问题（与本次改动无关）：`pnpm test:browser` 的 workbench smoke 在「collapsible sidebar」阶段断言失败；已在干净 HEAD（41daea5）的临时 worktree 里复现同样失败，属改动前既有问题，未处理。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-11：子代理的模型/推理强度改成按「AI 服务」来（09:15-09:26，Asia/Shanghai）

- 用户要求：子代理 sheet 里的「模型」与「推理强度」要按他在 AI 服务里加的供应商来（实测其配置：hub / ooioo / subapi 三个自定义服务共 10 个模型，服务 id 都是 UUID/slug 形式）。问了两个选项，用户选：列全部服务 + 让钉选真正支持跨服务；推理强度按所选模型能力过滤。
- 关键差异（本轮修）：之前主进程解析子代理钉选时只按「父会话当前服务」找模型（`payload.serviceId` 直接透传），钉选里写不出服务，用户这种非内置供应商 id 还会被 `SUPPORTED_PROVIDER_IDS` 挡掉。现在钉选的 `provider` 段命中已启用服务时就用该服务解析（凭据/baseUrl 都取它），于是子代理可以跑在与会话不同的服务上（对齐 PI-Desktop 的模型钉选语义）。
- `src/main/providers.ts`：新增 `resolveDesktopServiceId(id)`（命中已启用服务则返回其 id）。
- `src/main/delegation-run-options.ts`：新增纯函数 `delegationProviderTarget({parentProvider, parentServiceId, pinnedServiceId})`：命中服务 → `{provider:"openai", serviceId: 服务 id}`；否则沿用父会话（旧行为）；可单测。
- `src/main/index.ts` 的 `buildStartOptions`：改用该函数；钉了服务时不再把父会话的 `baseUrl` 串过去（baseUrl 由被钉服务提供）。钉选未命中服务时行为与之前完全一致（纯追加，不影响现有定义）。
- `src/renderer/subagent-draft.ts`：新增 `subagentModelOptions(providers)`（按 AI 服务展开，值 = `<serviceId>/<modelId>`，附带该模型的推理档位）、`subagentServiceNames`、`subagentThinkingLevelsFor`、`clampThinkingLevel`；档位按 `serviceRuntimeConfig(provider).models` + `levelsForModel` 算，所以“不支持推理的模型只剩 off”。
- `src/renderer/subagent-settings.tsx`：模型栏由文本框改为按服务分组的 `<select>`（空 = 跟随会话；旧定义里手写的、不在服务列表里的钉选仍会显示为当前选项，不会被静默清掉）；推理强度栏按所选模型支持的档位过滤，换模型时把不支持的档位削到不超过原值的最高档；列表徐标改为显示“服务名/模型 id”（服务 id 是 UUID，直接显示不可读）。
- `src/renderer/ui.tsx`：登录/设置弹窗把 `providers` 传给子代理设置页。`src/shared/i18n.ts`：新增 `subagents.modelInherit` / `subagents.modelEmpty`，更新 model/thinking 提示，删除不再引用的 `subagents.modelPlaceholder`。
- 顺手修复：桥接记录里的 `model` 是纯 modelId 字符串，而渲染层只收 `{providerId, modelId}` 对象，所以委托卡片一直不显示子代理用的模型；`normalizeDelegateTask` 现在两种形状都收。
- 验证：`pnpm typecheck` 通过；`pnpm test` 73 文件 646 用例通过（新增：`delegation-run-options.test.ts` 3 条 provider/service 归位；`subagent-draft.test.ts` 5 条模型选项/档位过滤/收敛；`conversation.test.ts` 1 条纯 modelId 字符串）。另用一次性探针跑用户真实 `providers.json` 对过选项：hub/ooioo/subapi 共 10 个模型，`deepseek-v4-flash` 只剩 off、`glm-5.3-flash` 剩 off/low/medium/high/max、subapi 的 gpt-5.6-* 含 xhigh。视觉预览：会话工作台 `plan/preview/subagent-sheet.html`。未提交、未发布、未改 AGENTS.md。
- 已知边界：进程内委派路径（`runtime/tools/delegate.ts` 的 `modelRegistry.find`，仅在不经桥接时走到）无法解析服务 id 形式的钉选，会报“pin not found”；生产走桥接路径（主进程 coordinator），不受影响。

## 2026-09-11：子代理编辑页改成 PI-Desktop 的表单式 sheet（09:03-09:12，Asia/Shanghai）

- 用户贴两张图：一张是 TACode 现状（裸 markdown 编辑器），一张是 PI-Desktop 的「新建子智能体」sheet（名称 / 何时委派给它 / 可用工具 chips / 模型 / 推理强度 / 轮次上限 / 指令 + 字节计数 + 底部「保存为 markdown 文件」），要求本次也参照。
- 对照实现：`apps/desktop/src/components/settings/SubagentEditorSheet.tsx`（draft 模型 + 校验 + 工具勾选组）、`AgentSubagentsPage.tsx`（保存/重命名路径）、zh-CN i18n 的 `extensions.subagents.*`、`ext.css` 的 ext-sheet/ext-field 系列。
- 新增 `src/renderer/subagent-draft.ts`（纯逻辑，便于单测）：`SubagentDraft` 草稿模型 + `subagentDraftFromInfo` / `subagentDraftToDocument` / `subagentDraftError` / `subagentBodyTemplate` / `subagentBodyBytes` / `emptySubagentDraft`；`description` 保存时收敛成单行（否则写坏 frontmatter），名称保存时走 `normalizeSubagentName`。
- `src/renderer/subagent-settings.tsx`：弹窗从 textarea 改为表单 sheet（头部固定 + 字段区滚动 + 底部操作条）；字段：名称（带 slug 预览）、何时委派给它、可用工具 chips（写工具标红 + 写能力警告）、命令策略（仅勾了 exec_command/write_stdin 时出现，对应 TACode 特有的 `execPolicy: readonly`）、模型 + 推理强度、轮次上限 + 权限模式（对应 TACode 特有的 `permission`）、指令 + KB 计数；逐字段错误提示与 Esc/遮罩关闭。内置行点「编辑」现在用内置定义预填（旧实现是回落到模板，会把 explorer 写成 my-helper），保存即写用户文档覆盖同名内置；改名保存后清理旧文件。
- `src/shared/i18n.ts`：新增 40 条中英词条（字段标签/提示/错误），删除已无引用的 `subagents.editorHint` / `subagents.invalid`。
- `src/renderer/styles.css`：`.subagent-editor`/`.subagent-textarea`/`.subagent-editor-meta` 换为 `.subagent-sheet*` / `.subagent-field*` / `.subagent-tool-opt` / `.subagent-body` 等；工具 chip 规则加 `.subagent-sheet` 前缀，否则被 `.panel label` 的竖排强制覆盖。
- 验证：`pnpm typecheck` 通过；`pnpm test` 72 文件 626 用例通过（新增 `subagent-draft.test.ts` 7 条：逐字段校验、0/超限边界、往返解析含 permission/execPolicy、多行说明收敛、从内置定义回写）。视觉用静态预览核对（会话工作台 `plan/preview/subagent-sheet.html` + 项目 styles.css 副本，受管浏览器截图）：新建（浅色，含写工具→命令策略）与编辑既有项（深色，预填 + 只读命令）两种。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：委托卡改成 PI-Desktop 的子代理拓扑样式（08:53-09:00，Asia/Shanghai）

- 用户贴 PI-Desktop 截图（源码在 /Users/yfdl/Downloads/PI-Desktop-main），要求「把我的也改成这种」：分组卡表头「Subagent 已完成 · N 个 Subagent · 已完成 x/y · 耗时」+ 左侧主 Agent 节点、2px 连线、右侧子代理节点卡（Bot 头像 + 右下状态徽标、role/模型/状态·耗时、任务摘要、步骤数）。
- 对照实现：apps/desktop/src/components/ChatTranscript.tsx（SubagentTopology + variant="topology" 的 ToolRow）、apps/desktop/src/styles/messages.css 的 .subagent-topology 段、apps/desktop/src/lib/subagent-topology.ts（状态/耗时归并）。
- `src/renderer/ui.tsx`：DelegateDetail 从「进度条头 + 节点行」改为拓扑网格（.delegate-topology/.delegate-root/.delegate-connector/.delegate-agents）；DelegateTaskRow 改为节点卡（Bot 头像 + 右下状态徽标、标题行 role/模型/状态·耗时、任务摘要、步骤或实时预览、右上 hover「详情」按钮）；trace 表头对委托行改用新文案 + 「N 个子代理 · 已完成 x/y」，并在有子代理运行时自动展开一次（用户手动收起后不再弹）；新增 delegateHeadLabel，节点卡沿用原有「点卡身开右侧子会话标签 / 详情按钮开抽屉」交互。
- `src/shared/i18n.ts`：新增 delegate.coordinator/coordinating/headRunning/headDone/headIssues/headCount/headRatio/agentsLabel（中英各 8 条），删除已无引用的 delegate.cardLabel。
- `src/renderer/styles.css`：新增整套拓扑样式（含 @container delegate-card ≤520px 的竖向回退、prefers-reduced-motion 关闭脉冲/旋转），删除失效的 .delegate-card-*/.delegate-task-row/.delegate-task-details/.delegate-node-main/.delegate-node-top/.delegate-chevron；颜色全部走现有 token（--surface/--inset/--line-strong/--green/--red/--brand/--shadow-raised），明暗主题均已验。
- 与 PI-Desktop 的有意差异：根节点文案沿用仓库既有称呼「主智能体 / 子代理」（PI 用「主 Agent / Subagent」）；窄容器时连线与主干对齐成同一条竖线（PI 的 connector 在 28px、rail 在 14px，会错开一格）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 71 文件 619 用例全通过（未改 conversation.ts，故既有「委托 0/3」等断言保持不动）。视觉用静态预览验证（会话工作台 plan/preview/index.html + 项目 styles.css 副本，受管浏览器截图）：宽/窄容器、完成/进行中/失败/单委派四类卡片、浅色与深色主题。未提交、未发布、未改 AGENTS.md。

## 2026-09-11：按用户实测结果排查（主进程旧构建）+ 加「旧构建」自查

用户跑了一轮「子代理只读审计」并贴回报告，暴露一个问题：**子代理 A 没有 shell 工具**（它自己说「环境未提供 shell/exec，不是被权限拒绝，而是工具不存在」），因此只读命令白名单没被验证到。

排查（用那次运行的真实落盘数据，不靠猜）：
- 子会话 `delegation-4fb55629….jsonl` 的首条任务写着 `Use only these tools: read_file, list_files, search_files.` —— 这段文案由**主进程**协调器的 `composeChildTask(definition)` 生成；
- 同一个父会话里却有我新加的 `tacode-subagent-catalog` 自定义消息，且目录里写着 `explorer … (tools: read_file, list_files, search_files, exec_command; maxTurns 40)` —— 这段由**新起的 worker** 生成；
- 结论：**父 worker 是新代码、主进程还是旧代码**（进程启动早于 20:44 的重建）。不是白名单失效。

防呆（本轮新增）：
1. `src/main/build-status.ts` + `app:build-status` IPC：主进程比较「自己的启动时间」与「主进程 bundle 的磁盘 mtime」，得出 `restartRequired`；启动时把 `main process started {startedAt, bundleMtime, restartRequired}` 写进本地诊断日志。
2. 渲染层挂载时查一次，`restartRequired` 就弹一次 toast：「检测到本地已重新构建（主进程仍是旧代码）。请完全退出并重启 TACode 后生效。」（中英 i18n 已补）
3. `delegation launching` 日志新增 `tools` 与 `execPolicy` 字段：主进程是旧定义时，日志里立刻能看出来。

验证：`pnpm typecheck` 通过；`pnpm test` 71 文件 619 用例通过（新增 `build-status.test.ts` 3 条）；产物已重建（08:42）。

## 2026-09-11：拍板落地（沙箱信号 / 只读命令白名单 / entries 回收 / 报告骨架）

用户把待决策项交给我拍板，逐项按我判断最优的方案落地：

1. **沙箱放行「对自己后代进程发信号」**（根因修复，影响最大）：`src/runtime/tools/sandbox.ts:76` 原本 `(deny signal)` + `(allow signal (target self))`，子代理里 `pnpm test` 一收尾就 `kill EPERM`，test-runner 角色在沙箱内形同虚设。用 scratch 探针实测三种规则后选**最窄但够用**的一条：新增 `(allow signal (target children))`。实测：`(target self)` 连直接子进程都杀不掉；加 `children` 后能杀自己的子进程**与孙进程**（pnpm → vitest → worker），且无关进程（Electron 主进程/开发服务器）的 `kill`/`pkill` 仍全部被拒；再加 `pgrp` 会连带放行同进程组的无关进程（隔离被破坏），故不采用。规则抽成可测的 `seatbeltRules()`（`sandbox.test.ts` 3 条回归）。端到端：新规则下沙箱内 `node` 杀子进程 `killed true`、**`vitest run` 跑通（1 文件 3 用例，exit 0）**。
2. **只读命令白名单**（explorer 能跑只读命令）：新增 `src/shared/readonly-commands.ts`（`checkReadOnlyCommand` + `READONLY_EXEC_HINT`）：白名单（wc/ls/cat/head/tail/find/rg/grep/sort/uniq/cut/tr/stat/du/df/file/basename/dirname/realpath/diff/tree/git）+ 只读 git 子命令；管道/`&&`/`;` 允许但**每段**都要命中白名单；重定向、命令替换、后台执行、解释器（node/python/sh）、写盘类命令、以及每命令的危险参数（`find -exec/-delete`、`sort -o`、`rg --pre`、`git -c`）一律拒绝，拒绝信息里附可用清单。子代理定义新增 `execPolicy: readonly`（frontmatter 可写、渲染可回写）；内置 explorer 改为 `tools: […, exec_command]` + `execPolicy: readonly`；`CommandToolOptions.readOnly` 在 `exec_command` 入口校验（进程内子代理直接传，桥接子 worker 走 `TACODE_EXEC_POLICY`，由 `delegationRunOptions` → `AgentStartOptions.execPolicy` → `agent-host` 下发）。explorer 的提示词同步为「可以跑只读命令、但不能改文件」那一档（`subagentEditsFiles` 仍为 false）。
3. **`entries` 终态回收 + 按 parent 索引**：原来 `entries` 全仓无删除点、`entriesForParent` 每次 O(n) 扫描。新增 `entriesByParent` 索引（`createEntry` 维护）与 `evictTerminalEntries()`：超过 `MAX_RETAINED_TERMINAL_ENTRIES = 200` 时淘汰最旧的终态条目（保留最近 `TERMINAL_RETENTION_MS = 60s` 内结束的，保护 `delegate_continue`）；淘汰时顺手 `host.stop()`——「终态但 host 仍存活」是生产线上的常态，不处理的话淘汰永远不生效。
4. **报告结构化**：四个内置角色（explorer / code-reviewer / test-runner / fixer）的 prompt 统一要求固定骨架 `## 结论` → `## 证据`（每条 = path:line + 1-3 行原文 + 已核实/推断/未确认）→ `## 未确认`。选**结构化 markdown 而不是 JSON**：报告既要回灌父上下文、也显示在右侧面板里，JSON 会牺牲可读性；固定小节 + 置信标签已足够父代理聚合与抽查。
5. **`.agents/features.json`：决定不补、也不改 AGENTS.md**。理由：它是一份「任务清单」，伪造空清单比缺失更糟；AGENTS.md 描述的约定在采用长任务工作流（`/skill:init-long-run` 生成清单）时才成立，而现有代码对「文件缺失」本来就容错（读失败 → 空列表，不报错不崩溃）。要让本仓库清单可见，应按真实任务生成，而不是塞占位内容。

- 验证：`pnpm typecheck` 通过；`pnpm test` 69 文件 611 用例通过（新增 `runtime/tools/sandbox.test.ts` 3 条、`shared/readonly-commands.test.ts` 3 条、定义 `execPolicy` 解析/渲染 1 条、内置角色策略 2 条、`entries` 回收与索引 2 条）；沙箱端到端探针（沙箱内 vitest 跑通）见上；`dist/` 与 `dist-electron/` 已重建。

## 2026-09-10：学 Proma —— 创建子代理时自动开右侧标签并实时看执行过程

- 参考：Proma 的 `useGlobalAgentListeners.ts:759-777`（收到「子会话已启动」事件 → 父会话在前台就写 `Map<父,子>` + 展开右侧面板 + 激活 `delegation` 标签）、`SidePanel.tsx:1611-1617`（标签内嵌完整 AgentView 看执行过程）、`agent-completion-presence.ts:80-100`（未查看完成徽标）。要点：**不是前端轮询发现，而是创建时推送即打开**；只有一条闸门「父会话必须是当前激活会话」；首次打开抢焦点、标签完成后保留；无开关。
- TACode 落地（对齐到既有架构）：
  1. 新增 `src/renderer/browser/delegation-tabs.ts`（纯函数）：`collectDelegations(messages)` 从当前会话抽出委派子任务（复用 `sessionTools` + `delegateProgress`），`planDelegationTabs()` 决定「开哪些 / 刷哪些」——**只在首次出现且正在执行（pending/running）时自动开标签并抢焦点**；历史已完成委派不弹标签；已开的标签只做实时刷新（`activate:false`，不抢用户正在看的标签）；用户手动关掉后不再自动重开；进程内委派（无子会话文件）不自动开面板。
  2. 新增 `src/renderer/browser/use-delegation-tabs.ts`：`App.tsx` 里 `useDelegationTabs(messages, browserPanels)`；用签名挡掉流式期间每帧的重复派发。TACode 天然满足 Proma 那条闸门——后台会话的事件本来就不会进入当前 `messages`。
  3. `panel-state.ts`：`open-child-session` 支持 `activate:false`（后台刷新不切标签）；`ChildSessionPanelInfo` 增加 `live`，面板表头新增「正在读取 …」实时步骤条；`use-browser-panels.openChildSession(key, info, { activate })`。
  4. 面板内容仍是只读转录 + 运行期 2s 轮询（TACode 子会话事件不回渲染层，所以内容靠轮询、表头状态靠推送）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 67 文件 600 用例通过（新增 `browser/delegation-tabs.test.ts` 8 条：自动开/历史不弹/只刷不抢焦点/关掉不重开/进程内不开/路径归一）；真实 Electron 探针新增 `AUTO-OPEN PROBE PASSED`（模拟委派开始 → 自动开标签并抢焦点、面板显示「正在读取 src/main/index.ts」与「2 个步骤」；切到审查标签后委派完成 → 焦点仍在审查、表头刷新为「已完成 · 7 个步骤」）；`scripts/workbench-smoke.ts` 新增同款阶段。
- 与 Proma 的差异（有意的）：Proma 是「每父会话单槽位、后启动者覆盖」；TACode 每个委派各一个标签（并发子代理可同时看），并在首次出现时抢一次焦点。

## 2026-09-10：按「子代理测试汇总」优化（P0/P1 可发现性与报告可信度 + 3 个真实缺陷）

- 背景：用户拿 AI 跑完子代理后给出汇总（含逐条核对、5 条派发层问题、4 条执行层问题、P0–P3 建议）。我先逐条核实再动手：**报告的并发竞态、`entries` 不回收、`_tmp_shiki_probe.test.ts`、`features.json` 假设、`agent-host.stop()` 未放行等待者均成立**；另外我找到了它没定位的根因——沙箱 profile `src/runtime/tools/sandbox.ts:76` 的 `(deny signal)` + `(allow signal (target self))` 正是子代理里 `pnpm test` 报 `kill EPERM` 的原因（vitest 收尾要杀 worker）。
- 本轮已修（低风险 + 带回归用例）：
  1. **未知角色可纠错**：新增 `unknownSubagentMessage()` / `closestSubagentName()`（`shared/subagents.ts`，编辑距离 ≤2 + 包含匹配），主进程协调器（`delegation-coordinator.ts` 的 `Unknown subagent` 分支）与 runtime 工具（`tools/delegate.ts` 的 unknown 分支）改成共用同一份提示：附「你是不是想找 explorer?」+ 完整可用清单（模型看不到 `~/.tacode/subagents/`，原来只报一句名字）。
  2. **子代理目录注入模型上下文**：新增 `subagentCatalogText()`；`runtime/extension.ts` 在 `before_agent_start`（仅 `childDepth < 1`）注入 `tacode-subagent-catalog` 自定义消息，列出每个角色的 description / tools / maxTurns / thinkingLevel，并提示「要 path:line 证据 + 原文片段」。这样不必改 AGENTS.md 也能让模型知道有哪些角色。
  3. **报告可信度**：explorer / code-reviewer 的内置 prompt 硬性要求每条结论附 1–3 行**原文片段**并标注 `已核实 / 推断 / 未确认`；explorer 明确「没有 shell，读不到的行数/大小必须标未确认」。
  4. **`agent-host.stop()` 放行等待者**（真实泄漏）：原来只 reject pending 请求，`waitForIdle` 的等待者在「worker 已退出再 stop()」的早退分支会永久挂起；现在 stop() 开头统一 `flushStartWaiters(false)` + `flushSettledWaiters()`。
  5. **并发上限加同步占位**：`start()` 的上限检查与 `createEntry` 之间有 await，并发提交能一起通过检查（实测 9 个并发全部放行）；新增 `reservations` 计数同步占位 + try/finally 释放，`start()` 主体抽到 `startReserved()`。
  6. **删掉 `src/renderer/_tmp_shiki_probe.test.ts`**（无断言、`console.log` 噪音，却被 `src/**/*.test.ts` 命中，每次 `pnpm test` 白跑）。
- 新增回归用例：`shared/subagents.test.ts`（纠错提示 / 空目录指引 / 目录文本 3 条）、`main/agent-host-wait.test.ts`（stop() 放行等待者，修复前 5s 超时）、`main/delegation-coordinator.test.ts`（并发占位：修复前 9 个全过、修复后恰好 8 个）、`main/agent-subagents.test.ts`（真实 RPC worker 断言父会话请求里带目录）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 66 文件 592 用例通过；`dist/`（渲染层）与 `dist-electron/` 均已重建。
- 待用户拍板（未动）：沙箱 `(deny signal)` 是否放宽（否则 test-runner 子代理在本沙箱永远跑不了测试）；explorer 只读命令白名单（`wc`/`git log|diff`/`rg -c`）；`entries` 终态淘汰 + 按 parent 索引；`.agents/features.json` 是补文件还是改 AGENTS.md/docs；报告是否改成结构化 JSON。

## 2026-09-10：子代理会话改为右侧面板标签（不再抢占中间主会话区）

- 背景：用户点侧栏里的委派子代理行后，子会话被挂到**中间主会话区**（`App.tsx` 的 `onOpen={() => openSession(child)}` 复用了「打开会话」路径，还会改掉 `activeSession`）。期望与参考实现 Proma 一致：中间主区仍是父会话，右侧工作面板多一个标签展示子代理。Proma 的做法见 `LeftSidebar.tsx:1711-1745` + `SidePanel.tsx:1316-1321`（固定单例 `delegation` 标签 + `Map<父→子>` 决定内容）。
- 主进程：新增 `src/main/session-transcript.ts`（`assertReadableSessionPath` / `parseSessionTranscript` / `readSessionTranscript`）：只允许读会话目录内 `.jsonl`，逐行取 `type:"message"` 条目，文件 >4MB 读尾部、消息 >2000 条保留最后 N 条并标记截断。新增 IPC `sessions:read`（`main/index.ts`）+ preload `sessions.read` + `shared/types.ts` 的 `SessionTranscript` 契约。子会话在 `~/.tacode/sessions/`，不在工作区内，`workspace:read` 的 `resolveInWorkspace` 夹不到，所以需要这条专用只读通道。
- 渲染层：`panel-state.ts` 新增 `ChildSessionPanelTab`（`{id,type:"child-session",path,info}`）与 `open-child-session` reducer 分支（同一 path 复用标签）+ `childSessionPanelLabel`；`use-browser-panels` 暴露 `openChildSession(path, info)`；`workbench-panels.tsx` 加标签文案与内容分支（多实例挂载、非活动 `display:none`）；新增 `child-session-panel.tsx`：头部 `role · 状态 · 耗时 · 步骤数 · tokens`，正文复用 `groupConversation` + `UserTurn`/`AssistantTurn` 渲染**只读转录**，运行中按 2s 轮询、连续 3 次长度不变即停止（桥接缺失/同步抛错降级为错误提示，不炸界面）。
- 入口（用户指定两处）：① 侧栏委派行点击 → 开标签（`openDelegatedSession`）；② 主会话里 delegate 卡片的子代理行点击 → 开标签（经新增 `panel-actions.tsx` 的 `PanelActionsProvider`/`usePanelActions` 透传，避免改动 `renderTool` 深链），行尾新增 ⓘ 按钮保留原「详情抽屉」（活动流 + 最终报告）；侧栏行右键菜单新增「在主会话中打开」作为逃生口。
- 未动：`+` 菜单 / 空态选择器（新类型带不了 sessionPath，且会让「+」从直接开网页变成弹菜单，打断既有 GUI 断言）；独立窗口路径。
- 新增测试：`main/session-transcript.test.ts`（7 条：路径越界/非 jsonl/畸形输入、解析与跳过损坏行、超限截断、真实读文件）；`browser/panel-state.test.ts` 新增 4 条（开标签/去重刷新/多标签关闭回落/标题回落与截断）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 67 文件 585 用例全部通过；真实 Electron 探针（scratch：加载生产 fixture + 真 preload + `sessions:read` 桩）验证「侧栏行 → 标签标题、主会话未被切换、面板角色/头部/转录、卡片 context 入口、同一子会话只开一个标签」全部通过；真实数据探针用 `~/.tacode/sessions/delegation-*.jsonl`（10 个文件）确认解析正常。
- 说明：仓库自带 GUI 冒烟（`pnpm test:browser`）本机仍在**既有**的漂移阶段失败（composer 工具栏弹层 / adaptive width / panel resize，三次不同位置）；已用 stash 在干净树复现同一 composer 失败，确认与本次改动无关，故新增阶段改用上述专用探针验证。
- 未提交、未发布、未改 AGENTS.md。

### 2026-09-10 补充：按用户反馈修正两处展示/入口问题

用户反馈：① 主会话里点子代理卡片弹出的还是抽屉（不是标签页），展示的东西也不对；② 侧栏子会话点开的标签页展示有问题；③ 主会话卡片与侧栏子会话明明是同一个委派，点进去却是两个不同的页面。修正：

1. **面板改全出血（直接原因）**：`PanelTabs` 把 children 塞进 `.inspect-body`（`padding: 4px 10px 24px` + `overflow: auto`），子代理面板之前继承了审查面板的内边距，形成「外层 padding + 内外双滚动」。`WorkbenchPanels` 的 `flush` 现在按「活动标签不是 inspect 即为全出血」判定（网页与子代理同一形态），内边距与滚动全部交给面板自己。
2. **卡片点击一律开标签**：去掉 `DelegateDetail` 主点击里「没有子会话文件就回退抽屉」的分支——没有 `childSessionPath`（进程内委派）时用 `delegation:<id>` 当标签身份，内容用卡片上已有的最终报告 + 活动流渲染；详情抽屉只保留在行尾 ⓘ。这样无论桥接还是进程内，点卡片都只开标签。
3. **内容更可读**：面板顶部单独展示委派任务原文，并从转录里过滤掉运行时注入的超长 prompt（`You are the <role> subagent inside TACode…`）。`ChildSessionPanelInfo` 增加 `task` / `report` / `activity` 字段承载这些内容；`Markdown` 从 `ui.tsx` 导出，报告复用抽屉的 `.delegate-task-output.markdown` 样式。
4. **两个入口统一成同一个标签**（③）：卡片与侧栏本来就是同一个委派——卡片里叫 `task.id`、侧栏里叫 `sourceDelegationId`，值相同。标签身份因此从「子会话文件路径 / `delegation:<id>`」改为**委派 id**（`ChildSessionPanelTab.key`），`sessionPath` 收进 `info`；重复打开时**合并**两边的信息（不再互相覆盖），标签标题优先用委派任务摘要，保证两处点进去是同一个标签、同一份内容（有子会话文件就渲染转录，没有才退回报告/活动）。
4. **标签身份归一（用户追问「两边点进去不一样」）**：先用真实数据核对——卡片 details 里的 `delegationId`（如 `delegation-ce24c804-…`）与子会话文件名、state 库的 `source_delegation_id` 是同一个值；但只要有入口只拿到路径（或都拿不到），两边就会算出不同身份 → 开出两个标签。新增 `delegationPanelKey(id, sessionPath)`：有委派 id 用它，否则用子会话文件名去掉 `.jsonl`（就是委派 id），两边因此必然归一到同一个 key；拿不到任何身份才回退详情抽屉。
- 验证：`pnpm typecheck` 通过；`pnpm test` 67 文件 587 用例通过（新增 `delegationPanelKey` 用例）；真实 Electron 探针扩展为「三个入口 + 全出血 + 注入 prompt 隐藏 + 报告/活动回退 + ⓘ 抽屉仍在 + 卡片与侧栏同委派只出一个标签且内容一致」全部通过；`scripts/workbench-smoke.ts` 里对应的三段断言与探针保持一致。
- 排障记录：本机 `dist/`（渲染层产物）时间戳早于这两轮渲染层修复（17:22 vs 19:40+），说明「跑构建产物」时会看到旧界面（表现为两个入口行为/展示不一致）。已执行 `pnpm build:renderer` 重建；确认运行方式为 `pnpm dev`（源码热更）或重建后完整重启。

## 2026-09-10：子代理 B1 —— `maxTurns` 全链生效，到上限算 truncated

- 背景：A 批之后用户拍定语义「到轮数上限算 `truncated`（保留已产出报告），不算失败」，据此落地 B1。
- 链路：角色定义 `maxTurns` → 新增纯函数 `src/main/delegation-run-options.ts`（`delegationTurnLimit` / `delegationRunOptions`，由 `delegation-options.ts` 改名扩展）→ `AgentStartOptions.maxTurns`（`shared/types.ts`）→ 子 worker 环境变量 `TACODE_MAX_TURNS`（`main/agent-host.ts`）→ runtime `turn_end` 计数到上限 `ctx.abort()` → 协调器按同一上限判定。
- runtime 侧：新增 `src/runtime/turn-limit.ts`（`parseTurnLimit` + `createTurnLimiter`，可单测）；`extension.ts` 在 `before_agent_start` 调用 `startRun()` 重置计数——`delegate_continue` 会复用同一个 worker，进程级计数会让续跑只拿到 `limit - N` 轮（审查发现的中高缺陷）。
- 协调器（`src/main/delegation-coordinator.ts`）：① `collectReport` 里「本次运行新增轮次 ≥ 上限」落 `truncated` 并保留报告，且**先于** 原来的 `no_report → failed` 分支；② 新增轮数看门狗（每 500ms 轮询 `get_messages`），子代理没自己收口时停掉它并落 `truncated`，不再只能等 30 分钟兜底超时；③ 轮次按「本次运行新增」计（`turns - baselineTurns`），避免 `continue` 复用 worker 时立刻撞上限。上限取值 `definition.maxTurns`（非法值回落 `MAX_SUBAGENT_MAX_TURNS`=60 并 Math.min 收敛），与进程内路径同一默认值。
- 新增/调整测试：`main/delegation-run-options.test.ts` 7 条（含 `delegationTurnLimit` 边界）；`runtime/turn-limit.test.ts` 4 条（解析 + 每次运行重置/重复 abort 抑制）；`delegation-coordinator.test.ts` 新增 `describe("delegation turn limit")` 4 条（恰好到上限→truncated 且保留报告、`neverSettle` 时看门狗收口、上限内仍 completed、`continue` 后按新预算判定）；FakeHost 扩展 `assistantTurns` / `neverSettle` / `runtimeId` / `startOptions` 测试开关；把一个既有用例（mid-turn crash）的 `reportDelayMs` 固定为 5s，去掉它与 0ms 假报告定时器的竞速依赖。
- 自审修正（详见文档 8.5）：① runtime 计数改为「每次运行重置」（`before_agent_start` → `startRun()`），修掉续跑只拿 `limit - N` 轮、且被误记 completed 的缺陷；② 基线读取移入 try/catch，读不到就本轮跳过上限（`limit = Infinity` + warn），避免 `continue` 路径未处理拒绝 + 记录卡 `running`；③ `ipc-validation.ts` 的 `validateAgentStartOptions` 补 `maxTurns` 白名单。
- 验证：`pnpm typecheck` 通过；`pnpm test` 66 文件 574 用例全部通过。
- 已知边界：runtime 的 `turn_end` 钩子本身无自动化测试（需真实 worker 跑满上限才可观测），协调器侧同名判定有单测覆盖；看门狗 500ms 轮询意味着实际超限轮次可能略高于上限。
- 未做：B2 委派事件不丢（父 host 缺失时兜底送渲染层 + 修复「父 host 被停后报告进不了父上下文」）；水合缺权限时从子会话恢复真实权限。4 条未复现项保持原状。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-10：子代理委派 A 批修复（核实 + 落地 6 项）

- 背景：用户贴出上一轮「子代理使用问题」清单（P1×2 / P2×3 / P3×2 + 未验证项），要求逐条核实并落地低风险批次。
- 核实（三个只读 explorer 子代理并行 + 父代理复跑测试）得出四处更正：① `agent-subagents.test.ts` **不是回归**——非沙箱环境复跑 `1 passed (3.3s)`，原红灯是 Seatbelt 沙箱禁止 spawn；② `thinkingLevel` 只差一行（桥接 payload 已带，主进程不读）；③ `maxTurns` 比说法更重：pi 打包物无轮数参数，桥接链路**没有任何接收方**，要新开通道；④ P3-1 的「UI 不一致」不成立，真实后果是 test-runner 的 system prompt 被告知 "You may change files"（与自己的 "Never edit files" 打架）+ plan 模式剔除 `exec_command` 导致跑不了测试。另：P2-3 的后果比「UI stale」重——父 host 被停过后，后台子代理报告永远进不了父会话上下文。
- 修复（A 批，对应 `docs/subagent-delegation-round2-2026-09-10.md` 第 6 节）：
  - A1 `src/main/index.ts` 的 `createAgentHost` 补 `host.runtimeId = runtimeId`（委派 host 不走 AgentManager，之前恒为 `""`）；`delegation-coordinator.ts` 新增 `createDelegationHost()` 做同规则兜底 + warn，诊断字段不再为空。
  - A2 新增 `src/main/delegation-options.ts`（`delegationModelOptions`），`buildStartOptions` 透传 `thinkingLevel` → `effort` → `--effort` → `--thinking`；payload 缺字段时回落角色定义（覆盖 `continue()` 重建 payload 丢字段的场景）。
  - A3 报告上限收敛为单一来源：`DELEGATION_MAX_REPORT_CHARS` 由 50 000 改为 12 000，`MAX_SUBAGENT_REPORT_CHARS` 改为再导出；本地回灌、桥接落库、`remoteReportBlock` 同一预算。
  - A4 权限兜底保守化：`effectivePermission` 回退值 `auto` → `plan` 并导出；水合回退（`hydratePersistedEntries`）与 `index.ts` 的 `buildStartOptions` 同步改；父权限缺失/非法时写 warn 日志。
  - A5 常量单一来源：`MAX_SUBAGENT_CONCURRENCY = DELEGATION_MAX_CONCURRENCY`；本地 wait 600s 抽成 `DELEGATION_LOCAL_WAIT_TIMEOUT_SECONDS`，桥接 3600/7200 改用 `DELEGATION_DEFAULT_/MAX_TIMEOUT_SECONDS`（不再硬编码）。
  - A6 拆出 `SUBAGENT_FILE_WRITE_TOOLS` + `subagentEditsFiles()`：`composeSubagentSystemPrompt` 改三分支（可改文件 / 只跑命令不可改文件 / 完全只读），test-runner 不再收到写权限文案；`runtime/subagents.ts` 注释同步。
- 新增回归用例 13 条：`main/delegation-options.test.ts`（4，含值域校验）、`delegation-coordinator.test.ts`（runtimeId 兜底、父权限缺失以 plan 起步、超长报告截断可观测、`effectivePermission` 2）、`shared/subagents.test.ts`（可写性 + 常量来源/数值钉住 2）、`runtime/tools/delegate.test.ts`（提示词分支 2）。
- 自审调整（详见文档第 7 节）：① 水合兜底**不改** `auto`（那是我们自己此前授予的权限，猜成 plan 会让 fixer 续跑被剥光写工具而提示词仍承诺可改文件），改为写 warn 留痕；`effectivePermission`(新委派) 保持 plan。② `delegationModelOptions` 只接受已知档位，畸形值回落。③ `settle` 日志加 `reportCharsRaw`/`reportTruncated`。④ 两条路径的提示词都加「≤1500 字符、结论优先」预算，桥接报告被截断时附子会话路径供模型读回全文。⑤ 常量测试钉住数值而非只断言相等。
- 验证：`pnpm typecheck` 通过；`pnpm test` 65 文件 563 用例全部通过；真实 RPC worker 冒烟（`main/agent-subagents.test.ts`）green。
- 未做（B 批，需语义决策或改动面较大）：B1 `maxTurns` 全链透传（含「到上限算 truncated 不算 failed」）；B2 委派事件不丢（父 host 缺失时兜底送渲染层 + 修复「父 host 被停后报告进不了父上下文」）；水合缺权限时从子会话恢复真实权限。4 条未复现项保持原状。
- 已知测试缺口：`index.ts` 的两处接线（写 `runtimeId`、展开 `delegationModelOptions`）依赖 Electron，删掉仍全绿，只能靠协调器兜底用例与纯函数用例间接覆盖。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：子代理（delegate）P0–P3 全量落地（22:06，Asia/Shanghai）

- 背景：用户看到 PI-Desktop 的「智能体模式 + 子代理卡片」，要求把之前分析的 P0–P3 一次做完再统一测试。
- **P0 运行时**：新增 `src/runtime/tools/delegate.ts`。子代理是 worker 进程内第二个 Pi `Agent`（`@earendil-works/pi-agent-core`），独立 system prompt / 模型 / 思考等级，工具集按定义声明并复用父会话 `ExtensionContext`（同一沙箱、同一审批）。`delegate` 默认阻塞到全部结算，进度用 `onUpdate` 回流渲染层现有卡片；父上下文只拿报告（12k 截断）。
- **P1 定义与设置**：新增 `src/shared/subagents.ts`（定义结构、可分配工具白名单、缺省只读、frontmatter 解析/渲染、上限常量）+ `src/runtime/subagents.ts`（内置 explorer/code-reviewer/test-runner/fixer、`~/.tacode/subagents/*.md` 用户文档按名覆盖、启用状态 `~/.tacode/subagents.json`）；主进程新增 `subagents:list|read|save|remove|set-enabled|reveal` IPC + preload + 设置页「子代理」（`src/renderer/subagent-settings.tsx`，列表/启停/编辑校验/删除/打开目录）。
- **P2 生命周期与卡片**：`delegate` 支持 `background: true`；新增 `delegate_wait` / `delegate_list` / `delegate_stop`；后台结算后按批回灌报告（`sendUserMessage(deliverAs: followUp)`）；渲染层 `delegationStatuses()` 从生命周期工具结果反推委派状态，`delegateProgress(tool, tools)` 回填到卡片与底部「任务规划」，新增生命周期工具行文案与 i18n。
- **P3 隔离与成本**：定义支持 `model` pin（找不到即失败，不静默降级）、`thinkingLevel`、`maxTurns`（超限标 truncated 并保留部分报告）、`permission: plan` 时剔除写类工具；子代理 token 用量汇总回传并在卡片展示；子代理工具调用统一走父会话审批（新增串行化，避免多子代理同时弹确认覆盖渲染层单槽位）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 58 文件 496 测试通过（新增 `shared/subagents.test.ts` 11 项、`runtime/subagents.test.ts` 8 项、`runtime/tools/delegate.test.ts` 10 项、`main/agent-subagents.test.ts` 真实 RPC worker 冒烟 1 项：父模型调用 delegate → 子代理跑出报告 → 父回合继续）；`pnpm build` 通过；`pnpm dev` 启动无报错。
- 已知限制（未做）：子代理事件不落父会话转录（只回报告，设计如此）；项目级子代理定义未支持（仅全局）；子代理行不会出现在会话文件里，重开会话后只剩父会话的工具结果；`permission: inherit` 之外只实现了 plan 限制（未做逐调用权限作用域）；Web 搜索类工具未开放给子代理。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：修复「任务规划」列表重复（20:42，Asia/Shanghai）

- 现象（用户报告）：底部进度浮层展开的「任务规划」里同一份计划重复出现（计数也被抬高，如 3/6）。
- 根因：`collectProgressTasks` 遍历会话里**所有** `update_plan` 工具调用并逐条累积。运行时/模型每推进一步就再调一次 `update_plan`（同一份计划的不同快照），于是 N 次调用就在浮层里出现 N 份计划。已用单测复现：两次 `update_plan`（2 步）得到 4 条。
- 修复：`src/renderer/conversation.ts` 的 `collectProgressTasks` 只取**最后一次有步骤的规划工具**（与 `collectTodos` 的“最新计划”语义一致），delegate 任务聚合不变。
- 验证：`pnpm typecheck` 通过；`pnpm test` 54 文件 465 测试通过（新增 `conversation.test.ts` 回归用例：两次 update_plan 只保留最新一份及其最新状态，已确认修复前失败）；`pnpm build` 通过。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：选择「完全访问」不再二次确认；修复 UI 应答与命令队列互等死锁（20:28，Asia/Shanghai）

- 现象（用户报告）：在权限选择器里选「完全访问」后仍弹一个确认框，点「允许」没有任何反应。期望：选完直接生效。
- 根因（两个叠加）：
  1. `src/runtime/extension.ts` 的 `/permissions full` 在斜杠命令里 `await ctx.ui.confirm("Enable full access?", …)`——选择器里的 full 已经是显式、带风险说明的动作，这次确认是重复的。
  2. `AgentManager.respondToUi` 走的是按 runtime 串行化的命令队列（`enqueue`）。斜杠命令在 `session.prompt` 的 preflight 阶段执行，`prompt` 请求要等命令处理器返回才回响应；而命令处理器又在等 UI 应答——应答被排在同一条队列里，形成互等死锁，所以点「允许」后对话框既关不掉、模式也不切。
- 修复：① 删除 `/permissions full` 里的 `ctx.ui.confirm` 分支（保留 `plan` 的 `permissionBeforePlan` 逻辑）；② `AgentManager.respondToUi` 绕过命令队列直接下发（UI 应答是宿主正在等待的带外回复，写 stdin 与其它请求天然串行）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 54 文件 464 测试通过（新增 `agent-permissions.test.ts`：真实 RPC worker 跑 `/permissions full`，断言无 `confirm` 请求且有 `Permission mode: full` 与 `full · host access` 状态；新增 `agent-lifecycle.test.ts` 用例：同一 runtime 有命令挂起时 UI 应答仍能立即下发，旧实现会超时失败）；`pnpm build` 通过。两个新测试都已在修复前确认会失败。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：消除无活动会话时的 `agent:command` 终端刷错（20:11，Asia/Shanghai）

- 现象（用户贴日志）：启动/切换会话后主进程终端出现成对 `Error occurred in handler for 'agent:command': Error: No active agent session`（栈落在 `agent:command` 的 `throw`）。渲染层本身已 `catch`（abort / set_thinking_level / get_* 等 fire-and-forget），这些行只是 Electron 对每次 `ipcMain.handle` 拒绝的打印。
- 排查：在 preload 临时记录所有 `agent:command` 调用（类型 + 栈）到 `~/.tacode/logs/tacode.log` 并跑 `pnpm dev`。干净启动下渲染层 **0 次** command 调用，说明不是启动路径，而是「宿主已停/正在重启」的竞态窗口里仍有命令发出（最像 `syncAgentThinking` 的 `get_available_thinking_levels` + `get_state` 一对）。
- 修复（哨兵协议）：新增 `src/shared/agent-protocol.ts`（`NO_ACTIVE_SESSION_MESSAGE`、`AGENT_NO_SESSION_KEY`、`agentNoSessionResult` / `isAgentNoSessionResult`）。主进程 `agent:command` 无活动会话时不再 `throw`，改为写一条 `diagnostics.warn("agent", …)` 本地日志并返回哨兵；`AgentManager.command` 的同类拒绝也被 handler 捕获成哨兵。preload 见到哨兵即还原为 `new Error(NO_ACTIVE_SESSION_MESSAGE)`——渲染层 catch 语义完全不变，主进程终端不再刷错误。
- 修复（陈旧会话）：`App.tsx` 新增 `dropAgentSession()`（清 `live`/`agentCwd`/`runtimeIdRef`/`runtimeServiceRef`）；`ensureModelReady` 两条停-重启分支在停止前先置 `live=false`，重启失败时调用它，避免把陈旧 `agentCwd` 留给后续命令；`Login.onSaved` 重启失败同样清理；`removeProject` 仅在确有会话时发 `abort`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 53 文件 462 测试通过（新增 `agent-protocol.test.ts` 3 项，`agent-lifecycle.test.ts` 改用共享消息常量）；`pnpm build` 通过；用一次性 Electron 脚本（真实 `dist-electron/preload/index.cjs` + 假 `agent:command` 处理器返回哨兵）确认 preload 端 `command()` 以 `No active agent session` 拒绝；重跑 `pnpm dev` 启动无该错误行。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：修复每开一个会话就在 macOS Dock 多一个图标（18:15，Asia/Shanghai）

- 现象（用户报告并附截图）：每打开一个会话，Dock 就多一个深色方块图标，图标上是绿色 `exec` 字样，一个会话一个。
- 根因：`src/runtime/rpc-entry.ts` 里的 `process.title = "tacode-runtime"`。worker 是 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 运行的子进程；在 macOS 上给这种子进程设置 `process.title` 会让 LaunchServices 把它注册成前台应用，Dock 就为每个 worker 生成一个图标。图标本身是 macOS 给无 bundle 进程的通用「Unix 可执行文件」图标（深色方块 + 绿色 exec），因此用户看到的是 `exec` 而不是进程标题。
- 复现与验证（GUI Electron 宿主 spawn 子进程 + `lsappinfo list`）：仅设置 `process.title` 的脚本会新增一条 `"exec"`/`"tacode-runtime"` 应用记录；不设置标题的同类脚本不产生任何 Dock 图标；去掉标题后重跑完整 worker，Dock 无新图标。
- 修复：删除该 `process.title` 赋值，并在文件头注释说明原因（ps 里仍可用完整命令行识别 worker）。已重建 `dist-electron/runtime/rpc-entry.js`——worker 文件在每次会话启动时读取，因此新会话立即生效，无需重启应用。
- 验证：`pnpm typecheck` 通过；`pnpm test` 51 文件 456 测试通过。
- 附注：17:43 清理时误把用户当时正在运行的 5 个 `tacode-runtime` worker 当作探针残留 SIGTERM 掉（`~/.tacode/logs/tacode.log` 里 code 143 即此），相关会话已停止，重开即可。

## 2026-09-09：自研 Agent Runtime — 直接依赖 Pi，移除旧运行时包（17:30，Asia/Shanghai）

- 结论先行：RPC/adapter 层不需要自研。实测 Pi 原生 `--mode rpc` 与 TACode 协议完全兼容（请求 `{id,type,...}`、应答 `{id,type:"response",command,success,data|error}`、事件流与 `extension_ui_request` 一致），缺口只在 extension 层。
- 新增 `src/runtime/`：`rpc-entry.ts`（调用 Pi `main()` 并注入扩展；启动前把 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 指向数据目录，避免读写用户全局 `~/.pi/agent`；无凭据时快速失败）、`options.ts`（壳层参数消费 + Pi 参数转发 + `--effort`→`--thinking`）、`home.ts`（会话转录日期分区 + 扁平硬链接）、`providers.ts`、`settings.ts`、`credential-store.ts`（file/keyring/auto，钥匙串服务名沿用旧值以读回历史凭据）、`auth.ts`、`state.ts`（SQLite 索引）、`rpc-client.ts`（`dist-electron/runtime/rpc-entry.js` 定位）、`extension.ts`。
- 工具层 `src/runtime/tools/`：read_file/list_files/search_files/write_file/edit_file、exec_command/write_stdin（ManagedProcessRegistry 后台进程）、apply_patch、update_plan、ask_user、沙箱（macOS Seatbelt，Docker 可选）、checkpoint（写 `tacode-checkpoint` 条目供 `/undo`）；扩展命令 `/plan`、`/permissions`、`/effort`、`/jobs`、`/stop-job`、`/stop-jobs`。
- 主进程接线：`agent-host.ts` 启动自研入口；`providers.ts`/`browser/passwords.ts`/`index.ts` 改用 `../runtime` 导出；`tsup.config.ts` 新增 `runtime/rpc-entry` 入口并移除旧运行时包的 external 配置；新增 `scripts/ensure-runtime.mjs` + `vitest.global-setup.ts` 在测试前按需构建 worker；`package.json` 移除旧运行时包，新增 `@napi-rs/keyring`、`pi-web-access`、`fast-glob`；README 与 DEVELOPMENT 文档同步。
- 验证：`pnpm typecheck` 通过；`pnpm test` 51 文件 456 测试通过（新增 patch/workspace/policy/options 共 24 项）；`pnpm build` 通过；真实 RPC worker 以数据目录完成一次 prompt 往返（当时该目录里的 DeepSeek key 已失效，返回 401 并正常透出，属既有凭据问题）。
- 已知差距（后续）：delegate 子代理、language_diagnostics、MCP 集成、`/checkpoints` 与 `/diff` 命令、personalization/project-trust/hooks/image-input 尚未移植；Windows 无原生沙箱后端时 exec_command 会报错（需 Docker 镜像或 `danger-full-access`）；数据目录当时仍为 `~/.tether`，迁移 `~/.tacode` 未做（2026-09-11 已完成）。
- 未提交、未发布、未改 AGENTS.md。

## 2026-09-09：稳定性加固 阶段 5 — 本地诊断、错误边界与故障回归（13:50，Asia/Shanghai）

- 新增 `src/main/local-logger.ts`：本地 JSONL 诊断日志（默认 `~/.tacode/logs/tacode.log`，单文件 1 MB、保留 3 个历史文件轮转、内存最近 200 条、同路径串行写入、写入失败绝不抛出），写入前用 `redactSecrets` 脱敏、单条 message/details 截断，导出窄接口 `DiagnosticSink` 供 `AgentHost` 依赖（`local-logger.test.ts` 6 项）。
- 主进程接线（`src/main/index.ts`）：启动即创建诊断日志；新增 `app:log-diagnostic` IPC（仅限宿主窗口）；配置损坏恢复提示同时写入日志；`web-contents-created` 统一记录主窗口 / webview guest / 独立浏览器窗口的 `render-process-gone`；`app.whenReady()` 初始化失败时写诊断、`showErrorBox` 给出日志路径并 `app.exit(1)`，不再静默退出。`src/main/agent-host.ts` 记录 worker spawn 错误 / 退出码、RPC 请求超时、无法解析的 JSON、超长行、stdin 错误，并对 `desktopProvider.apiKey` 脱敏。
- 渲染层：新增 `src/renderer/ErrorBoundary.tsx`（`main.tsx` 内包住 `App`，位于 `LocaleProvider` 之下），App 抛错时显示“重新加载界面”按钮与折叠的技术细节，并上报主进程本地日志；纯逻辑抽到 `src/renderer/render-error.ts`（`render-error.test.ts` 4 项）；`src/shared/i18n.ts` 新增 4 个键，`styles.css` 增加对应样式。
- 故障注入测试：新增 `src/main/agent-host-faults.test.ts`（真实 RPC worker 被 SIGKILL → 受控错误 + 日志且不含密钥；未应答请求 45s 超时 → 日志脱敏）与 `src/main/agent-host-diagnostics.test.ts`（畸形 JSON 只诊断一次、超长行丢弃后继续解析、密钥脱敏）。
- 文档：README「Checks」补 `git diff --check` 与稳定性门槛（含 `pnpm test:browser` 的 GUI/偶发说明），「Privacy」补本地诊断日志只写本机、脱敏、不记 prompt 原文。
- 验证：`pnpm typecheck` 通过；`pnpm test` 47 文件 432 测试通过；`pnpm build` 通过；`git diff --check` 干净。`pnpm test:browser` 本机多次运行失败点漂移（三次分别停在 panel resize、adaptive width、composer overflow 等不同入口/断言），且把本次 renderer 改动 stash 后仍失败，判断为 GUI 时序偶发而非本次回归；已在 README 注明需桌面环境并建议复跑确认。
- 待人工验证（需真实桌面环境）：首条 prompt 后强杀进程重启的恢复、renderer 重载后重新打开运行中会话、macOS/Windows 多会话并行与退出无孤儿进程。

## 2026-09-09：稳定性加固 阶段 4 — IPC / 文件 / 网络边界防护（13:40，Asia/Shanghai）

- 新增 `src/main/ipc-validation.ts`（纯函数，无 Electron 依赖，便于单测）：集中定义统一上限（prompt 1 MB、agent 命令 payload 32 MB、restore 500 文件 / 64 MB、workspace:read 4 MB、视觉 4 张 / 单张 10 MB / 合计 24 MB、浏览器标签 100 个 / 截图 20 MB、RPC 单行 8 MB、URL 2048 / Key 8192 字符）与运行时校验（`requireString` / `optionalStringArray` / `assertByteLimit` / `assertPayloadLimit` / `validateAgentStartOptions` / `validatePromptMessage` / `validateConnectionInput` / `redactSecrets` / `base64PayloadBytes`）。
- 主进程接线（`src/main/index.ts`）：`agent:start` 用 `validateAgentStartOptions` 校验 provider/permission/sandbox 枚举与各可选字段；`agent:command` 校验命令类型、payload 上限与 prompt 字节上限（超限在进 worker 前抛错）；`agent:ui-response` 校验 id/应答；`sessions:list|remove|pin|rename`、`workspace:forget|read|open|reveal` 增加字符串/布尔校验；`workspace:read` 改为先 `stat`，超 4 MB 只读前缀（`readFilePrefix`）并附截断提示；`workspace:restore` 预检文件数与总字节；`vision:stage` 校验张数与单张/总量；`vision:save-config` 限制 50 个自定义配置；`auth:list-models` 与 `providers:discover|test-connection`（`src/main/providers.ts`）统一走 `validateConnectionInput` 并校验 apiStyle 属于受支持格式。
- 网络超时：`src/main/update-check.ts` 更新检查加 `AbortSignal.timeout(10s)`，手动检查超时改用 i18n 统一文案而非底层 AbortError 原文；`services:deepseek-balance` 加 15s 超时（模型发现与连接测试此前已有 12s/20s 超时）。
- RPC 与脱敏：`src/main/rpc-lines.ts` 的 `drainUtf8Lines` 支持 `maxLineBytes`，超长完整行与超长未完成缓冲都丢弃并计数（`oversized`）；`src/main/agent-host.ts` 用 8 MB 上限、对无法解析的 JSON 只诊断一次、对启动时下发的 `desktopProvider.apiKey` 在 stderr / 超时 / 退出错误里统一 `redactSecrets` 脱敏。
- 浏览器：`src/main/browser/ipc.ts` 的 tab 快照（还原 / 独立窗口）限制 100 条，`browser:write-image` 截图数据限 20 MB。
- 验证：`pnpm typecheck` 通过；`pnpm test` 43 文件 416 测试全部通过（新增 `ipc-validation.test.ts` 17 项、`rpc-lines.test.ts` 扩 3 项）；`git diff --check` 干净。

## 2026-09-09：稳定性加固 阶段 1–3 — 会话生命周期、浏览器隔离、原子持久化（上午，Asia/Shanghai）

- 阶段 1：新增 `src/main/agent-manager.ts`，为每个 RPC 宿主分配稳定 `runtimeId`，start/stop/command 按句柄路由并对同一 runtime 串行化；`rekey` 消除旧路径别名；事件带 `__runtimeId`/`__seq`，`AgentHost` 增加 500 条事件回放缓冲与 `replaySince`，renderer 重载后可用 `agent:runtimes`/`agent:replay` 重新发现运行中会话并补齐快照缺口（`agent-lifecycle.test.ts`）。
- 阶段 2：`BrowserAutomation` 的 working tab / 操作队列 / 取消范围改为 runtime 级，排队上限 8；owner、guest、独立窗口与 debugger 引用在销毁路径统一清理；下载记录上限 200 条；独立窗口 reload 退避重试；工作区 watcher 有限重试（`automation-concurrency.test.ts`）。
- 阶段 3：新增 `src/main/atomic-file.ts`（同目录临时文件 + 可选 fsync + rename + 同路径串行写队列 + 损坏配置备份为 `.corrupt` 并提示），`loaded-sessions.json`、settings、recent-workspaces、chat-profiles、vision-config、web-search、mcp 等写入改走原子写；受保护首条 prompt 在发给 worker 前落盘、文件名按 canonical 路径生成、打开会话时对账去重；`workspace:restore` 预检全部路径后再写并逐文件返回结果（`atomic-file.test.ts`）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 43 文件 416 测试通过。

## 2026-09-09：修复流式滚动“滚回底部自动恢复跟随”（08:56，Asia/Shanghai）

- 问题（用户报告）：agent 执行中往上回看历史后，就不再自动跟随滚动；希望滚回到底部时自动恢复跟随。
- 根因：`src/renderer/use-follow-scroll.ts` 的 `scroll` 处理里，用户滚回底部虽然把 `following` 置回 `true`、`atBottom` 置 true，但**没有启动贴合动画**（`followLatest`），也没吸附到最底，导致“看似没自动恢复”。
- 改动：在 `scroll` 里检测到“非跟随 → 回到底部（距离 ≤16px 恢复阈值）”时，立即调用 `followLatest()`，把视图吸附到最底并进入后续自动跟随；仅在“从历史回到底部”时触发（避免跟随中重复）。恢复跟随之上的上下行滞回（离开 >32 / 恢复 ≤16）保持不变。
- 验证：`pnpm typecheck` 通过；`use-follow-scroll` 4 测试通过；渲染层 HMR 生效。

## 2026-09-09：修复“删除会话后残留 cwd 名占位，需删两次”（08:53，Asia/Shanghai）

- 问题（用户报告）：创建一个会话，点删除后它还在且变成项目名“TAcode”，需再删一次才消失。
- 根因：`sessions:remove` 清理运行中注册表时用 `sessionIdFromPath(path) === id` 匹配，但磁盘会话的 `id` 是 会话索引库的 DB 主键（非路径 basename）。删除“已落盘且运行中”的会话时匹配失败，`loadedSessions` 条目残留，`mergeLoadedSessions` 继续把它合成回侧边栏（title 退化为 cwd 名“TAcode”，因 `sessionTitlesRef` 已删），所以第一次删除只“改名”不消失，第二次才真正删掉。
- 修复（`src/main/index.ts`）：① `sessions:remove` 用 `store.get(id)` 取该会话真实 `sessionPath`/`storagePath`，综合“真实路径 / basename / cwd”多重匹配，可靠删除 `loadedSessions` 并同步清理 `agentHosts` 对应 host；② 新增 `deletedSessionPaths` 黑名单（本会话内），`mergeLoadedSessions` 跳过已删除路径（双重保险）；③ 重开同路径会话时从黑名单移除（避免误拦）。
- 验证：`pnpm typecheck` 通过；`src/main`+`src/shared` 23 文件 173 测试通过；重启 dev server（主进程改动不热更）。

## 2026-09-09：解除“agent 运行中禁止切换项目”限制（08:41，Asia/Shanghai）

- 问题（用户报告）：切换项目时提示“当前 agent 仍在运行，停止后再切换项目”。
- 根因：`src/renderer/App.tsx` `bindProject` 中旧逻辑 `if (running && agentCwd.current && agentCwd.current !== cwd)` 直接拒绝并 toast；这是“单 worker 单会话”时代的限制——切换项目本就需杀现 worker，故先拦。
- 改动：多会话并行（Phase 3a）下每项目/会话独立 worker，删除该阻止段；切项目不再被挡，旧项目会话切走后继续后台运行（`running` 为真时不执行 `agent.stop()`），切回即可见。保留“运行中切同一项目”直接返回不变。
- 验证：`pnpm typecheck` 通过；`src/renderer` 14 文件 153 测试通过；dev server HMR 已应用无报错。

## 2026-09-08：PLAN Phase 3b — 多会话并发可感知：运行中徽标 + 后台完成提示 + 切回准确运行态（23:42，Asia/Shanghai）

- 目标：在 Phase 3a（多会话并行为基础）之上，让并行执行可被用户感知——侧边栏对所有运行中的会话显示“执行中”徽标；后台会话完成时提示；切回后台会话时运行态准确。
- 渲染层 `src/renderer/App.tsx`：
  - 新增 `runningSessionIdsRef` + `runningSessionIds` 状态 + `markSessionRunning`（按 `__sessionId` 增删），在 `agent_start`/`agent_settled` 更新。
  - 事件处理：后台会话（`__sessionId ≠ 当前视图`）的 `agent_start` 标记运行、`agent_settled` 清除徽标 + 刷新列表 + toast 提示“后台会话完成”；活动会话同样维护徽标。
  - 侧边栏 `SessionRow` 的 `running` 从“仅活动会话”改为 `runningSessionIds.has(session.path)`（所有会话的徽标）。
  - 切回后台运行会话时，`setRunning` 用 `runningSessionIdsRef` 判断（比 isStreaming 启发式准确）。
  - `agent:error` 处理时清除活动会话徽标（覆盖崩溃/停止浮出的错误）。
  - `eventSessionTitle`（从会话列表/种子标题解析）用于后台完成 toast 的标题。
- 共享 `src/shared/i18n.ts`：新增 `toast.backgroundSessionDone`（中/英）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 全量 362/362 通过；dev server HMR 已应用，无报错。
- 边界：仍是一次一个活跃视图（非真分屏）；后台会话实时滚动内容需切过去查看，但运行/完成状态已可见。

## 2026-09-08：PLAN Phase 2 — 应用侧消息即落盘，兜底首轮未落盘 user 消息（23:28，Asia/Shanghai）

- 背景：Phase 3a 后“切走”已不再丢（后台继续跑、assistant 产出时底层 flush）。Phase 2 兜剩余缺口：app 崩溃/退出、用户显式停止一个“首条 assistant 未产出”的会话时，已发送 user 消息可能未落盘。
- 主进程 `src/main/index.ts`：
  - 受保护消息存储：`~/.tacode/protected/<sessionId>.jsonl`；`agent:command("prompt")` 时把 user 消息**即刻落盘**（`appendProtectedUserMessage`，向主机进程写入，不依赖底层）。
  - 打开会话时兜底：`agent:start` 若底层 session 文件**磁盘上不存在**（`fs.existsSync(file)`），把受保护中缺失的 user 消息合并进返回的 `snapshot.messages`（按文本去重），供切回/重启后显示；若文件已在磁盘（有 assistant、已 flush），清空受保护消息。
  - `loadedSessions` 注册表持久化：`~/.tacode/loaded-sessions.json`（启动 `loadLoadedSessions`，set/delete 时 `persistLoadedSessions`），使崩溃后侧边栏仍能恢复“未落盘”会话条目，从而可点击打开找回。
- 验证：`pnpm typecheck` 通过；`pnpm test` 全量 362/362 通过。
- 说明：受保护文件真正只兜“首个 user 消息”（一旦有 assistant，底层即 flush，之后逐条立即写盘）。实际崩溃恢复路径涉及底层对未落盘 session 文件路径的处理，属 best-effort，建议在运行中的 App 手动验证：发首条消息后强杀进程 → 重启 → 侧边栏仍见该会话 → 打开可见已发消息。

## 2026-09-08：PLAN Phase 3a — 多会话并行：切换不杀、后台继续跑（23:16，Asia/Shanghai）

- 目标：开会话 A 后再开会话 B，两者可同时执行；在 A/B 间切换时上一会话不被打断、继续在后台跑，切回后看到完整结果。
- 主进程 `src/main/agent-host.ts`：`AgentHost` 增加 `sessionKey` / `requestedSessionPath`；事件（`emitEvent`）带 `__sessionId`，`emitError` 改为带 sessionKey，供渲染层路由。
- 主进程 `src/main/index.ts`：`agentHost` 单例 → `agentHosts = Map<sessionPath, AgentHost>`；`createAgentHost` / `findAgentHost` / `activeAgentHost` / `stopAllAgentHosts` 辅助；`agent:start` 命中"该会话已有存活 host"时**直接复用（不杀不重开）**，否则每会话新建/重启 host（绝不停止其它会话）；`agent:command`/`agent:stop`/`agent:ui-response` 按当前活动会话路由；窗口关闭/退出回收全部 host。
- 共享类型 `src/shared/types.ts` / `src/preload/index.ts`：`AgentEvent` 增加 `__sessionId`；新增 `AgentErrorPayload`，`onError` 改收带会话信息对象。
- 渲染层 `src/renderer/App.tsx`：`agent:event`/`agent:error` 按活动会话过滤——后台会话（`__sessionId ≠ sessionRef.current`）的事件/错误不套到当前 messages/stats，避免污染；后台会话完成时刷新列表。
- 已知限制（3a 阶段）：① 一次只显示一个活跃视图，无法同时"盯"两条流（Phase 3b 增强）；② 后台会话遇到需要用户确认的检查点（工具授权 / askUserQuestion）会等待，切回才可应答；③ 切回仍在流式的会话时，若末条工具仍在跑，running 指示可能偏保守（消息仍会正常流入）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 全量 362/362 通过。
- 说明：与 Phase 1（列表不丢）共同生效；Phase 2（应用侧消息即落盘）补"首轮未落盘就切走"的内容丢失。

## 2026-09-08：PLAN Phase 1 — 会话列表不再丢“运行中/未落盘”会话（22:58，Asia/Shanghai）

- 依据重写后的 `PLAN.md`（参考 Proma 方案），落地最小可交付 Phase 1：列表不再因磁盘暂缺文件删掉运行中/未落盘的新会话。
- 主进程 `src/main/index.ts`：新增 `loadedSessions` 进程内注册表（应用侧“运行中会话”集合），`agent:start` 创建/打开会话时登记；`sessions:list` 用 `mergeLoadedSessions` 把仍运行、磁盘暂缺文件的新会话合成前置到列表；`sessions:remove` 归档时注销以清除占位。
- 渲染进程 `src/renderer/App.tsx`：新增 `sessionTitlesRef` + `setSessionList`，把首次消息标题缓存并覆写主进程合成的占位（否则切走后只显示 cwd 兜底名）；所有已磁盘列表的调用点改走 `setSessionList`，避免整表替换丢占位。
- 未改任何 npm 依赖（旧运行时包 / pi-coding-agent），纯壳层实现。底层 `_persist` 延迟写盘的“内容丢失”层面（首轮生成中切走/崩溃仍可能空），属 Phase 2（应用侧消息即落盘）范围。
- 验证：`pnpm typecheck` 通过；`pnpm test` 全量 362/362 通过。
- 目录：`PLAN.md.bak-promaref`（原 PLAN 备份）。

## 2026-09-08：复用 codeg-main 思路优化流式滚动（21:04，Asia/Shanghai）

- `src/renderer/stream-scheduler.ts` 增加 256 条流式事件批次上限；达到上限立即 flush，仍保留完整 snapshot 顺序，避免 RAF/后台节流时 pending 无界增长。
- `src/renderer/use-follow-scroll.ts` 提取 `nextScrollTop`，并让 `followLatest` 复用已有 RAF 循环；ResizeObserver 连续回调只更新动态目标，不再每次 cancel/restart 缓动，降低流式追加 Markdown 时的滚动抖动。保留用户主动上滑退出跟随、底部滞回、会话位置和历史锚点保持；新增 viewport resize shield，避免布局变化产生的程序滚动被误判为用户意图。
- 新增 `src/renderer/use-follow-scroll.test.ts`，覆盖动态底部、平滑步进、reduced-motion 和临界距离；scheduler 增加批次边界测试。
- 验证：`pnpm typecheck` 通过；`pnpm test` 全量 357/357 通过；`pnpm build` 通过；`git diff --check` 通过。构建仍有既有 renderer 大 chunk 提示，不影响构建。
- 未引入新依赖，未修改主进程、Agent 协议或 Markdown 渲染器；未提交、发布或重启用户当前 TACode 进程。


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
- README 中英文说明同步；界面沿用 tacode-ui 的纸面/墨色变量。

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
- 五个供应商相关测试文件：43/43 通过；其中四种协议均运行真实 `旧运行时包` RPC 子进程请求本地模拟服务，验证模型、地址、配置、独立认证和生成响应。
- `pnpm test`：178/179 通过；唯一失败为修改前已存在的 `src/renderer/conversation.test.ts:308`，期望 `GLM-4V 识图 · glm-4v-flash · MinerU OCR`，实际 `识图 · glm-4v-flash · MinerU OCR`。未修改或弱化该无关测试。
- `git diff --check`：通过。

### 边界与后续

- 未连接真实云厂商、未使用用户真实密钥，未完成 GUI 人工/视觉验收；不能把模拟协议通过视为每家网关均已验证。
- 原生 PDF 配置、跨模型自动调度不在此次范围，PDF 继续使用现有 OCR 流程。
- 如需继续：先在隔离分支做 GUI 验收（添加两个同厂商服务、重启后保留、切换默认后实际发送）；用户确认后再处理合并。不要重复迁移实现或自动恢复主仓库 stash。
- 无关识图文案失败单独处理，验收条件为原有 conversation 测试通过；来源为本次基线及最终测试。未创建/勾选 features.json 验收项。

## 2026-09-07 12:45 GMT+8：修复自定义服务首次提问启动失败

- 用户现象：首页选择 `deepseek-v4-flash-vision-exp` 后提问，Agent 以 code 1 退出，提示 `OpenAI API is not configured`。
- 已确认根因：桌面服务使用内置 `openai` 槽位；`旧运行时包@0.1.19` 在扩展加载前调用 `ensureFirstRunAuth`，不识别 `TACODE_DESKTOP_PROVIDER_KEY`。原 RPC 测试预设了全局 OpenAI 假密钥，未覆盖无 OpenAI 凭据环境。
- 修改 `src/main/agent-host.ts`：仅对桌面自定义服务的 RPC 子进程设置非秘密启动占位值 `OPENAI_API_KEY=desktop-session-key`；真实请求仍由现有扩展解析服务专属密钥，不修改父进程环境或全局凭据文件，不改变普通 OpenAI 启动逻辑。
- 更新 `src/main/provider-runtime.test.ts`：直接使用实际 `AgentHost.start`；覆盖五种接口格式与无 OpenAI 凭据、冲突凭据、无密钥服务三类环境，并保留普通 OpenAI 无凭据拒绝启动的负向测试。断言实际端点、模型、认证、回复、父进程环境和凭据文件未被修改。
- 修复前新增场景中 8 个重现相同启动错误；修复后定向测试 16/16 通过。
- `pnpm typecheck`、`pnpm build`、`git diff --check` 通过。构建仍有现有大于 500 KB 的 renderer chunk 提示。
- `pnpm test`：190/191 通过；唯一失败仍为修改前已有的 `src/renderer/conversation.test.ts:308` 识图标题断言，未修改该测试或相关逻辑。
- 验证使用真实 RPC 与本地 HTTP 模拟服务，未使用用户真实密钥或请求云端模型，未完成用户真实渠道的 GUI 发问验证。
- 已在当前项目根重新构建；现有开发服务位于 `127.0.0.1:5177`，未停止用户进程。需完整重启 Electron 应用加载新的主进程代码，仅刷新窗口不生效。未提交或发布。

## 2026-09-07 13:13 GMT+8：修复推理等级配置与菜单不一致

- 用户现象：Anthropic 兼容服务的 `deepseek-v4-flash-vision-exp` 勾选 `low/medium/high/max`，聊天菜单仅显示前三档。
- 独立 RPC 探针确认当前扩展能够完整保留显式 `thinkingLevelMap`，core 不会按这个模型名删除 `max`。界面原先缺少启动前的服务能力数据，模型预览优先按名称推断，并忽略元数据中的推理更新；另有 `minimal` 被过滤、`xhigh/max` 被合并的问题。
- `ProviderStatus` 增加不含密钥的模型能力信息；前端优先使用显式能力，设置关闭刷新和模型切换后同步菜单。异步 RPC 同步检查会话、模型及选中等级，旧服务实例不再覆盖新配置的选择。收到运行时推理元数据后重新查询当前状态。
- 推理菜单按 `minimal/low/medium/high/xhigh/max` 保留所有支持项；补齐中英文标签，`xhigh=极高`、`max=最高`，设置展示相同中文标签及原始等级 ID。仅有 off 时正确归一化为 off。
- Anthropic 显式声明 `max/xhigh` 的模型使用 SDK 原生 `compat.forceAdaptiveThinking`，将等级发送为 `output_config.effort`；`minimal` 在该模式映射为 `low`。未显式声明最高档时保持预算模式，设置默认等级与运行时均为 `minimal/low/medium/high`。该策略将显式最高档配置视为支持 adaptive effort 的能力声明，真实网关仍须支持对应协议。
- 新增真实 RPC + 本地 HTTP 请求测试，覆盖截图模型、模型切换、`high/max/xhigh/minimal` 的状态及出站字段、预算模式 token 数和非推理模型；修复前测试复现缺少 adaptive/effort 字段，修复后通过。
- 用隔离 IPC fixture 加载实际 React App 完成浏览器验收：四档菜单包含最高且可选择；取消 max、保存、关闭设置后，菜单立即更新为三档并将已选 max 回退到中。检查了截图。fixture 只在本次会话工作台，无真实凭据或网络请求，测试浏览器已关闭。
- 定向测试 44/44 通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。全量 `pnpm test` 为 199/200，唯一失败仍是修改前已有的 `src/renderer/conversation.test.ts:308` 识图标题断言。构建仍有现有 renderer 大 chunk 提示。
- 保留前轮启动认证修复，未更改用户服务数据、密钥或依赖版本，未进行真实云端验证、提交或发布。已重新构建，需完整重启 Electron 应用以加载主进程中的新能力数据与映射。

## 2026-09-07：供应商分组模型菜单与思考深度滑块

- 按用户参考图实现独立模型选择器：弹层内固定搜索栏、供应商分组、当前项高亮与勾选、滚动、方向键/回车选择、Escape/点击外部关闭。搜索匹配供应商与模型名称；同名模型使用服务 ID 与模型 ID 联合标识。
- auth:status 返回全部启用桌面供应商的无密钥状态。选择器复用 providers.setDefault 保存服务与模型；下一次发送复用 ensureModelReady 重启不同服务的运行时并恢复会话，不中断正在生成的回答。保留旧版单供应商数据回退。
- 思考选择改为模型能力驱动的离散 range 滑块及可点击刻度，保留所有受支持等级，仅在支持时提供 off。非推理模型隐藏入口；不支持原等级时回退到可用推理档位，不意外关闭。
- 用户追加要求入口可辨认当前等级：脑形图标后直接显示等级文字，关闭置灰，悬停/展开时浅色背景；按语言固定按钮宽度，切换档位不挤动邻项。中文低档改为“低”，max 改为“最大”，沿用现有主题变量。
- 新增 lucide-react 用于选择器图标；锁文件仅保留此依赖的增量，撤销安装工具产生的无关解析变动。未覆盖工作期间出现的 provider-dialog.tsx、styles.css、i18n.ts 中其他设置页改动。
- 新增 6 项共享逻辑测试。全量 pnpm test 为 205/206，唯一失败仍为修改前已存在的 conversation.test.ts:308 识图标题断言；类型检查、生产构建与 diff whitespace 检查通过，仍有原有 renderer 大 chunk 提示。
- 工作台 preview/ 下用实际 React App 与隔离 IPC fixture 完成 11 项浏览器断言，并在 760px iframe 内重跑通过：完整档位、等级文字、off 置灰、Escape、同名模型供应商区分、档位回退、搜索空态、首轮启动参数、跨服务下一轮恢复参数、无运行时错误及弹层边界。完成分组菜单及滑块截图检查；后续窄窗口截图工具返回 UnknownVizError，未把该截图记为通过。没有真实云端请求或密钥访问。
- 已重新构建，需要完整重启 Electron 加载主进程多供应商状态。未提交、发布或修改 AGENTS.md。

## 2026-09-07：思考与执行流展示

- 用户批准参考 Proma 的阅读层级与流式节奏，在当前目录新建 `codex/execution-flow` 分支实施。独立使用本仓库现有 React/CSS/lucide 组件实现，没有复制 Proma 源码或修改许可。
- 新增 `execution-flow.tsx`：运行中默认展开、约320px限高过程视口、思考四行预览/全文切换、普通Markdown阶段说明、轻量工具行及按需结果详情；末尾答复独立显示，正常结束且用户未交互时延迟收起。失败、停止、等待确认和缺结果状态保持可发现，审批卡仍在过程外。
- `conversation.ts` 新增展示投影与稳定历史分组引用；按模型消息边界维护work作用域，同一块快照修订替换旧文本，不以内容包含关系合并不同步骤。历史工具缺结果显示中性状态；工具update保留首次开始时间。
- 新增有序帧事件批处理、后台兜底、短文本缓冲与独立滚动跟随；区分用户阅读意图和程序滚动，处理会话重建/观察器绑定，主区与过程区提供回到最新入口。
- 通过独立审查补齐自然完成与停止竞态、同会话新run隔离、首token前停止和宿主错误状态；使用已有stopReason恢复明确的aborted标志，不补造未知历史终止原因。未扩展runtime、RPC、权限或模型协议。
- 新增25项测试均通过。`pnpm test`为230/231，唯一失败仍为原有 `conversation.test.ts:308` 识图标题断言。原阶段说明测试补齐分立模型消息的message_start事件，未弱化内容顺序断言。`pnpm typecheck`、`pnpm build:renderer`和`git diff --check`通过，仍有现有renderer大chunk警告。
- 工作台 `3902fd90-16b8-4ee1-912f-59ee01eccd97/preview/` 用真实App和隔离IPC检查运行/完成、工具详情保持、等待确认、手动回看不跳及切会话无旧文本污染；查看1440/1024/760px及白色/深色/纸面主题截图。400余条历史消息追加80次快照，被监测历史正文DOM未变化，回放无捕获到的运行时异常。详细证据见该会话 `verification.md`。
- 减少动态效果分支已实现但未切换真实OS设置验收；没有真实云端请求、打包安装或发布。保留项目现有 `127.0.0.1:5177` 开发服务，已更新renderer生产构建。未修改主进程、用户服务数据、AGENTS.md或依赖版本，未提交。

## 2026-09-07：主题与字体设置（字体 + 字号）

- 在现有“主题”页新增字体与字号区：两字体选择器（界面与正文 / 代码）、三字号步进框（界面 / 对话 / 代码）、自定义字体名、恢复默认；配色与字体字号同页独立分区，底部预览展示实际效果。
- 新增 `shared/typography.ts` 管理配置校验、localStorage 保存与 CSS 变量：`--sans`/`--mono` 随字体切换；`--ui/--chat/--code-font-scale` 按比例套用，默认均为 1，不改变现有字号层级。启动前在 renderer/main.tsx 恢复。
- 字号用 `calc(<px> * var(--<scale>))` 接入：正文/对话为 chat，代码块、终端、路径为 code，按钮/侧栏等界面元数据为 ui；行内 `code` 保留原文比例。修正 `.markdown pre code` 让内层 code 继承外层字体（原来被浏览器默认 monospace 覆盖，导致代码字体切换看不出效果）。
- 字体可用性用本地 canvas 测量判定；未安装提醒并回退默认；非等宽字体在代码分类被拒绝。代码字体预设含 Menlo / Monaco / Courier New / Consolas / JetBrains Mono（本机未装则置灰标注未安装）。自定义字体留空时提示需填名称。
- 翻译补齐中/英文；`settings.appearance` 改名“主题与字体”。
- 16 项新增 typography 单测通过；类型检查、`pnpm build:renderer`、`git diff --check` 通过。全量 `pnpm test` 仍为 246/247，唯一失败为修改前已存在的 `conversation.test.ts:308` 识图标题断言，未改动该测试。
- 隔离 IPC fixture 加载真实 App 完成浏览器验收：切换代码字体为 Menlo 后代码块计算字体跟随（`code` 由 monospace 变为 Menlo 栈）、代码字号步进即时生效、重载后从 localStorage 恢复（menlo / 13px）、无运行时错误；截图确认三区块布局与窄窗口。未读取真实凭据、未请求云端模型。
- 预览工具对相同 URL 有资源缓存，旧 CSS 在旧标签残留属工具现象；源码与生产构建产物均已确认包含 `font-family: inherit` 修复。未提交、未发布、未改 AGENTS.md。

## 内置浏览器移植（Snow App → 本仓库，2026-09-08）

- 范围确认：Snow 全量浏览器功能；两仓库 MIT。分层：A 核心浏览器 / B 独立窗口 / C 凭据与登录态 / D 调试与代理 / E Agent 浏览器工具。
- Layer A 完成：主窗口 `webviewTag`，`src/main/browser/{popups,downloads,ipc}.ts`（弹窗分流 + guest `_blank` 中继去重、will-download 保存对话框与下载面板、clear cache/cookies、DevTools、截图写剪贴板）；`src/preload/webview-browser.cjs` guest 入口（tsup 多入口）；`DesktopApi.browser` 契约；渲染端 `src/renderer/browser/*`（多标签 webview、地址/搜索、页内查找、缩放、下载、截图、菜单、首页 localStorage）；接入右侧面板 PanelTabs（浏览器标签，flush 布局）。
- Layer B 完成：`browser-window.html` 独立入口（vite 多入口），`windows.ts` 独立窗口（query 携带 instanceId/URL/tabs 快照），「在新窗口中打开 / 还原为标签页 / 独立窗口关闭回位」全链路（restore-to-main、detached-window-closed 广播）。
- i18n：`browser.*` 中英文案并入 `src/shared/i18n.ts`；PanelTabs 新增 flush 形态。
- 验证：`pnpm typecheck` 通过；`pnpm test` 254 例中 253 过（`conversation.test.ts:308` 识图标题为存量失败，干净树复现，与移植无关）；`pnpm build` 通过，产物含 webview-browser.cjs 与 browser-window.html。
- Layer C/D/E 未开始：C 需用 safeStorage+node:crypto 重写密码保险库与登录态归档（导入功能 Rust-only，计划按平台降级）；D 含网络记录/路由 mock/CDP 白名单/右键菜单/代理；E 为 Pi extension + 本地桥 + 渲染端执行器（browserMcpOperations 移植）。计划文档在会话工作台 plan/snow-browser-port.md。

- Layer C 核心完成（commit 210043f）：`src/main/browser/passwords.ts` 密码保险库（safeStorage 包裹 AES-256 主密钥 + AES-256-GCM 记录库，~/.tacode/browser-passwords，临时文件 + rename 原子写，safeStorage 不可用拒绝落盘）；guest preload 扩展自动填充/提交捕获（`browser-passwords:find/save` 带 webview sender + senderFrame origin 双重校验）；管理 IPC list/get/save/delete/delete-batch 仅限窗口渲染进程。`tacodePasswordBridge` 暴露给页面脚本。
- Layer C 余项：密码管理设置 UI、登录态归档（依赖 CDP，随 D 层）、浏览器数据导入（Snow 为 Rust/DPAPI/Keychain，TS 仅 macOS Chromium 现实可行，需产品决策降级边界）。
- Layer D/E 未开始（计划与会话工作台 plan/snow-browser-port.md 同步）。
- 白屏修复（commit daf3009）：沙箱 preload 无 __dirname，guest preload 路径改由主进程 `browser:webview-preload-path` 提供（file: URL），BrowserPanel 拿到路径后再挂 webview；同时修正独立窗口 preload/icon/page 的 bundle 相对路径（tsup 单入口把 browser/* 并入 dist-electron/main，基准是该目录而非 browser/ 子目录）。ELECTRON_ENABLE_LOGGING 复现验证：preload 正常、React 正常挂载。
- 面板标签交互重构（对齐参考设计）：空态为面板内嵌「打开标签页」选择器（PanelPicker）；已有标签时「+」弹出锚定下拉菜单（panel-add-menu），单实例类型（审查）已打开即从菜单隐藏；审查单实例、浏览器可多开（每标签独立 instanceId/webview/独立窗口迁移）；独立窗口关闭广播携带 instanceId。全屏遮罩式 TabPicker 与 panel-empty 空态移除。


## 2026-09-08：补齐 Agent 浏览器操作链（10:49，Asia/Shanghai）

- 根因：已有 webview UI，但没有浏览器 Pi extension 与主进程 Agent 命令通道。参考 Proma 的工具/提示词/超时与引用机制，以及 Snow 的 AX 快照、原生输入与 guest 路由，补齐 Layer E 基础操作。
- 新增 `src/extensions/browser.ts`、`src/shared/browser-tools.ts`、`src/main/browser/{automation,accessibility,page-operations}.ts`。17 个浏览器工具经 AgentHost 私有 Node IPC 驱动已登记 webview，无需外部 MCP 或 Playwright；现有 Runtime plan/ask/auto/full 权限 hook 继续生效。
- 功能覆盖导航/搜索、Observe/Find/ref、点击/悬浮、完整字段填写、键盘、等待、正文分页、滚动、原生下拉、开放 Shadow DOM 固定 CSS 操作、截图和标签管理。Agent 工作标签与用户查看标签独立；浏览器面板/侧栏切换保留 guest；操作前等待 React 展示 ACK。
- 可靠性：导航和新快照作废旧 ref；跨标签 ref 拒绝；观察期间导航拒绝；新 loader 就绪后返回导航结果；超时/停止取消排队动作；悬浮后重新验证原节点及点击点；大元素使用可见命中点；取消后短时释放可能按住的鼠标/键盘。独立审查发现的 3 项边界已修复。
- UI 展示中文浏览器操作名称，修复 localhost/about:blank 解析；README 双语增加使用方式与权限说明。新增 `pnpm test:browser` 隔离 Electron smoke 命令。
- 验证：`pnpm typecheck`、完整构建、真实 Electron BrowserPanel 本地页面 smoke、`git diff --check` 通过；真实 Agent RPC + 本地模型 fixture 验证工具可见性及 IPC 回环。新增 25 项浏览器相关单测全部通过；全量 278/279，唯一失败仍为 `conversation.test.ts:308` 既有识图标题断言。
- 生效方式：重启 TACode 并重新启动 Agent 会话。未操作真实账号、未请求云端模型，未重启用户当前进程，未提交/发布。保留同期 UI 菜单/样式改动；AGENTS.md 未修改。详细证据在会话工作台 `3d29745f-5635-4f1b-96ca-3a1165dc7f29/verification.md`。
- Layer D 网络/代理、Layer C 管理 UI/归档，以及文件上传/任意 JS 等未在本次实现；跨窗口迁移会重建 guest，需重新列出标签。


## 2026-09-08：修正默认外部打开（11:03，Asia/Shanghai）

- 用户截图显示“打开项目 web 端”后 Agent 执行 `open http://localhost:9001/unibest/`。只读核验当前 RPC worker 参数，仍仅加载 vision/provider，没有 browser.js；运行中的旧 Electron 主进程尚未更新，因此新建对话也无法获得上一轮浏览器工具。必须完全退出并重启 TACode，再启动 Agent 会话。
- 新增 `src/extensions/browser-routing.ts` 与 tool_call guard：普通网页请求阻止常见系统 open/xdg-open/start/Start-Process/python webbrowser 及开发服务 --open，返回改用 browser_navigate 的具体提示；明确外部浏览器请求保留，文件打开/服务启动/文档字符串不误拦。该检测用于路由常见命令，不是完整 shell 安全解析器。
- 浏览器提示词明确区分“启动开发服务器”与“在内嵌面板打开真实端口/路径”，并禁止缺失工具时悄悄回退外部浏览器。双语 README 强调完全重启与仅刷新/新建对话的区别。
- 验证：33 项命令路由测试和 2 项真实 RPC 测试通过；后者用不会启动真实浏览器的临时 open fixture，确认外部命令被阻止并能改用 browser_navigate。类型检查、构建、diff 检查通过。全量 312/313，唯一失败仍是既有 conversation.test.ts:308 识图标题断言。
- 未重启或终止用户正在运行的 TACode/Agent 进程；本次修复将在应用完全重启后加载。日志在本会话工作台 browser-routing-build.txt / browser-routing-tests.txt。


## 2026-09-08：右侧面板松开后仍跟随鼠标的修复（11:16，Asia/Shanghai）

- 用户截图及反馈：拖动浏览器右侧区域宽度后，松开鼠标仍左右改变宽度。核验 Chat 原实现仅监听 window pointerup/pointercancel，无指针捕获、buttons 检查、失焦或卸载清理；webview 获取释放事件时，旧 pointermove 监听会持续工作。
- 新增 `src/renderer/panel-resize.ts` 并接入 Chat。主指针捕获；每次 move 在改宽度前检查左键仍按下；pointerup/pointercancel/lostpointercapture、blur、页面隐藏、面板收起/移除及组件卸载统一结束；恢复原 cursor/userSelect，保存宽度，移除监听。忽略右键与其他指针。
- `.is-resizing-panel` 仅在拖动时暂时禁用 webview/iframe 的鼠标命中，防止 guest 抢走释放事件；结束后恢复。原宽度计算与边界保持。
- 验证：9 项状态回归通过，覆盖释放事件丢失、失焦、捕获丢失和卸载。新增真实 Electron 原生鼠标测试：跨入实际 BrowserPanel webview 拖动、松开、随后左右移动，宽度固定且网页交互恢复。`pnpm test:browser`（含完整构建）、`pnpm typecheck`、diff 检查通过；全量 321/322，唯一仍为既有 conversation.test.ts:308 识图标题断言。
- 本轮是 renderer 修复。建议刷新一次 TACode 主窗口，清除旧代码可能残留的拖拽监听。未重启/中断用户会话。本会话未执行 Git 提交；收尾检查发现相关代码已由工作区其他操作纳入 `bf57c87`。日志：本会话工作台 panel-resize-smoke-results.txt / panel-resize-tests.txt。


## 2026-09-08：浏览器统一顶部单层标签（11:43，Asia/Shanghai）

- 用户批准合并顶部面板标签与浏览器内部标签。主面板现在每个网页对应一个顶部标签，按网页标题显示（未取得标题时显示域名或新标签文案）；地址栏下方直接显示网页。长标题省略并保留完整提示，标签过多时横向滚动，选中项自动进入可见区域，+ 始终可用；只剩浏览器可添加时直接新建。
- 新增 browser/panel-state.ts、use-browser-panels.ts、workbench-panels.tsx，集中管理顶部页面/选择/迁移。状态 hook 仍放在 App 生命周期，保留切换/移除项目期间接收独立窗口还原事件的能力。各网页保持挂载，标题或导航更新不会修改初始化参数并重载 guest。
- 网页前台链接、中键后台打开、手动 + 和 Agent 新建统一进入顶部；后台打开保持当前选择。Agent 关闭主模式页面会关闭对应顶部标签，不再隐式创建首页。独立窗口保留内部多标签，还原时每页独立回到顶部，并处理随后窗口关闭广播，避免覆盖已还原页面。
- BrowserPanel 单独保存实际页面 URL，窗口迁移快照使用已导航地址，不使用最初 src 或地址栏编辑草稿；页内 iframe 导航不改写顶层地址。跨窗口仍按原机制重建 guest，不承诺保留跨窗口表单/滚动状态。
- 验证：新增8项状态测试通过；pnpm typecheck、pnpm test:browser（完整构建 + 两组真实 Electron 回归）、git diff --check通过。新增隔离 fixture 直接复用生产 WorkbenchPanels/BrowserPanel，覆盖唯一标签栏、标题、前台与原生中键后台链接、手动与AI新建/关闭、输入与guest保留、实际URL及多页还原、320px窄窗口长标题和滚动。旧浏览器操作与原生拖拽测试继续通过。
- 全量测试329/330，唯一失败仍为既有 conversation.test.ts:308 识图标题断言。双语README已更新。未重启用户进程、未发布或提交、未修改AGENTS.md。验证日志与截图在会话工作台 single-tabs-tests.txt / single-tabs-smoke.txt / single-tabs-electron.png。


## 2026-09-08：放宽右侧网页面板上限（12:04，Asia/Shanghai）

- 用户反馈 Web 端在右侧过于拥挤。定位 Chat 在拖动、读取和保存三处共用固定480px上限；取消该上限，新增 panel-width.ts，按实际 chat-body 宽度动态计算，正常窗口保留320px对话区域，极窄窗口仍让两侧可见。
- 通过 ResizeObserver 适配实际容器尺寸；区分用户偏好与当前显示宽度，窗口变窄时临时收缩，重新放大恢复原偏好，不覆盖已保存的大宽度。修正缺失/异常本地配置的默认值，读取和保存不再截断至480px。
- 8项新增宽度测试、类型检查、完整构建通过；全量337/338，唯一失败仍为既有 conversation.test.ts:308 识图标题。真实Electron新增实际Chat验收：1440px窗口/240px项目栏下网页可拖到880px，对话320px；缩小后自动收窄、放大后恢复880px，同一guest保留，刷新仍恢复880px。旧单层标签、原生中键后台打开、跨webview拖拽释放等回归通过。
- 回归中发现网页title事件可早于guest登记；将原有测试等待改为同时确认标题和登记数量，保留断言。首轮整组测试在该时序上失败，修正后node scripts/test-browser.mjs全组通过。
- 证据：本会话工作台 panel-width-tests.txt / panel-width-smoke.txt / expanded-panel-electron.png。未重启用户进程、未提交/发布、未改AGENTS.md。


## 2026-09-08：左侧菜单可收为图标窄栏（12:18，Asia/Shanghai）

- 用户希望右侧网页拉大时，左侧项目菜单可以像参考图那样最小化。SidebarNav 新增手动收起/展开按钮，252px完整菜单收为56px图标栏，释放196px空间；收起后保留新对话、项目、设置入口和中文/英文可访问名称。
- localStorage 记住折叠状态；项目与会话节点仅隐藏，不卸载。设置菜单沿用原AccountMenu及其portal，通过真实入口验证仍可打开。macOS下折叠按钮位于红黄绿控制下方，聊天标题左侧为跨出窄栏的窗口按钮留位。
- 与上一轮动态宽度联动：侧栏变窄后，chat-body ResizeObserver获得额外空间，可继续拖宽网页；展开左栏时临时限制右侧宽度，再收起时恢复偏好。不会重建guest或触发网页刷新。
- 扩展真实Electron fixture，直接复用生产SidebarNav、AccountMenu、Chat、WorkbenchPanels；原生输入验证折叠、展开、三个图标入口、设置菜单、节点/guest保持、macOS位置及重载持久化。1440px窗口中实际侧栏252px时网页最大868px，收为56px后可达1064px，均保留320px对话区域。
- pnpm typecheck、pnpm test:browser（完整构建+全部真实浏览器/拖拽/侧栏回归）、git diff --check通过。全量337/338，唯一失败仍为既有conversation.test.ts:308识图标题断言。双语README更新；截图与日志位于本会话工作台 collapsed-sidebar-electron.png / sidebar-smoke.txt / sidebar-tests.txt。未重启用户进程、未提交或发布，未修改AGENTS.md。


## 2026-09-08：修正窄栏遗漏项目与会话（12:38，Asia/Shanghai）

- 用户指出收起后看不到项目和会话。上一版将thread-list整体隐藏，只保留通用操作入口，未满足窄栏仍能切换项目/会话的需求。本轮移除隐藏，沿用现有项目列表与SessionRow，折叠状态显示名称前两个字符，完整title及aria-label保留，当前项目和会话高亮。
- 窄栏列表可滚动、各项目分组和会话条目可直接点击，展开态继续显示完整名称；会话置顶标记、右键菜单保留，重命名输入框显示在窄栏右侧，避免在56px内输入。未改原项目/会话切换回调或展开状态。
- 扩展真实Electron回归：两个项目、四个真实SessionRow；原生点击切换项目/会话且保持56px，缩短窗口验证列表滚动，原生右键重命名并检查活动状态，展开/收起保持节点及guest。旧标签/动态宽度/拖拽释放回归继续通过。
- pnpm typecheck、完整构建与pnpm test:browser、git diff --check通过。全量337/338，唯一仍为既有conversation.test.ts:308识图标题断言。README双语更新。证据：sidebar-navigation-smoke.txt / sidebar-navigation-tests.txt / collapsed-sidebar-electron.png（本会话工作台）。未重启用户应用、未提交或发布、未改AGENTS.md。


## 2026-09-08：拖大右侧自动收起左栏与线性动画（13:04，Asia/Shanghai）

- 用户要求右侧拉大到一定程度时自动收起左栏，给会话区留空间，动画更线性。新增sidebar-layout.ts管理手动与自动折叠状态，App及真实fixture共享。拖大后会话可用空间不足420px触发自动收起；缩回保持收起，用户可手动展开，自动状态不覆盖已保存的手动选择。
- 侧栏252→56px采用180ms linear宽度过渡，遵循系统减少动态效果偏好。调整min-width与flex约束使宽度过渡生效，溢出文字不进入会话区。既有项目/会话窄栏导航与右键菜单保持可用。
- 拖动中保留目标宽度，侧栏释放空间时仍能向指针对应宽度变化；松开时将当下实际宽度固定并保存，剩余动画仅扩大会话区。修正越过面板最小宽度时从220反跳到默认268的问题。
- 真实Electron验证：剩余440px不触发、400px触发并增加196px到596px；线性0.18s样式与单调中间帧；同一拖动中反向移动不展开，继续拉大可到1064px且保留320px会话；手动展开、动画中快速松开后宽度稳定、窗口缩放/刷新、guest和手动偏好保持。旧浏览器工具/单层标签/拖拽释放/窄栏导航及重命名回归通过。
- pnpm typecheck、pnpm test:browser（含完整构建）、git diff --check通过；全量342/343，仅既有conversation.test.ts:308识图标题断言失败，新增5项单测通过。README双语更新。证据：会话工作台auto-sidebar-smoke.txt / auto-sidebar-tests.txt / expanded-panel-electron.png（本轮自动收起后的截图）。未重启用户应用，未提交/发布，未改AGENTS.md。


## 2026-09-08：右侧标签上移至窗口标题栏（13:22，Asia/Shanghai）

- 用户附红框与Proma参考图，希望「审查 / 网页 / ＋」占据窗口最顶部原空白区域，与左侧会话标题同高，从而增加网页内容高度。Chat标题栏拆分为会话标题区和与右侧面板同宽的标签区，面板开关与窗口控件继续在右端。
- PanelTabs通过上下文提供的稳定DOM容器，仅将现有标签栏Portal到标题栏；网页内容保留原组件树及guest，独立/无Chat容器场景仍在面板内渲染标签。标签、加号明确no-drag，空白区域可拖动窗口；macOS窄侧栏避让只作用于会话标题区域，右侧边界不受padding干扰。
- 新增scripts/workbench-header-smoke.ts并接入真实Electron回归：测量标题与面板边界一致、地址栏紧接标题栏、内容增高37px；原生点击切换/关闭标签、新建页、加号菜单、关闭/打开面板，无窗口位移，guest及输入保留。验证长标题提示与溢出、窄窗口，随后完整跑动态宽度/自动收起/动画中松开/窄栏导航回归，均通过。
- pnpm typecheck、完整构建与pnpm test:browser、git diff --check通过。全量342/343，唯一仍为既有conversation.test.ts:308识图标题断言。README双语更新。证据：会话工作台top-tabs-smoke.txt / top-tabs-tests.txt / top-tabs-electron.png。未操作用户Google页，未重启用户应用、未提交或发布、未改AGENTS.md。

## 2026-09-08：移除待办浮层旁的回到底部箭头（18:46，Asia/Shanghai）

- 用户附红框截图，要求去掉底部待办进度胶囊右侧的圆形 ↓ 按钮。progress-overlay.tsx 删除任务存在时并排渲染的 progress-overlay-jump 按钮，styles.css 移除对应两条规则并更正区块注释；无任务时的独立回到底部箭头（conversation-latest）保留，atBottom/onFollowLatest 仍为该分支服务。
- 顺手修复全量测试唯一红项：conversation.test.ts:308 识图标题断言仍期望 ca17ab5（8-21）多供应商改造前的「GLM-4V 识图」前缀，与 vision-api.test.ts 及现实现（「识图 · 模型」）不一致，HEAD 上即失败；已对齐为「识图 · glm-4v-flash · MinerU OCR」。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。含上一会话未提交的进度浮层聚合改动（collectProgressTasks + ProgressOverlay）。未提交/发布，未改AGENTS.md。

## 2026-09-08：优化回到底部按钮与任务列表浮层样式（18:52，Asia/Shanghai）

- 回到底部独立箭头（conversation-latest）从右缘 26px 方钮改为居中 32px 圆形悬浮钮：与进度胶囊同视觉语言（line-strong 描边、88% 表面模糊、raised 阴影），hover 上浮 1px，不再贴着滚动条。
- 任务列表浮层（progress-overlay-popover）：12px 圆角 + 94% 表面模糊；表头粘性置顶带底部分隔线，右侧新增「完成数/总数」计数 chip（progress-overlay.tsx）；任务行加高至 7px 8px、8px 圆角，运行中行加 accent 7% 底色高亮，已完成文字弱化为 ink-3，失败状态文字标红。
- 新增浮层区域 prefers-reduced-motion 守卫：禁用相关过渡与 progress-spinner 旋转，hover 不再位移。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：移除停止时的「正在停止…」toast（19:13，Asia/Shanghai）

- 用户附截图红框，要求暂停/停止时不再弹出提示。App.tsx 停止流程（agent abort）删除 setToast(t("toast.stopping"))；i18n.ts 移除中英 toast.stopping 词条（已无引用）。stopping 状态本身保留，仍用于流式收尾与 ExecutionFlow 状态文案。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：进度胶囊兼任一键回到底部（19:17，Asia/Shanghai）

- 用户反馈：任务浮层显示期间没有回到底部入口（上一轮移除了胶囊旁的箭头）。方案：不新增悬浮钮，进度胶囊按状态分流——不在底部时点胶囊/回车即回到底部（先收起已展开列表再 followLatest，title 为「回到最新」）；已在底部时维持原行为展开任务列表。
- 胶囊尾部图标随状态切换：非底部显示 ↓（提示回到底部），底部显示 ›/⌄（提示展开列表）。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：一键到底滚动动画丝滑化（19:21，Asia/Shanghai）

- 原实现（use-follow-scroll.ts followLatest）：每帧走剩余距离 50%，但距离超过一屏直接 done=true 瞬移到底——用户反馈一键到底不丝滑的根因。
- 改为时间基动画：指数趋近（时间常数 45ms，帧间隔换算、帧率无关）叠加每帧限速（max(48, 视口高 30%) px/帧@60fps 等比缩放），近距离指数收尾、远距离有界匀速滑行，任何距离都不瞬移；流式追加内容时 target 每帧重算持续跟随；reduced-motion 仍瞬时到位；保留 lastAssigned/currentTop 记账避免 scroll 监听把程序滚动误判为用户意图。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：到底部后继续滚动不再误显回到底部箭头（19:23，Asia/Shanghai）

- 根因：use-follow-scroll.ts 的 intent（wheel/touchstart/pointerdown/方向键）无条件判为「离开底部」，已贴底时继续向下滚或触控板回弹也触发，箭头误显示。
- 修复：intent 先算当前距底距离，≤16px（与滞回恢复阈值一致）直接返回，不打断跟随；真正离开底部后才取消跟随并显示箭头。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：输入框图片改为卡片式附件预览（参考 Proma-main AttachmentPreviewItem）（19:59，Asia/Shanghai）

- 之前图片贴在 contentEditable 文本流里（.prompt-upload 行内 28px chip），改为独立状态数组 attachments + 输入区上方卡片行（68px 缩略图、圆角 10px、hover 右上角黑色半透明圆形 ×、点击开 lightbox）。
- ui.tsx：新增 attachments 状态与 removeAttachment/addUploads（写 state 取代 DOM chip）；sendNow 用 attachments 生成 dataUri 列表；blank 与 attach 按钮 disabled 改用 attachments.length；移除 makeUploadChip/insertNodeAtCaret/collectPromptImages/promptSvg 死代码与 contentEditable 的 chip 删除 onClick；新增 lightbox portal（复用 .modal/.lightbox）。
- styles.css：.prompt-upload 系规则替换为 .prompt-attachments/.prompt-attachment{,-img,-remove}；删掉 .prompt-input .prompt-upload 两条。
- 发送后消息气泡里的图片展示（UserTurn 缩略图）暂保留原样，后续再按 Proma MessageAttachments 对齐。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：发送后用户消息图片展示对齐 Proma MessageAttachments（20:04，Asia/Shanghai）

- ui.tsx UserTurn：图片区分单/多图——单图较大等比缩放（≤500px，object-contain），多图 280px 方块网格（object-cover），均圆角 12px 点击看大图；每张 hover 底部右下角黑色半透明「保存」悬浮按钮（Download 图标，data-URI 直接下载）。新增 Download 导入。
- styles.css：.user-images 改为 flex-wrap gap 8px；新增 .user-image-wrap/{single}/.user-image-save；单图 object-contain、多图 object-cover 规则替换原统一 140px。
- 注：Proma 的保存走 electronAPI.saveImageAs(localPath)，当时无此桥接，改用锚点下载 data-URI；无左右翻页（图片数据即 data-URI，可后续按需加）。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-08：发送后消息图片从文字气泡独立成块（对齐 Proma）（20:19，Asia/Shanghai）

- 用户确认「图片不包进文字气泡」。UserTurn 重构：.user-images（图片块）移出 <article.user>，成为其前置独立兄弟节点——图片块在上、文字气泡在下、操作区更下，互不共用背景。
- styles.css：.user-images 改为 justify-content flex-end + margin 2px，配合 .user-turn 的 column/flex-end/gap 4px 右对齐。
- 图块无背景、文字保留气泡背景，分离感由「独立块 + 气泡」自然呈现；交互不变（单图大图/多图 280px、hover 保存、点击大图）。
- pnpm typecheck 通过；pnpm test 全量 352/352 通过。未提交/发布，未改AGENTS.md。

## 2026-09-11：「停止」点了没反应（12:10，Asia/Shanghai）

- 现象：turn 停在「等用户应答」的卡片上（ask_user、权限确认、访问边界选择）时，点停止完全没效果，按钮一直停在停止态。
- 根因一（等待应答的工具不可中止）：pi 的 `session.abort()` = `agent.abort()` + `await waitForIdle()`，必须等当前工具返回才发 abort 响应；而 ask_user 调 `ctx.ui.select/input` 没传 signal，pi RPC 的 UI 请求只能由 extension_ui_response 解开 → 工具永不返回 → abort 响应永不发出（该请求在主进程按 30 分钟长请求超时）→ 渲染层 `setRunning(false)` 永不执行。同类阻塞点：extension.ts 的审批 `confirm`、commands.ts 的访问边界 `select`。
- 根因二（abort 排队）：主进程把 `abort` 也放进按 runtime 串行化的命令队列，队列里压着 `compact`/`fork`/大快照时停止要排队；pi 侧本身是按行并发处理 stdin 的，不需要这层串行。
- 修复：
  - runtime/tools/ask-user.ts：execute 改用工具 signal，select/input 传 `{ signal }`；取消与中止统一走 `cancelledAnswer()`（details.cancelled=true）；已中止时不再弹窗。
  - runtime/extension.ts：新增 `confirmApproval(ctx, title, message)`，三处审批 confirm 传 `ctx.signal`。
  - runtime/tools/commands.ts：`requestCommandAccess` 接收 signal 并传给 select，中止时报 "Command cancelled."。
  - main/agent-manager.ts：新增 `OUT_OF_BAND_COMMANDS`（abort），停止类命令绕过按 runtime 串行队列。
  - renderer/App.tsx：onStop 先把未决 UI 请求按 `{cancelled:true}` 答复（卡片立即收起）；abort 结果加 10s UI 上限（`STOP_UI_TIMEOUT_MS`），超时把按钮还原可再点，收尾仍由 agent_settled 驱动。
  - renderer/ui.tsx + styles.css + shared/i18n.ts：停止按钮新增 stopping 态（disabled + 方块脉冲 + aria-label「停止中…」），消除「点了没反应」的观感。
- 测试：新增 src/runtime/tools/ask-user.test.ts（4 例：选项/文本提问可中止、已中止不弹窗、正常应答不受影响）；src/main/agent-lifecycle.test.ts 新增「abort 带外、不被队列里的 compact 拖住」1 例，并让 FakeHost.blockNextRequest 支持按命令类型挂起。
- 验证：pnpm typecheck 通过；pnpm test 662/663 通过。唯一失败 src/main/agent-subagents.test.ts「runs a subagent and returns its report to the parent turn」（details 期望 {total:1,done:1} 实得 {}），已用 git stash 移除本次全部改动复跑确认是既有失败，与本次修复无关。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：思考深度对齐 cursor-byok-main（五档 + Anthropic 恒自适应）（13:45，Asia/Shanghai）

- 参考 /Users/yfdl/Downloads/cursor-byok-main 的做法：模型选择器只提供五档 Low/Medium/High/Extra High/Max（server/src/cursor/services/model_catalog.rs 的 EFFORTS）；OpenAI 线路把档位原样塞进顶层 reasoning_effort 或嵌套 reasoning.effort，Anthropic 线路恒发 thinking:{type:"adaptive"} + output_config.effort（server/src/provider/anthropic.rs 的 apply_model），服务端没有 budget_tokens 分支。
- 改动前的差距：档位六档（多一个上游 API 不接受的 minimal）；Anthropic 服务默认只勾四档，且要手工勾上极高/最大才切自适应，否则 pi 走 budget_tokens；「最低 → low」特判散落在 provider-config、界面与内置 map。
- 改法：
  - shared/provider-config.ts：`SERVICE_THINKING_LEVELS` 收敛五档，`serviceThinkingLevels` 不再按协议给四档默认；新增 `serviceThinkingDispatch`（anthropic + reasoning 缺省自适应，只有显式 budget 才回落）决定 `compat.forceAdaptiveThinking`；`thinkingLevelMap` 档位同名透传、minimal 恒 null；`validateService` 把历史 minimal 折算 low 并校验 thinkingDispatch 枚举。
  - shared/types.ts：ProviderModelBinding 加回 `thinkingDispatch?: "adaptive" | "budget"`（缺省自适应）。
  - renderer/provider-dialog.tsx + styles.css + shared/i18n.ts：档位 chips 收敛五档；新增「思考下发」两态单选（自适应默认 / Token 预算）带当前下发说明，未启用模型只读展示；「可用推理等级」文案改为「思考深度档位」。
  - shared/thinking.ts：`EXTENDED_THINKING_LEVELS` 去 minimal，`normalizeEffort` 把历史 minimal 折算 low；shared/subagents.ts 档位去 minimal（老角色文档写 minimal 仍按 low 解析）；runtime/extension.ts 的 /effort 白名单同步并接受 minimal→low。
  - runtime/tools/deepseek-provider.ts 的内置 map 本来就把 minimal 置 null，无需改动。
- 取舍：OpenAI 线路也不再提供「最低」档（参考的显示即如此）；只认 budget_tokens 的第三方 Anthropic 网关靠模型级「Token 预算」显式兜底，不再有按档位推断的「自动」态，也不在 TACode 里维护第二份 token 换算表。
- 验证：pnpm typecheck 通过；pnpm test 75 文件 / 665 用例全过。provider-thinking-runtime.test.ts 新增 chat_completions 顶层 reasoning_effort 与 responses 嵌套 reasoning.effort 两条真实请求断言，原 Anthropic 用例改为覆盖默认自适应、xhigh/max 原样透传、显式预算回落 budget_tokens；另用 linkedom + react-dom 客户端渲染真实 ModelSelectionPanes，七项断言确认五档 chips、默认选中自适应、预算模型与只读预览、OpenAI 线路无下发字段。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：平台工具层按用户报告落地 7 项修复 + agent 规则进 promptGuidelines（15:20，Asia/Shanghai）

- 来源：用户用「平台工具侧 / agent 失误」两段式报告反馈真实会话踩到的坑（rg -rn 被误读成渲染 bug、write_stdin 丢输出、apply_patch 报错不可用、子代理 no_report 无原因、越界参数不回显等），要求逐项落地而非只讨论。
- P0-1 `rg -rn` 无告警：新增 `src/runtime/tools/command-lint.ts`（轻量 shell 分词 + rg 的 `-r`/`--replace` 误用识别：`-rn` → 解析成 `-r n`，回显 actual argv 与大概率想要的命令；只对 rg 生效、不误伤 `grep -rn`、引号内的 `-rn` 不算旗标）；`managed-process.ts` 的 `ManagedResult` 新增 `command`/`warnings`，`formatManagedResult` 先输出 warning 再输出正文，并始终回显 `command:`。
- P0-2 退出后轮询丢输出：`managed-process.ts` 不再在轮询时删记录，进程结束后保留（`FINISHED_RETENTION_MS` 10 分钟 + `MAX_FINISHED_RECORDS` 20 条，最旧淘汰）；再次轮询返回 `replayed: true` 与保留输出而不是 `Unknown process`；未知 id 的报错会列出已知进程与保留策略。
- P0-3 apply_patch 失败诊断：`patch.ts` 指令行容错（前导空行 / 尾随空白）、`End Patch` 缺失时报「已解析 N 个 action + 输入结束行 + 末行内容」；`Patch context not found` 附最近似行号、匹配率、首个差异行（expected/actual + 字符数），并提示「相同文本被 cursor 挡在之前的 hunk」这一典型原因。
- P1-4 子代理 no_report：`shared/delegation.ts` 新增 `DELEGATION_REPORT_NUDGE`；主进程协调器（`delegation-coordinator.ts`）与进程内 runner（`delegate.ts`）都在空报告时自动补发一次「只回最终报告」的指令（每轮只重试一次），重试出文本即 completed，仍失败才落 failed 并附 `lastActivity` / stderr 摘要 / 已重试说明。
- P1-5 参数越界不回显：`exec_command` / `write_stdin` 的 schema 去掉 min/max（改由 description 说明区间），新增 `normalizeExecParams` / `normalizeYieldTimeMs`：回显传入值 + 允许区间 + 常用组合（长任务 timeout 600000 + yield 30000），超上限夹取并在结果最前面打 note；`write_stdin.process_id` 改为可选 + 运行时校验，缺失时列出已知进程。
- P2-6 搜索列号误读：`search_files` 去掉 `--column`，description 声明 `path:line:text`。
- P2-7 长任务接 `| tail` 无进度：command-lint 对「像长任务 + 管道接 tail/head」给 warning，提示不要接管道、拿 process_id 用 write_stdin 轮询。
- agent 行为规则（用户明确选择写平台 promptGuidelines，不写项目 AGENTS.md）：`commands.ts` 的 `shellPromptRules()` 增加「搜索只用 rg -n、禁 -r」「长任务别接 tail/head」「异常输出先最小复现自证命令」「每条昂贵全量检查只跑一次、用 && 串联」「分支名先 git branch -a」「大规模机械改写允许脚本 + 断言 + 抽查 + 构建验证」；`extension.ts` 的 apply_patch guidelines 增加「按最近似行号只重发该 hunk」「大规模改写允许脚本路径」。
- 测试：新增 `command-lint.test.ts`(11)、`commands.test.ts`(7)、`managed-process.test.ts`(3)；`patch.test.ts` 增 4 例（指令容错、End Patch 位置、最近似行号 + 首个差异行、字符重合度）；`delegation-coordinator.test.ts` 增 no_report 重试用例，并把 FakeHost 改为「每轮 prompt 重置 settled + 支持 reportTextForPrompt」，原 no_report 用例改断言 messages=2；`delegate.test.ts` 增本地重试与失败附证据 2 例。
- 验证：pnpm typecheck 通过；pnpm test 78 文件 / 695 用例全过。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：读取截断与双列行号的根因修复（15:30，Asia/Shanghai）

- 现象（用户截图）：`read_file` 详情里同一行出现两列数字（`93 93`、`99 99`），中段被 `... output truncated (10891 chars) ...` 吞掉、行号从 97 跳到 436，模型只能自己猜「输出被截断，读关键区间 100-450」；另一张截图是 `read_file` 报 `Path escapes workspace: /Users/yfdl/work/xc-iot/…`。
- 根因一（两层行号）：runtime 的 read_file 在正文里嵌了 `%6d\t` 真实行号；渲染层 `HighlightedFileCode` 默认又加了一条 `index + 1` 的显示序号（截断标记行也占一个序号，所以被编成 99）。两列数字含义不同却长得一样，看起来像同一个行号被写了两遍。
- 根因二（按字符硬切）：`clipForModel` 只保留头 70% + 尾 25% 的**原始字符**，会切在行中间（截图里只有 UI 序号、没有真实行号的那一行），且标记只报字符数、不报丢的是哪几行；read_file 默认 500 行窗口，超过 6000 字符必然丢掉中段。
- 根因三（越界报错）：`Workspace.resolve()` 的 `assertLexicallyInside` 只抛 `Path escapes workspace: <path>`，既不说 workspace root，也不提「用相对路径」或「把该目录作为项目打开」。
- 改法：
  - `renderer/codeblock.tsx` + `renderer/ui.tsx` + `styles.css`：读文件详情传 `lineGutter={false}`（正文已带真实行号），新增 `.code-line.no-gutter` 单列布局；文件抽屉仍保留渲染层序号（那边是原始正文、没有嵌入行号）。
  - `runtime/tools/files.ts`：read_file 改为**按字符预算反推 end**，一次读取永远返回连续区间（不再有中段空洞），并明确写出 `[N more line(s) omitted (lines X–Y); continue from line X with line_start]`；单行超预算时只截断该行并标注 `[line N alone exceeds the …-char read budget]`；`clipForModel` 改为**按行取头尾**并报 `(N line(s) / M chars omitted)`，单行超长时说明两个半段不相邻。
  - `runtime/tools/workspace.ts`：越界报错补 `workspace root: …` 与「用相对路径 / 把该目录作为项目打开」；symlink 越界给同类提示。
- 测试：新增 `src/runtime/tools/files.test.ts`（7 例：预算内连续区间、从中间续读连续、短行仍走 500 行窗口、单行超预算、clipForModel 按行不改半截、不超预算原样返回）；`workspace.test.ts` 增 1 例（越界报错含 root 与相对路径提示）。
- 验证：pnpm typecheck 通过；pnpm test 79 文件 / 703 用例全过；pnpm build 通过。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：浏览器工具"生成中途切换权限后变 Tool not found"根因与 F1+F2 修复（15:45，Asia/Shanghai）

- 现象与证据（来自用户会话 `~/.tacode/sessions/2026-09-11T07-13-26-347Z_01a08f50-*.jsonl`，cwd `/Users/yfdl/work/xc-app`）：07:14:04 `browser_navigate` 成功（tabId browser-tab-1789110844767-ihqk4l）、07:14:08 `browser_wait_for` 成功；07:16:52 出现 `customType: tacode-permission {"permission":"full"}`（界面权限选择器 → `App.tsx:1654` 发 `/permissions full`）；07:22:00 / 07:22:05 同一回合内 `browser_navigate`、`browser_list_tabs` 都返回 `Tool … not found`。该会话只有三条用户消息（07:13:26 / 07:16:38 / 07:22:56），所以失败与切权限发生在**同一回合**内。
- 根因：`browser_*` 不在 worker 启动工具表（`src/runtime/options.ts` 的 `defaultActiveTools`），pi 侧 `_allowedToolNames` 因此不含它们；浏览器扩展只能自己 `setActiveTools(union)` 临时加进去（旧 `src/extensions/browser.ts:66`，只在 `session_start` / `before_agent_start` 执行）；而权限模式变化时 runtime 又用 `setActiveTools(options.activeTools)` 整体替换（旧 `src/runtime/extension.ts:152`）。三处各写同一状态、谁最后执行谁赢 → 生成中途切权限就把 `browser_*` 静默摘掉，同回合无恢复点，模型在 `currentContext.tools` 里查不到（`pi-agent-core/dist/agent-loop.js:398`）。plan 模式同源：`planAllowedTools` 不含 browser_*，但下一次 `before_agent_start` 又会被扩展加回来。
- F1（工具集单一权威）：新增 `src/shared/tool-set.ts`，只有它计算激活集 = 基础工具（`--tools`）∪ 扩展贡献 ∪ carryOver 快照；plan 模式 = (base ∩ plan 白名单) ∪ planAllowed 贡献 ∪ `update_plan`；进入 plan 前 `captureToolSetCarryOver` 记下 base/贡献之外仍激活的名字（如 `mcp__*`），离开后恢复。状态挂在 `Symbol.for("tacode.tool-set")` 的 globalThis 上——runtime worker 与 `extensions/*` 是 tsup 两组独立产物，模块级单例会各持一份。`src/runtime/extension.ts` 的 `applyPermissionTools` 改为「配置策略 + `applyToolSet`」（`applyToolSet` 幂等：无变化不调 setActiveTools，避免重建系统提示；变化时打一行 `[tool-set] permission=… added=[…] removed=[…]`）；`src/extensions/browser.ts` 只 `setToolContribution`，删掉 activate union；`src/extensions/vision.ts` 改用 `setToolContribution` / `clearToolContribution`。
- F2（每轮重新断言）：runtime 注册 `pi.on("turn_start")` 重新配置策略并 `applyToolSet`，中途的权限/贡献变化不再留下整回合空窗。
- 测试：新增 `src/shared/tool-set.test.ts`（11 例，含「切到 full 不再摘掉 browser_*」「plan 收敛」「收敛 pi 内置工具」「carryOver 恢复」「无变化不重建」）、`src/extensions/browser.test.ts`（5 例，含无 IPC 通道不贡献）、`src/main/browser-toolset.test.ts`（真实 worker + mock 网关，断言切 `/permissions full` 后请求体里仍有 `browser_*`，并反向断言 plan 模式下没有）；`src/extensions/vision.test.ts` harness 改为先 `resetToolSet` + 配置策略。
- 验证：pnpm typecheck 通过；pnpm test 82 文件 / 720 用例全过；pnpm build 通过。另外用带 IPC 的真实 worker 冒烟（fork + stdin 写 RPC）：session_start 收敛 40 → 27 个工具且 browser 工具保留；发送 `/permissions full` 后 `browserTools=17` 仍在、`[tool-set] permission=full` 无新变化；`turn_start` 钩子在每次 LLM 往返触发。回归测试有效性用「临时关掉贡献应用」验证过（会失败）。冒烟在 `~/.tacode/sessions` 留下的一个空会话文件已删除（不在 DB/loaded-sessions 中）。
- 未做（用户未选）：F3 plan 模式只读浏览器白名单 + 明确拒绝文案、F4 `BROWSER_GUIDANCE` 与实际激活工具对齐、F5 工具集变更写入 session、F6 工具不可用时的能力说明。当前 plan 模式下浏览器工具不可用（与 Proma 显式 deny 一致），但 guidance 仍会提到 browser_*，模型仍可能先撞一次 not found。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：浏览器工具 F3+F4（plan 只读白名单 + 提示与实际工具对齐）（15:50，Asia/Shanghai）

- F3（plan 模式只读白名单 + 调用期明确拒绝）：`src/shared/browser-tools.ts` 新增 `BROWSER_PLAN_READ_ONLY_TOOLS`（observe / find / extract / wait_for / scroll / screenshot / list_tabs / select_tab；`browser_navigate` 仅当传 `path` 本地预览时放行）与 `browserPlanModeBlock()`；`src/extensions/browser.ts` 的贡献改为 `planAllowed: true`（工具在 plan 模式下**仍然存在**，否则调用就是 `Tool … not found`），交互类调用由 `tool_call` 钩子在调用期拒绝并给出原因（"计划模式下只能观察页面…可用：…请在 /plan execute 后再交互"），对齐 Proma `agent-orchestrator.ts:1346` 的调用期 deny；比 Proma 多放开 wait_for / scroll / select_tab（观察所必需且不改页面状态）与 path 本地预览。
- F4（提示与实际激活工具一致）：原来的静态 `BROWSER_GUIDANCE` 常量改为 `browserGuidanceFor({ activeTools, planMode })`：按当前真正激活的 browser_* 工具分段拼装（缺 `browser_fill` 就不讲 fill/select_option/hover 流程，缺 `browser_list_tabs` 就不讲 tabId 段），plan 模式追加只读限制段；一个浏览器工具都没激活时只给「本轮不可用、不要用系统浏览器/截图代替」的诚实说明；注入用 `<!-- tacode-browser-guidance:start/end -->` 标记，重新注入前按区间 `stripBrowserGuidance()` 移除，不依赖扩展处理顺序，也不会吃掉其它扩展追加的提示。
- 测试：`src/shared/browser-tools.test.ts` 增 9 例（只读放行/交互拒绝/本地预览放行/非浏览器工具不受影响/guidance 分段/plan 段/标记移除）；`src/extensions/browser.test.ts` 增到 9 例（plan 下工具仍在激活集、调用期拒绝含原因、非 plan 不拦、注入一致且不重复、plan 注入含只读说明）；`src/main/browser-toolset.test.ts` 增 1 例真实 worker + mock 网关的端到端：plan 模式下模型调用 `browser_click` 被拒（tool 结果含"计划模式"与"browser_observe"）且浏览器桥接零调用；原 plan 阶段断言改为「浏览器工具仍在表里 + 基础工具 apply_patch 被收敛」，保留灵敏度。回归测试有效性用「临时关掉 plan 拒绝」验证过（会失败）。
- 验证：pnpm typecheck 通过；pnpm test 84 文件 / 752 用例全过；pnpm build 通过。
- 剩余（未做）：F5（工具集变更写入 session 供事后对齐，目前只有 worker stderr 的 `[tool-set]` 一行）、F6（工具被策略收起时的 turn 内能力说明，本轮只做到了「提示按激活集描述 + 不可用时的诚实说明」）。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：执行过程折叠体感改进（展开 100% 高度 / 离屏才静默收起 / 折叠态显示最后一步）（16:58，Asia/Shanghai）

- 反馈：用户反馈 ExecutionFlow 的折叠体感差，核心诉求是「展开时高度按内容 100%，不要出现第二个滚动条」，并要求先做出来看效果。
- 根因：`.flow-viewport.bounded` 在 live 且有回复时给过程区 `max-height: min(320px, 45vh)` + `overflow-y: auto` + `overscroll-behavior: contain`，在消息流里形成嵌套滚动陷阱（滚到底也不传给外层），且该视口带 `tabIndex=0`，Tab 会停在其中。折叠侧则是结束后 3 秒倒计时自动收起，每秒跳动的 `flow.collapseIn` 文案会打断阅读。
- 改（`src/renderer/execution-flow.tsx`、`src/renderer/styles.css`）：
  - 删除 `bounded` 状态与 `.flow-viewport.bounded` 规则、`tabIndex`、`onWheelCapture`/`onPointerDownCapture`/`onKeyDownCapture` 的交互标记；过程区改为按内容自然高度展开，整页只保留外层一个滚动条。
  - 移除 `useFollowScroll`（过程区不再内部滚动，`scroll.atBottom` 这层保护随之失效）。
  - 自动收起改为 `IntersectionObserver` 观察 `.flow-process`：只有过程区完全滚出视口（`intersectionRatio === 0`）且 `canAutoCollapse()` 为真时静默延迟 600ms 收起；用户手动展开过（`interacted`）、失败/中断/等待确认/缺结果等状态照旧保持展开。删除 `flow.collapseIn` 中英词条。
  - 折叠态 header 新增「最后：<最后一步工具的 label · chip>」（新增 `flow.last` 中英词条与 `.flow-last` 样式），不展开也能看出刚才做到哪一步。
- 验证：pnpm typecheck 通过；pnpm test 84 文件 / 773 用例全过。
- 未做（用户先看效果再定）：思考「超过 4 行才出现展开按钮」的隐藏阈值、`grid-template-rows` 收起动画对超长内容的跳动、折叠摘要文案偏长、`prefix` 里 `flow.summary` 的措辞。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：执行过程第二版（最近 N 步 + 取消思考隐藏阈值 + 高度过渡）（17:05，Asia/Shanghai）

- 背景：上一版把过程区改为按内容 100% 高度后，一轮里思考/输出很长时页面仍会明显变长。用户确认继续处理三件事：过程项「默认只展开最近几步」、思考条目的「超过 4 行才出现展开按钮」隐藏阈值、收起动画对超长内容的跳动。
- 改（`src/renderer/execution-flow.tsx`）：
  - 新增 `RECENT_STEP_WINDOW = 4`：过程项按「最近 4 步」分组，更早的收成一行「更早的 N 步」（`flow.earlierSteps` / `flow.collapseEarlier` 中英词条），点击才渲染旧项（收起时不进 DOM，避免长会话的渲染开销）。`live` 开始新一轮时重置为收起。原 `LIVE_CHILD_WINDOW` 保持用于高频更新冻结，两者语义不同故分开常量。
  - `Thought` 的裁剪判定去掉「4 行 × lineHeight」的手算阈值：改为默认 `-webkit-line-clamp: 2` 预览，用 `scrollHeight > clientHeight + 1` 判断真实溢出，只有真溢出才出现「展开思考」；展开态跳过测量并保留上次判定（否则展开后 `clientHeight` 等于全文高度会误判成「不溢出」，按钮消失）。按钮显示条件为 `overflowing || expanded`。
  - 顺带修 `FreezeCell` 的空缓存缺陷：原来 `useRef` 初始 `{ sig, node: null }`，若组件首次就以 `freeze=true` 挂载（正是「展开更早的 N 步」时旧项才首次渲染的情况），签名不变会直接返回 `null`、什么都不渲染；改为缓存可为 `null` 并在缺失时 build。
- 改（`src/renderer/styles.css`）：
  - `.flow-collapse` 从 `grid-template-rows: 0fr/1fr` 换成 `height: 0 → auto` 过渡（`.execution-flow` 上开 `interpolate-size: allow-keywords`，Electron 37 / Chromium 138 支持）。grid 方案会把子内容压扁，超长过程收起时整块挤成一团再弹开，就是「跳动」的来源；height 过渡只裁剪不变形。不支持的浏览器只是没有动画，`height: auto` 仍正确，不会隐藏内容。
  - `.flow-thought-text.clipped` 行数 4 → 2；新增 `.flow-earlier*` 样式与 `flow-reveal` 淡入关键帧；`prefers-reduced-motion` 下同时关掉新动画。
- 验证：pnpm typecheck 通过；pnpm test 84 文件 / 773 用例全过；pnpm build:renderer 通过（未跑 `pnpm build`，避免删除正在被 dev 会话读取的 `dist-electron/runtime/rpc-entry.js`）。
- 未做：过程里 `text` 类型（中间说明段落）仍不裁剪；流式进行中的当前思考仍全文显示、结束后才收成 2 行；折叠摘要 `flow.summary` 文案偏长。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：会话消息列表窗口化（virtua）——「运行中滚动卡」（20:15，Asia/Shanghai）

- 背景：用户反馈「滚动还是有性能问题」，问下来是**运行中**滚动卡（「暂停运行再滚动就还好」），并要求参考 `~/Downloads/codeg-main`；用户明确选择「按 codeg-main 引入 virtua」。
- 先量后改（避免大改错方向）：用真实会话 JSONL 量 App 每次渲染的派生计算（`groupConversation` / `recoverableFailStreaks` / `turnAnchors` / `sessionTools` / `sessionTerminals` / `mentionedFiles` / `collectTodos` / `collectProgressTasks` / `collectWorkingFiles`），最大会话（51MB、182 条消息）合计约 0.6ms/帧，**不是**瓶颈。瓶颈是每帧 `groups.map` 把整棵消息列表（全部历史轮 + 当前轮）重新创建元素并交给 React 遍历提交，成本随历史轮数线性增长，运行中与滚动抢主线程。自建滚动探针（合成 40–200 轮、长思考流式、程序化上下滚动）合成数据下都是 60fps 且 0 长任务，测不出差异，用户据此叫停探针路线，直接落地窗口化。
- 改动：
  - 新增 `src/renderer/message-list.tsx`：`MessageList` 用 virtua `Virtualizer`（`data` + 函数 children），**只有进入视口（含 `bufferSize` 1200 缓冲）的条目才构造元素与 DOM**；`.messages` 容器仍挂 `useFollowScroll` 的 `contentRef`（高度变化与锚点查找都在它上面）；对外 `scrollToAnchor`（锚点→索引→`scrollToIndex`，再逐帧按真实 DOM 位置校正到稳定后回调 `onSettled`）与 `anchorAt`（按 `getItemOffset` 找当前轮）。
  - `App.tsx`：`groups.map` 全量渲染改为条目描述数组（用户轮带 `anchor`），等待中与确认卡片也作为条目；`.messages` / `has-progress` 交给 MessageList；轮次导航改 `onJump` → `scrollToAnchor(id, { onSettled: follow.reanchor })`。
  - `ui.tsx`：`TurnNav` 新增可选 `onJump`（窗口化后目标条目常常没挂载，`scrollIntoView` 找不到节点）；`visibleTurn` 只在已挂载锚点里取（早期轮次不在 DOM 里）。
  - `use-follow-scroll.ts`：抽出 `measureAnchor`、新增 `reanchor`（程序化跳转后重新取样锚点，避免按跳转前的锚点把跳转拉回去）；scroll 处理器改为「跟随中位置被动变化就拉回底部」——窗口化后滚动会不断测量新进入视口的条目，虚拟列表为保持内容位置会反方向微调 `scrollTop`（几十到几百像素），原来会被当成「用户离开底部」（阈值 32px），结果停在离底部一截且不再自愈。用户主动滚动仍先经 `intent()` 关闭跟随，不会抢滚动。
  - `styles.css`：`.messages` 纵向内边距交给首/尾条目（`padding: 0 28px 20px` + `.message-item.first` / `.last`）；`.message-item { display: flow-root }` 防 `.turn` 的 margin 塌陷出条目导致测量偏小、条目重叠；`.messages > div { pointer-events: auto !important }`——virtua 在自己容器上写 `pointer-events: none`（该属性可继承），不修的话消息不可点、不可选、复制按钮与链接全失效；`.turn:last-child` 改为 `.message-item.last .turn`（否则会命中每一条，轮次间距从 22px 掉到 8px）。
  - 依赖：新增 `virtua@^0.51.2`。
- 回归测试：新增真实 Electron 探针 `scripts/fixtures/message-list.{html,tsx}` + `scripts/message-list-smoke.ts`（入口 `scripts/message-list-smoke-main.ts`，接进 `scripts/test-browser.mjs`，可 `TACODE_SMOKE_ONLY=message-list` 单跑）。断言：150 轮只挂载十几条；条目按序不重叠且间距 22px；底部留白 20px；指针事件命中内容且可选中；从底部上滑后跳转最早一轮贴顶、400ms 后仍不被拉回；停在底部追加内容持续跟随；`anchorAt` 返回当前轮。连续多次跑通。
- 验证：`pnpm typecheck` 通过；`pnpm test` 84 文件 / 773 用例全过；`pnpm build:renderer` 通过；`TACODE_SMOKE_ONLY=message-list node scripts/test-browser.mjs` 多次通过。用 `git stash` 对比确认 `pnpm test:browser` 里 workbench 的 sidebar 阶段失败是**既有问题**（stash 后同样失败），与本次改动无关。
- 未做/未验证：真实会话体感需用户自测；会话位置恢复会落到锚定的那一轮而非精确像素；页内查找只能找到已挂载内容。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：去掉落字整形 + markdown 换 Streamdown（对齐 codeg-main 的流式观感）（20:50，Asia/Shanghai）

- 缘起：用户反馈「出字卡卡的」，并要求先看 codeg-main 怎么做到「非常丝滑」。读完后确认 codeg 的丝滑来自两件事，用户选定都照做：**完全不做打字机整形** + **引 `streamdown`**（增量解析），放弃「字符出现均匀」、优先「整页不顿挫」。
- codeg 侧的事实（可核对）：全仓没有 typewriter / 字符间隔 / 平滑落字这类实现；后端 `src-tauri/src/acp/session_state.rs::append_text_delta` 增量追加文本，前端直接渲染；三处 live 内容都用 `<Streamdown mode={isStreaming ? "streaming" : "static"} parseIncompleteMarkdown>`（`ai-elements/reasoning.tsx:272`、`message/content-parts-renderer.tsx:2257`），其注释写明 `static` 每次整段重解析，120 个 delta 的流式实测约 2.9 倍慢且越长越糟；重引擎（shiki/katex/mermaid）按语法按需加载；代码块先出 raw tokens 再异步升级。
- TACode 侧的问题（本轮改掉）：`nextStreamText` 的 `elapsed` 取自「本轮动画起点」（`queuedAt` 只在追平时清空），所以流式持续超过 160ms 之后**每次落字都直接跳到全文最新**，表现出来就是「停一个 interval（长文本 120ms）、哗一下倒出一大段」；而且每次落字都整段跑 `closeOpenFences`/`repairMarkdownTables`/`compactFencedCode`/`stripEmptyMarkdown` + react-markdown 整段解析 + 整树 diff，成本 ∝ 累积长度。
- 改动：
  - `ui.tsx` 的 `Markdown` 改用 `streamdown`：`mode={streaming ? "streaming" : "static"}`、`parseIncompleteMarkdown={streaming}`、`controls={false}`（关掉它自带的代码块/表格工具条，那些控件用 Tailwind 类排版，本仓库是纯 CSS）；插件按它的约定拼 `[...Object.values(defaultRemarkPlugins), remarkMath]` / `[...Object.values(defaultRehypePlugins), rehypeKatex]`（**只传自己的插件会顶掉默认的 gfm，表格会退化成段落**，实测确认）；整段预处理只在定稿（static）时跑，流式中不做任何全文扫描。
  - `MARKDOWN_COMPONENTS` 补三个覆盖，避免丢掉 Tailwind 提供的视觉：`strong`（它默认渲染成 `<span class="font-semibold">`，没有 Tailwind 就不加粗）、`img`（它默认包一层带下载/放大控件的外层）、`a`（它默认渲染成 `<button data-streamdown="link">` 走自带安全弹层；恢复普通 `<a>`，外链仍由主进程 `will-navigate` / `setWindowOpenHandler` 交给系统浏览器）。`pre`/`code`/`table`/`th`/`td` 沿用原有实现（`pre` 覆盖生效，代码块仍走我们的 CodeBlock 与 shiki）。
  - 删除落字动画器：`stream-text.ts`、`use-stream-text.ts`、`stream-text.test.ts`；`execution-flow.tsx` 直接渲染 `item.text`，去掉 `displayed`/`pendingText`（以及自动收起里对 `pendingText` 的判断）；`stream-scheduler.test.ts` 去掉 `stream text` 这组用例。
- 成本量级（用 streamdown 包内 API 量，仅作选型依据）：`marked` 的 `Lexer.lex`（Streamdown 每次渲染的整段切块）0.40ms@6.5k、0.81ms@21k、2.40ms@64k、3.26ms@96k；Streamdown **static 整段**渲染 23.7ms@6.5k、43.7ms@21k、117.6ms@64k、161.3ms@96k —— 所以必须走 streaming 模式（只重解析尾部块）。
- 验证到哪一步：`npx tsc --noEmit` 通过；`pnpm test` 83 文件 / 763 用例通过（少掉的 10 条是被删除的落字动画器用例）。**流式观感与性能由用户自测**（本轮明确要求不再跑探针）。
- 未做/未验证：真实会话下的观感、static 定稿那一次整段解析（长思考定稿时会有一次约百毫秒量级的解析，与 codeg 同）；`CodeBlock` 仍是同步分词（80ms 节流），codeg 那种「raw tokens 先出、异步高亮升级」没做；同帧多条 `message_update` 合并成「每条消息只应用最后一个快照」没做；`react-markdown` / `remark-gfm` / `rehype-raw` 现在已无引用（依赖未移除）。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：流式落字路径分段渲染（每帧成本与累积文本解耦）（22:20，Asia/Shanghai）

- 缘起：用户质疑「探针流畅、真实使用却卡」这条既有结论。逐条核对后确认探针与真实使用的四层差距：探针走生产构建、只渲染消息列表、文本 5–12k，而真实使用是 dev React + StrictMode、外壳 + 列表、单条思考最长 93,613 字符。
- 先量（新增 dev 探针 `scripts/fixtures/stream-live-text.{html,tsx}`：`flushSync` 同步提交 + 读 `offsetHeight` 强制布局，React 与布局分开计时；`scripts/build-live-text-fixture.mjs` 出生产版本做对照。未接进 CI，纯测量）：
  - 方法前提：60fps 的帧间隔会把 16ms 以内的开销全部抹平（90k 文本下每帧 5ms 与 0.5ms 的帧间隔完全一样），所以必须用同步提交计时。
  - dev：4k 文本 1.7ms/帧 → 30k 2.6ms → 90k 7.2ms（p95 11.9、max 17.5）；90k 且每帧 48 字时 8.2ms。
  - 生产：同样场景 90k 只有 2.5ms（dev 约为生产的 2.9 倍，来源是 StrictMode 双跑 + dev 校验）。
  - 布局成本可忽略（90k 下 0.1–0.3ms）；开销几乎全在 React 侧：整段分块 `parseMarkdownIntoBlocks` 1.9ms@90k、`remend` 0.7ms@90k，其余是为 600+ 个块建元素与对账。
- 真实内容形状（新增 `scripts/measure-session-shape.mjs`）：最长思考 93,613 字符 / 3,192 换行，但被空行切成 848 块，最大块 1,934、p90 236；另有一条正文 79,221 字符。所以「流式中只有尾部在变」是事实，不是近似。
- 改：
  - 新增 `src/renderer/stream-blocks.ts`：`createStreamSegments` 按**块边界**把文本聚合成约 1,200 字符的段；分块本身也增量（只重算「倒数两块 + 新内容」窗口，用公共前缀判断是否追加）；只对最后一段 `remend`（已定稿的段是完整 markdown，本来就不需要补）。
  - `ui.tsx` 的 `Markdown`：流式时传 `parseMarkdownIntoBlocksFn` 走分段、`parseIncompleteMarkdown={false}`；定稿仍走 Streamdown 默认整段分块 + 既有静态修复，最终 DOM 与分块语义不变。
  - `remend` 由传递依赖提升为直接依赖（现在直接调用它）。
  - 效果：每帧成本从 ∝ 累积文本 变成 ∝ 最后一段，历史越长省得越多。
- 验证：
  - 探针复测（同场景、同帧率、同内容）：dev 90k 7.2→2.4ms p50（p95 11.9→4.1、max 17.5→12.8）；90k/帧48字 8.2→3.5ms；生产 90k 2.5→0.5ms；4k 场景基本不变（1.7→1.7 / 0.4→0.3）。
  - 渲染等价：新旧构建渲染同一段 60k 文本，元素直方图完全一致（P=202、LI=29、代码块 18、`span.code-line-plain` 37、行内 span 数量一致），抽样段落的 `innerHTML` 逐字节一致；新增的只是块之间的空白文本节点（不产生行盒）。
  - `src/renderer/stream-blocks.test.ts` 8 条：段边界始终落在 Streamdown 自己的块边界上（逐 token 追加 + 400 步随机追加，覆盖围栏/表格/`$$`/HTML）、非追加时重置、文本未变时返回缓存、只有尾段被 remend。
  - `pnpm typecheck` 通过；`pnpm test` 84 文件 / 771 用例通过。
  - `TACODE_SMOKE_ONLY=message-list node scripts/test-browser.mjs` 连跑 6 次，2 次在「跳转后首个条目落在视口顶部」断言失败（-225/-238）。把分段临时去掉（其余不动）后同样复现同一条失败（-225.5），确认是这条 smoke 既有的偶发竞态，与本次改动无关。
- 未做：外壳每帧重渲染（`SidebarNav` / `Chat` / `PromptBar` / `WorkbenchPanels` 都没有 memo，App 里传给它们的元素树也没 `useMemo` 稳住）仍未处理，也没有量过它的成本——新探针只覆盖会话区，外壳要另建 fixture 或改成 `useSyncExternalStore` + store 之后再量。同帧多条 `message_update` 合并成「每条消息只应用最后一个快照」仍未做。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：探针改成可看版 + 修代码块流式不跟随（22:35，Asia/Shanghai）

- 缘起：用户要求「亲眼看到」探针，并要求真流式与跟随。看的过程里发现两个真问题。
- 探针改成可视化（`scripts/fixtures/stream-live-text.tsx` 重写）：
  - 顶部读数条实时显示：路径 / 累积字数 / 帧间隔 p50·p95·最长（按 p95 变色）/ React 提交 p50·p95 / 长帧数（>20ms）/ 跟随状态与距底像素。
  - 控制栏：开始·停止流式、跑对照测量、路径下拉（新·旧，可流式中途切换——文本不变，所以是同一累积长度下的直接对比）、起始字数 4k/30k/90k、每帧字数 16/48、跟随底部开关。
  - 下方表格落对照测量结果（4k/30k/90k × 16/48 字，新旧各一遍）。
  - 量化仍用 `flushSync` 同步提交 + 强制布局（60fps 帧间隔看不出 16ms 以内的差别）；观感用 rAF 间隔，两者分开。
  - `ui.tsx` 导出 `MARKDOWN_COMPONENTS` / `MARKDOWN_REMARK_PLUGINS` / `MARKDOWN_REHYPE_PLUGINS`，让探针里的「旧路径」用完全相同的渲染管线（只有分块策略不同）。探针未接进 CI。
- 修一：跟随写在 rAF 里、位于 React 提交之前，读到的是上一帧的 `scrollHeight`，永远差一截。改为 `useLayoutEffect`（提交后、绘制前）写 `scrollTop`。
- 修二（真实组件缺陷，`src/renderer/codeblock.tsx`）：代码区有 `max-height: 280px` + 内部滚动，而流式时没人滚它——新行全部落在块的内部滚动区之外，外层容器因高度被上限固定也不增长，于是「代码块内容不跟随」。改为：
  - 只在内容**在增长**且用户没有主动滚上去时，把块内 `scrollTop` 跟到底部；
  - 用 `selfScroll` 标记区分自己的写入与用户滚动（滚离底部即停止跟随，滚回底部自动恢复）；
  - 挂载时就已完整且超高的代码块不受影响（不动，保持从顶部阅读）。三条行为都在真实浏览器里验过：流式中贴底 0px、上滚后不被拉回（305px）、滚回底部恢复（0px）。
- 探针内容也修了两处失真：可见流式改成每帧断行（否则尾部永远卡在一个未闭合围栏里，看起来整段都在代码块内）、生成的代码块加长到 30 行（原来 3 行撑不过 280px，测不到块内跟随）；流式不再 900 帧自动停，改成 25 万字上限。
- 复测（同一页面同一段文本，只有分块策略不同）：
  - 4k/帧16字：旧 1.7ms → 新 2.0ms（p95 3.8 → 2.4）
  - 30k/帧16字：旧 2.5 → 新 2.2
  - 90k/帧16字：旧 5.7 → 新 2.6（p95 6.5 → 4.5）
  - 90k/帧48字：旧 6.4 → 新 3.0（p95 11.4 → 3.7）
  - 结论不变：省下来的正是「∝ 累积文本」的那部分；小文本上新路径有约 0.3ms 的分段开销，属噪声量级。
- 验证：`pnpm typecheck` 通过；`pnpm test` 84 文件 / 771 用例通过。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：为什么探针比真实使用顺——逐层排除 + 高亮节流修复（22:42，Asia/Shanghai）

- 背景：用户追问「探针里很顺，真实运行完全不是一个感觉」，并要求找出原因。
- 先作废一条无效测量：上一轮的「跟随开/关 × 新/旧」四格是在累积只有 7k 文本时跑的（下拉框没按预期生效），数字不能当结论。
- 逐层排除（都不需要真实会话）：
  - 事件摄入（`src/renderer/conversation.ts` 的 `applyAgentEvent`，每帧把这一帧收到的事件逐条应用；`message_update` 带整条消息快照，所以每次都重解析累积文本）：90k 文本下 1 条 0.224ms、同帧 4 条 0.870ms；30k 下 0.026/0.302ms。→ 不是主因。
  - 渲染前派生计算：`groupConversation` / `buildTurnPresentation` 在 4k/30k/90k 下 p50 都是 0.000–0.001ms。→ 不是主因。
- 发现并修复一个真实缺陷：`useShikiTokens`（`read_file` 详情、文件抽屉用的 Shiki token hook）**没有节流**，代码一变就同步整段分词。实测单次同步分词：5k=6.4ms / 20k=23.7ms / 50k=58.5ms / 100k=117.8ms。展开中的 `read_file` 行在流式期间会每帧重算一次，单帧即可被拖到几十毫秒。改：与 `CodeBlock` 同样先判节流（120ms）再分词，一次性变化（打开文件）仍立即出结果；`latest` ref 保证延迟到期时用的是最新代码。
- 探针里探不到的仍是**外壳**（`SidebarNav` / `Chat` / `PromptBar` / `WorkbenchPanels` 都没 memo，App 每帧重建它们的元素树，右面板里的 webview/终端/子代理面板也在内）与真实滚动机制（virtua 测量 + `useFollowScroll`）。这两项目前无数字，是「真实使用更差」唯一剩下的解释方向。
- 为了量真实运行时，新增 `pnpm dev:attach`：vite 已在 5177 时再开一个带 `--remote-debugging-port=9222` 的 Electron 窗口，可用 CDP 抓真实会话的 CPU profile 按函数归因，不需要改业务代码。
- 验证：`pnpm typecheck` 通过；`pnpm test` 84 文件 / 771 用例通过（临时 benchmark 文件已删）。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：真实 dev 窗口的 CPU/Blink 采样：主因在事件摄入，不在落字（22:50，Asia/Shanghai）

- 手段：新增 `pnpm dev:attach`（vite 已在 5177 时另开一个带 `--remote-debugging-port=9222` 的 Electron 窗口）+ `scripts/profile-dev-app.mjs`（CDP：CPU profile 按函数自耗时归因、rAF 帧间隔、长任务、Blink tracing 阶段归因、`Performance.getMetrics` 前后差值、DOM 概况）。不改业务代码。
- 两次采样（用户窗口里真实流式）：
  - 25s：`idle` 81.8%，JS 自耗时 4.5s（≈180ms/s ≈ 3ms/帧）；帧间隔 p50/p95/最长 = 16.7/18.3/59.2ms；>20ms 帧 42 个、长任务 5 个。最大单项 `collapseThinking` 1254ms。
  - 15s（期间文本没增长）：`mergeAssistant` 1693ms、`collapseThinking` 190ms；`conversation.ts` 占 JS 自耗时 12.8%（另一轮 19.9%）。
  - Blink：`LayoutDuration` 20ms、`RecalcStyleDuration` 15ms、`LayoutCount` 50（20s 内）→ **排版/绘制可以忽略**；`TaskDuration` 6.9s/20s（约 35% 主线程占用），其中 `ScriptDuration` 5.0s；GC 相关（`V8.GC_*` + MajorGC/MinorGC）合计约 1.3s/20s → 分配压力明显。
- 结论：真实使用的每帧成本主要不在 markdown 落字（`ui.tsx` / `execution-flow.tsx` 都在 0.1–0.5% 量级），而在**事件摄入**——每条 `message_update` 都带完整快照，`messageFromRecord`（含 `splitThinkTags` 全文正则）与 `mergeAssistant → collapseThinking` 各扫一遍全文，其中 `collapseThinking` 是「按空行切块 + 两两前缀比较」的平方级实现。
- 改（`conversation.ts`）：`collapseThinking` 先用等值表命中、查不到再按原语义线性扫。前缀互斥的不变量保证等值命中唯一，语义与旧实现逐字节一致；追加式快照从 O(块数²) 降到 O(块数)。新增 `collapse-thinking.test.ts`：3000 组随机文档、600 组追加式快照与旧实现逐字节比对 + 前缀互斥不变量断言。基准（追加一次快照）：30k/670 块 7.3→3.7ms；93k/2046 块 49.4→24.1ms。
- 剩余（已量到但未改）：这 24ms 里已没有平方项，主要是「每条事件都把整段文本重新 split + join」的线性成本。真正的解法是别每条事件整段重规范化（哈希/引用缓存块列表，或按增量尾部合并）。另有一条语义边界：现实现对「同一文本内重复块」会静默去重，改增量方案会变成保留重复块（更忠实，但是可见变化），需要拍板。
- 验证：`pnpm typecheck` 通过；`pnpm test` 85 文件 / 775 用例通过。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：折叠那一帧的全段静态渲染（用户报告的「收起之后卡卡的」）（22:56，Asia/Shanghai）

- 用户给的两个线索：滚动不顺、思考结束后收起时卡。按帧采样（`scripts/profile-dev-app.mjs --watch --scroll`：等流式开始 → 采样 + 注入真实滚轮手势 → 捕折叠瞬间）：
  - 滚动：433 个滚动帧（流式中）p50 16.6 / p95 17.8 / 最长 23.4ms，>20ms 仅 3 帧 → **滚动侧没有明显问题**。
  - 该次运行的思考只写到 2,116 字符，折叠只花约 14ms，所以那次现场没能体现用户说的卡。
- 单独量「折叠那一帧」（浏览器探针新增 `staticRender`：对 `<Markdown streaming={false}>` 做 `flushSync` 提交 + 强制布局）：
  - 4.8k 字符：React 提交 14.2ms / 布局 1ms
  - 30k：47.6ms / 3.6ms
  - 93k：**127.5ms**（另一次 161.7ms）/ 9ms
- 根因：思考条目一旦不再是「当前项」，`Markdown` 就从流式切到 `streaming={false}`，于是对**整段**文本跑 `repairMarkdownTables` + `compactFencedCode` + `stripEmptyMarkdown` 三个全文预处理器，再做 Streamdown 静态整段解析——而折叠态用 `-webkit-line-clamp: 2` 只显示前两行，整段渲染是白付。回合结束时 `live=false`，所有未被冻结的条目都会走这一遍，所以「收起时」最容易看到顿一下。
- 改（`execution-flow.tsx`）：新增 `CLIPPED_PREVIEW_CHARS = 800`；折叠态（`!active && !expanded`）只渲染开头 800 字符，展开时仍渲染全文。可见内容不变（clamp 取的就是开头两行），溢出判定仍成立（按钮照常出现）；「全选复制」在折叠态只能拿到预览（要全文需展开，这点是有意取舍）。
- 效果：折叠那一帧 93k 从 161.7ms → **3.3ms**（布局 8.9 → 0.2ms）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 85 文件 / 775 用例通过。
- 仍待处理（同一条线上、这次没改）：
  - 可见正文（`FlowText`）定稿时同样要整段静态渲染：正文一般 600–9k 字符（约 15–25ms），但量到过一条 79,221 字符的正文；修法是让定稿也走分段 + 逐段修复，使没被修复改动的段直接 memo 命中。
  - `collapseThinking` 每条事件仍要整段 split + join（93k/2046 块 ≈ 24ms/次，已无平方项）；真正省下来要缓存块列表或按尾部增量合并，且会带来「同文本内重复块不再被静默去重」的可见变化，待拍板。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：生成中「滚动条抖动」（用户报告）→ 关掉滚动锚定 + 近距直接贴底（23:06，Asia/Shanghai）

- 用户描述：出字时滚动条在抖动，并指出 codeg-main 在生成时滚动很丝滑。
- 对比 codeg（`~/Downloads/codeg-main`）：滚动容器 `src/components/message/virtualized-message-thread.tsx:291` 明确带 `[overflow-anchor:none]`，跟随统一交给 `use-stick-to-bottom`（单一写入者）。我们全仓 `overflow-anchor` 零命中，同时有三个写入者改同一个 `scrollTop`：`use-follow-scroll` 的 rAF 缓动、virtua 为「保持内容位置」做的位移补偿、以及浏览器的滚动锚定。
- 按帧探针（新增 `scripts/scroll-jitter.mjs`：等流式开始 → 按帧记 `scrollTop`/`scrollHeight` → 中途切 `overflow-anchor` → 前后对比；并用 `Element.prototype.scrollTop` 的 setter 挂钩区分「JS 写入」与「浏览器锚定」）：
  - 默认锚定的一段（14s / 835 帧，内容增长 1304px）：出现 1 次逆向移动 1121px；距底平均 6.5px，>2px 的帧 139 个 → 跟随一直在小幅追赶。
  - 打开 `overflow-anchor: none` 后的一段（839 帧）：0 次逆向移动、0 次 JS 回退写入、距底平均 0.1px。
  - 第二段之所以近乎零回退，一部分原因是内联属性在之前的 A/B 中已经留在页面上（也说明这个属性确实是回退的主要来源之一）。
- 改：
  - `styles.css`：`.conversation` 加 `overflow-anchor: none`（注释写明理由与 codeg 的先例）。
  - `use-follow-scroll.ts`：新增 `SNAP_DISTANCE = 96`——距离底部 96px 以内直接贴底（增长驱动的情形总是落在这一档），更远的跳转/「回到最新」仍走缓动滑行。这样流式期间不再每帧落后几像素地追。
- 验证：`pnpm typecheck` 通过；`pnpm test` 85 文件 / 775 用例通过（含既有的 `nextScrollTop` 用例）。
- 待验证：真实窗口里再跑一次生成，用 `node scripts/scroll-jitter.mjs --wait` 复测「逆向移动次数 / 距底像素」；若仍有偶发大回退，下一步是查 virtua 在条目高度变化时的补偿（可能需要给它稳定的估算高度，或在跟随中屏蔽它的反向调整）。
- 未提交/发布，未改 AGENTS.md。

## 2026-09-11：滚动抖动探针自身的三处缺陷（结论作废与修正）（23:12，Asia/Shanghai）

- 记录一下，避免以后拿这几组数字当证据：
  1. 探针做反向对照时把 `overflow-anchor: auto` 内联写在滚动容器上，之后没有清除；内联样式盖掉了 `styles.css` 里的修复，导致后续两次「测修复后状态」实际测的是未修复状态。已清掉，`--clean` 可核对计算样式（现在 = `none`）。
  2. 采样器模板里写了 `.split("\n")`，反斜杠在模板字符串里被解析成真换行，注入的表达式直接 `SyntaxError`，`Runtime.evaluate` 静默返回 undefined——最近两轮探针因此采到 0 帧。已改为双反斜杠，并在 `evaluate` 里把 `exceptionDetails` 打出来。
  3. 每次注入前先停掉上一轮的 rAF 循环，并在主流程开头清掉内联覆盖，避免状态残留。
- 因此可采信的滚动数据只有最早那次反向对照：默认锚定下 14s/835 帧出现 1 次 1121px 逆向移动、距底平均 6.5px（139 帧 >2px）；`overflow-anchor: none` 下 839 帧 0 次回退。两处修复（`overflow-anchor: none` + `SNAP_DISTANCE = 96` 近距贴底）仍然保留，但「修复后真实生成是否完全不抖」还需要一次干净测量。
- 另外那次采到的 9618px 大回退已定位为**内容变矮被夹回**（折叠/过程区收起，高度 -7222px），不是出字期间的抖动；新版探针把「出字增长段」和「内容变矮帧」分开统计。
