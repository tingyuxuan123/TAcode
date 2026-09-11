import { randomUUID } from "node:crypto";
import { visibleUserText } from "../shared/vision-api";
import { getToolSetPolicy, setToolContribution } from "../shared/tool-set";
import { browserRoutingBlock } from "./browser-routing";
import {
  browserGuidanceFor,
  browserPlanModeBlock,
  BROWSER_TOOLS,
  normalizeBrowserParams,
  stripBrowserGuidance,
  type BrowserParams,
  type BrowserResponse,
  type BrowserToolResult,
} from "../shared/browser-tools";

/** 贡献所有权名（同一扩展重复加载会覆盖而不是叠加）。 */
export const BROWSER_TOOL_OWNER = "browser";

interface ExtensionAPI {
  registerTool(tool: Record<string, unknown>): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: string, handler: (event: { systemPrompt?: string; prompt?: string; toolName?: string; input?: { cmd?: string; command?: string } }) => unknown): void;
}

/** Private Node IPC, inherited only by the desktop Agent worker; no HTTP port or credential file. */
export function requestBrowser(tool: string, params: BrowserParams, signal?: AbortSignal): Promise<BrowserToolResult> {
  // 先归一化再发送：空串可选参数（如 tabId:""）按“未提供”处理，主进程收到的即是最终参数。
  const input = normalizeBrowserParams(tool, params);
  if (!process.send || !process.connected) return Promise.reject(new Error("浏览器未连接桌面宿主，请从 TACode 桌面重新启动会话。"));
  if (signal?.aborted) return Promise.reject(new Error("浏览器操作已取消"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: BrowserToolResult) => {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => {
      if (process.connected) process.send?.({ type: "tacode:browser:cancel", id }, () => {});
    };
    const onAbort = () => { cancel(); finish(new Error("浏览器操作已取消")); };
    const onDisconnect = () => finish(new Error("浏览器宿主连接已关闭"));
    const onMessage = (message: unknown) => {
      const response = message as BrowserResponse | null;
      if (response?.type !== "tacode:browser:response" || response.id !== id) return;
      finish(response.error ? new Error(response.error) : undefined, response.result);
    };
    const timer = setTimeout(() => {
      cancel();
      finish(new Error("浏览器操作超时。请先观察页面确认状态，避免重复提交。"));
    }, 45000);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    process.send!({ type: "tacode:browser:request", id, tool, params: input }, (error) => { if (error) finish(error); });
  });
}

export default function browserExtension(pi: ExtensionAPI) {
  // CLI/delegate workers without a desktop IPC channel must not advertise unusable tools.
  if (!process.send) return;
  // 只声明本扩展贡献的工具名，激活集交给 shared/tool-set 统一计算：
  // 这里曾经用 setActiveTools([...getActiveTools(), ...browser]) 自己 union，
  // 与 runtime 的 setActiveTools(options.activeTools) 互相覆盖，谁最后执行谁赢。
  //
  // planAllowed 为 true：计划模式下浏览器工具**仍然存在**（否则调用就是 `Tool … not found`），
  // 交互类操作改由 tool_call 钩子在调用时拒绝并给出原因（对齐 Proma 的调用期 deny）。
  setToolContribution(BROWSER_TOOL_OWNER, { names: BROWSER_TOOLS.map((tool) => tool.name), planAllowed: true });
  let currentPrompt = "";
  pi.on("tool_call", (event) =>
    browserRoutingBlock(event.toolName, event.input, currentPrompt) ??
    (getToolSetPolicy()?.permission === "plan" ? browserPlanModeBlock(event.toolName, event.input) : undefined),
  );
  for (const definition of BROWSER_TOOLS) {
    pi.registerTool({
      ...definition,
      promptSnippet: definition.description,
      async execute(_id: string, params: BrowserParams, signal?: AbortSignal, _update?: unknown, ctx?: { model?: { input?: string[] } }) {
        if (definition.name === "browser_screenshot" && !ctx?.model?.input?.includes("image")) {
          throw new Error("当前模型不支持图片输入，请使用 browser_observe/browser_extract 读取页面，或切换视觉模型。 ");
        }
        return requestBrowser(definition.name, params, signal);
      },
    });
  }
  pi.on("before_agent_start", (event) => {
    currentPrompt = visibleUserText(event.prompt ?? "");
    // 系统提示只描述本轮**真正激活**的 browser_* 工具；计划模式额外说明只读限制。
    const guidance = browserGuidanceFor({
      activeTools: new Set(pi.getActiveTools()),
      planMode: getToolSetPolicy()?.permission === "plan",
    });
    const base = stripBrowserGuidance(event.systemPrompt ?? "").trimEnd();
    return { systemPrompt: `${base}\n\n${guidance}` };
  });
}
