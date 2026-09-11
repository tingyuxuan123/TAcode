import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_TOOLS } from "../shared/browser-tools";
import { applyToolSet, computeActiveToolNames, resetToolSet, setToolSetPolicy } from "../shared/tool-set";
import { BROWSER_TOOL_OWNER } from "./browser";
import browserExtension from "./browser";

function browserToolNames(): string[] {
  return BROWSER_TOOLS.map((tool) => tool.name);
}

/**
 * 回归测试：浏览器工具的激活集必须由 shared/tool-set 计算，
 * 不能再由本扩展自己 union —— 那正是「生成中途切换权限后 browser_* 变 Tool not found」的成因。
 * 本次故障复盘见 src/shared/tool-set.ts 顶部注释。
 */

const originalSend = process.send;

function loadExtension(): { fire: (event: string, payload: unknown) => unknown; active: () => string[] } {
  // browser.ts 在没有桌面 IPC 通道时直接返回（CLI/委派 worker 不注册不可用工具）。
  (process as unknown as { send: unknown }).send = () => {};
  const handlers = new Map<string, (event: never) => unknown>();
  let active: string[] = [];
  const pi = {
    registerTool() {},
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
    on: (event: string, handler: (event: never) => unknown) => {
      handlers.set(event, handler);
    },
  };
  browserExtension(pi as unknown as Parameters<typeof browserExtension>[0]);
  // 模拟 runtime 在 session_start/turn_start 的应用：扩展只贡献，激活集由 tool-set 算。
  applyToolSet(pi);
  return { fire: (event, payload) => handlers.get(event)?.(payload as never), active: () => active };
}

beforeEach(() => {
  resetToolSet();
  setToolSetPolicy({
    permission: "auto",
    baseToolNames: ["read_file", "exec_command"],
    planAllowedToolNames: ["read_file", "exec_command"],
  });
});

afterEach(() => {
  (process as unknown as { send: unknown }).send = originalSend;
  resetToolSet();
});

describe("browser 扩展的工具集贡献", () => {
  it("注册贡献后，激活集包含 browser_*（与基础工具并存）", () => {
    loadExtension();
    const names = computeActiveToolNames() ?? [];
    expect(names).toContain("read_file");
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_list_tabs");
  });

  it("权限模式切到 full 后 browser_* 仍然在（故障回归）", () => {
    const pi = loadExtension();
    expect(pi.active()).toContain("browser_navigate");

    setToolSetPolicy({
      permission: "full",
      baseToolNames: ["read_file", "exec_command"],
      planAllowedToolNames: ["read_file", "exec_command"],
    });
    applyToolSet({
      getActiveTools: () => pi.active(),
      setActiveTools: (names) => {
        pi.active().splice(0, pi.active().length, ...names);
      },
    });
    expect(pi.active()).toContain("browser_navigate");
  });

  it("plan 模式下浏览器工具仍在激活集（交互由调用期拒绝，而不是让工具消失）", () => {
    loadExtension();
    setToolSetPolicy({
      permission: "plan",
      baseToolNames: ["read_file", "exec_command"],
      planAllowedToolNames: ["read_file", "exec_command"],
    });
    const names = computeActiveToolNames() ?? [];
    expect(names).toEqual(["read_file", "exec_command", ...browserToolNames(), "update_plan"]);
  });

  it("plan 模式的 tool_call 钩子：只读放行、交互拒绝并给出原因", () => {
    const pi = loadExtension();
    setToolSetPolicy({
      permission: "plan",
      baseToolNames: ["read_file"],
      planAllowedToolNames: ["read_file"],
    });
    expect(pi.fire("tool_call", { toolName: "browser_observe", input: {} })).toBeUndefined();
    expect(pi.fire("tool_call", { toolName: "browser_navigate", input: { path: "demo/index.html" } })).toBeUndefined();

    const click = pi.fire("tool_call", { toolName: "browser_click", input: { ref: "e1" } }) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(click?.block).toBe(true);
    expect(click?.reason).toContain("计划模式");
    expect(click?.reason).toContain("browser_observe");

    const navigate = pi.fire("tool_call", { toolName: "browser_navigate", input: { url: "https://example.com" } }) as
      | { block?: boolean }
      | undefined;
    expect(navigate?.block).toBe(true);
  });

  it("非 plan 模式下不触发只读限制", () => {
    const pi = loadExtension();
    expect(pi.fire("tool_call", { toolName: "browser_click", input: { ref: "e1" } })).toBeUndefined();
  });

  it("before_agent_start 注入的浏览器说明与实际激活工具一致", () => {
    const pi = loadExtension();
    const injected = pi.fire("before_agent_start", {
      prompt: "看一下页面",
      systemPrompt: "base",
    }) as { systemPrompt?: string };
    expect(injected.systemPrompt).toContain("## TACode 内置浏览器");
    expect(injected.systemPrompt).toContain("browser_navigate({path");

    // 第二轮重新注入不会重复堆叠
    const again = pi.fire("before_agent_start", {
      prompt: "再看一下",
      systemPrompt: injected.systemPrompt,
    }) as { systemPrompt?: string };
    expect(again.systemPrompt?.match(/## TACode 内置浏览器/g)).toHaveLength(1);
  });

  it("plan 模式下注入的说明包含只读限制（与实际激活集对齐）", () => {
    const pi = loadExtension();
    setToolSetPolicy({
      permission: "plan",
      baseToolNames: ["read_file"],
      planAllowedToolNames: ["read_file"],
    });
    const injected = pi.fire("before_agent_start", {
      prompt: "看一下页面",
      systemPrompt: "base",
    }) as { systemPrompt?: string };
    expect(injected.systemPrompt).toContain("当前是计划模式");
    expect(injected.systemPrompt).toContain("browser_observe");
    expect(injected.systemPrompt).toContain("browser_navigate({path");
  });

  it("没有桌面通道时不贡献工具（CLI/委派 worker）", () => {
    (process as unknown as { send: unknown }).send = undefined;
    browserExtension({
      registerTool() {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      on: () => {},
    } as Parameters<typeof browserExtension>[0]);
    expect(computeActiveToolNames()).toEqual(["read_file", "exec_command"]);
  });
});

it("贡献所有权名稳定（重复加载只覆盖不叠加）", () => {
  loadExtension();
  loadExtension();
  expect(BROWSER_TOOL_OWNER).toBe("browser");
  const names = computeActiveToolNames() ?? [];
  expect(names.filter((name) => name === "browser_navigate")).toHaveLength(1);
});
