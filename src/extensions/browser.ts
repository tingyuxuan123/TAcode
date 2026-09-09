import { randomUUID } from "node:crypto";
import { visibleUserText } from "../shared/vision-api";
import { browserRoutingBlock } from "./browser-routing";
import { BROWSER_GUIDANCE, BROWSER_TOOLS, validateBrowserParams, type BrowserParams, type BrowserResponse, type BrowserToolResult } from "../shared/browser-tools";

interface ExtensionAPI {
  registerTool(tool: Record<string, unknown>): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: string, handler: (event: { systemPrompt?: string; prompt?: string; toolName?: string; input?: { cmd?: string; command?: string } }) => unknown): void;
}

/** Private Node IPC, inherited only by the desktop Agent worker; no HTTP port or credential file. */
export function requestBrowser(tool: string, params: BrowserParams, signal?: AbortSignal): Promise<BrowserToolResult> {
  validateBrowserParams(tool, params);
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
      if (process.connected) process.send?.({ type: "tether:browser:cancel", id }, () => {});
    };
    const onAbort = () => { cancel(); finish(new Error("浏览器操作已取消")); };
    const onDisconnect = () => finish(new Error("浏览器宿主连接已关闭"));
    const onMessage = (message: unknown) => {
      const response = message as BrowserResponse | null;
      if (response?.type !== "tether:browser:response" || response.id !== id) return;
      finish(response.error ? new Error(response.error) : undefined, response.result);
    };
    const timer = setTimeout(() => {
      cancel();
      finish(new Error("浏览器操作超时。请先观察页面确认状态，避免重复提交。"));
    }, 45000);
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    process.send!({ type: "tether:browser:request", id, tool, params }, (error) => { if (error) finish(error); });
  });
}

export default function browserExtension(pi: ExtensionAPI) {
  // CLI/delegate workers without a desktop IPC channel must not advertise unusable tools.
  if (!process.send) return;
  let currentPrompt = "";
  pi.on("tool_call", (event) => browserRoutingBlock(event.toolName, event.input, currentPrompt));
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
  const activate = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...BROWSER_TOOLS.map((tool) => tool.name)])]);
  pi.on("session_start", activate);
  pi.on("before_agent_start", (event) => {
    currentPrompt = visibleUserText(event.prompt ?? "");
    activate();
    return { systemPrompt: `${(event.systemPrompt ?? "").replace(BROWSER_GUIDANCE, "").trimEnd()}\n\n${BROWSER_GUIDANCE}` };
  });
}
