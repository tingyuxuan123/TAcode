# UX-11 多聊天面板回放

2026-09-13，本机 Electron 37，使用隔离临时目录、实际 App/preload 和生产构建。React DOM 使用 profiling 入口，计时包装只在测试构建注入。比较提交 `d18d584` 与 UX-11 工作区，先做一轮对照，再交替两轮，合计六次；没有模型或外网请求。

主会话及三个子会话各有 100 轮历史，各按目标 60 次/秒发送 180 个累积消息更新。三个子会话保持挂载，两个隐藏、一个可见。主输入框每 12 个更新通过 Electron 原生输入追加文字，测量调用至下一动画帧的耗时。原始数据和设备信息见 [ux-11-panel-measurements.json](ux-11-panel-measurements.json)。

| 指标（每轮结果取三轮中位数） | 改前 | 改后 |
| --- | ---: | ---: |
| 两个隐藏正文的 DOM 变化总数 | 726 | 0 |
| 两个隐藏子树累计 React render duration | 443.6 ms | 0.2 ms |
| App 子树累计 React render duration | 808.3 ms | 380.8 ms |
| 输入到下一帧的 p95 | 23.2 ms | 20.6 ms |
| 超过 50 ms 的主线程长任务 | 0 | 0 |

React 数字来自 Profiler 每次提交的 `actualDuration`，表示渲染计算，不是整段 DOM 提交或最终绘制耗时。隐藏 Profiler 边界仍可能随父树提交被调用，其渲染耗时已接近零；不能仅把回调次数当作实际重渲染次数。输入时延变化不大，本样本的主要收益是后台渲染减少。短回答回放没有暴露严重卡顿，不能据此外推到超长 Markdown 或低性能机器。

回放还验证了隐藏标签激活后最终正文完整，历史采用虚拟列表，审批立即可见、失败原因与完成状态保留。截图位于本任务 `ux-11/multiple-chat-panels.png`。普通侧边聊天复用同一消息存储和列表；单独验证了隐藏期间的更新在切回后完整显示。

复现：

```sh
TACODE_PANELS_SMOKE=1 TACODE_ACTIVITY_BASELINE=1 TACODE_ACTIVITY_BASELINE_REF=d18d584 TACODE_PANEL_REPORT=/tmp/panels-before.json node scripts/test-session-activity.mjs
TACODE_PANELS_SMOKE=1 TACODE_PANEL_REPORT=/tmp/panels-after.json node scripts/test-session-activity.mjs
```
