/**
 * `agent:command` 的壳层协议常量：主进程与 preload 共用。
 *
 * 背景：渲染层有一批 fire-and-forget 命令（abort / set_thinking_level / get_state
 * 等），它们自身已经 catch，但主进程如果直接 `throw`，Electron 仍会把每次
 * `ipcMain.handle` 拒绝打印到主进程终端：
 * `Error occurred in handler for 'agent:command': Error: No active agent session`。
 * 会话停止/重启的竞态窗口里，这些行只是噪声，掩盖真正的错误。
 *
 * 现在的约定：主进程在“无活动会话”时返回哨兵对象，preload 见到哨兵后还原成
 * 同样的 rejection。渲染层语义完全不变，主进程终端不再刷错误，主进程改为写一条
 * 本地诊断日志（可查、不刷屏）。
 *
 * RPC 请求语义契约（重要）：
 * - `prompt` 是“接收即返回”：worker 在 preflight 成功后立即应答，不等整轮生成结束。
 *   响应到达 ≠ 子代理已完成。任何需要“这一轮跑完”语义的调用方（委派完成判定、
 *   /plan execute、压缩后重发）都必须等待空闲原语 `AgentHost.waitForIdle()`
 *   （以 agent_start / agent_settled 事件驱动），再读取消息/状态。
 * - 归入 LONG_RUNNING_REQUESTS（agent-host.ts）只为放宽超时上限，不改变上述语义。
 * - 统一完成契约见 shared/delegation.ts 的 DELEGATION_COMPLETION_CONTRACT：
 *   “空闲后取最后一条带文本的 assistant 消息”。
 */

/** 无活动会话时对渲染层暴露的错误消息；主进程 AgentManager 与 preload 共用。 */
export const NO_ACTIVE_SESSION_MESSAGE = "No active agent session";

/** 主进程无活动会话时返回的哨兵键。 */
export const AGENT_NO_SESSION_KEY = "__tacodeNoSession";

export type AgentNoSessionResult = { [AGENT_NO_SESSION_KEY]: true };

/** 构造“无活动会话”哨兵。 */
export function agentNoSessionResult(): AgentNoSessionResult {
  return { [AGENT_NO_SESSION_KEY]: true };
}

/** 判断 IPC 返回值是否为“无活动会话”哨兵。 */
export function isAgentNoSessionResult(value: unknown): value is AgentNoSessionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[AGENT_NO_SESSION_KEY] === true
  );
}
