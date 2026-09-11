import { describe, expect, it } from "vitest";
import {
  BROWSER_TOOL_NAMES,
  browserGuidanceFor,
  browserPlanModeBlock,
  normalizeBrowserParams,
  stripBrowserGuidance,
  validateBrowserParams,
} from "./browser-tools";

describe("browser command boundary", () => {
  it.each([
    ["browser_unknown", {}], ["browser_click", {}], ["browser_click", { ref: "" }],
    ["browser_click", { ref: "e1", webContentsId: 1 }],
    ["browser_wait_for", { kind: "text", value: "ready", timeoutMs: 999999 }],
    ["browser_find", {}], ["browser_dom", { selector: "#editor", action: "fill" }],
    ["browser_scroll", { position: "top", deltaY: 100 }],
    ["browser_click", { ref: "e1", waitKind: "text" }],
    ["browser_select_option", { ref: "e1", value: "CN", label: "中国" }],
    ["browser_navigate", {}], ["browser_navigate", { tabId: "", url: "  " }],
  ])("rejects invalid %s input", (name, params) => expect(() => validateBrowserParams(name as string, params)).toThrow());
  it("allows empty fill text for clearing a field and valid click-and-wait", () => {
    expect(() => validateBrowserParams("browser_fill", { ref: "tab-e1", text: "" })).not.toThrow();
    expect(() => validateBrowserParams("browser_click", { ref: "tab-e2", waitKind: "text", waitValue: "成功" })).not.toThrow();
  });
});

describe("browser params normalization", () => {
  // 真实故障：模型给可选参数补空串（tabId:""），旧校验直接判为非法，整次调用失败。
  it("drops blank optional params instead of failing the call", () => {
    expect(normalizeBrowserParams("browser_navigate", { tabId: "", url: "http://127.0.0.1:4173/pelican-bike.html" })).toEqual({
      url: "http://127.0.0.1:4173/pelican-bike.html",
    });
    expect(normalizeBrowserParams("browser_observe", { tabId: "   " })).toEqual({});
    expect(normalizeBrowserParams("browser_click", { ref: "tab-e1", waitKind: "", waitValue: "", timeoutMs: 250 })).toEqual({ ref: "tab-e1", timeoutMs: 250 });
  });
  it("keeps blank values that are meaningful", () => {
    expect(normalizeBrowserParams("browser_fill", { ref: "tab-e1", text: "" })).toEqual({ ref: "tab-e1", text: "" });
  });
  it("still rejects missing required params and unknown keys", () => {
    expect(() => normalizeBrowserParams("browser_click", { ref: "" })).toThrow("缺少参数：ref");
    expect(() => normalizeBrowserParams("browser_navigate", { tabId: "" })).toThrow("url 或 path");
    expect(() => normalizeBrowserParams("browser_observe", { tabId: "t1", webContentsId: 2 })).toThrow("不支持的参数");
  });
  it("accepts a workspace path as the navigate target", () => {
    expect(normalizeBrowserParams("browser_navigate", { path: "demo/index.html" })).toEqual({ path: "demo/index.html" });
  });
});

describe("plan 模式的浏览器限制（F3）", () => {
  it("只读观察放行", () => {
    for (const name of [
      "browser_observe",
      "browser_extract",
      "browser_screenshot",
      "browser_wait_for",
      "browser_scroll",
      "browser_list_tabs",
      "browser_select_tab",
    ]) {
      expect(browserPlanModeBlock(name, {})).toBeUndefined();
    }
  });

  it("本地预览放行，带 url 的导航拒绝", () => {
    expect(browserPlanModeBlock("browser_navigate", { path: "demo/index.html" })).toBeUndefined();
    const blocked = browserPlanModeBlock("browser_navigate", { url: "https://example.com" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("计划模式");
  });

  it("交互操作被拒绝，并给出可用清单与下一步", () => {
    for (const [name, params] of [
      ["browser_click", { ref: "e1" }],
      ["browser_fill", { ref: "e1", text: "x" }],
      ["browser_close_tab", { tabId: "t1" }],
      ["browser_new_tab", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const blocked = browserPlanModeBlock(name, params);
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("browser_observe");
      expect(blocked?.reason).toContain("/plan execute");
    }
  });

  it("非浏览器工具不受影响", () => {
    expect(browserPlanModeBlock("exec_command", { cmd: "ls" })).toBeUndefined();
    expect(browserPlanModeBlock(undefined, {})).toBeUndefined();
  });
});

describe("browserGuidanceFor（F4）", () => {
  const all = new Set(BROWSER_TOOL_NAMES);

  it("没有任何 browser 工具激活时只给「不可用」的诚实说明", () => {
    const text = browserGuidanceFor({ activeTools: new Set(["read_file"]) });
    expect(text).toContain("不可用");
    expect(text).not.toContain("browser_navigate({path");
  });

  it("只激活 navigate 时不再描述 click/fill 的流程", () => {
    const text = browserGuidanceFor({ activeTools: new Set(["browser_navigate", "browser_new_tab"]) });
    expect(text).toContain("browser_navigate({path");
    expect(text).not.toContain("select_option");
    expect(text).not.toContain("tabId 是具体网页标签");
  });

  it("计划模式追加只读限制说明", () => {
    const planned = browserGuidanceFor({ activeTools: all, planMode: true });
    expect(planned).toContain("当前是计划模式");
    expect(planned).toContain("browser_observe");
    expect(browserGuidanceFor({ activeTools: all, planMode: false })).not.toContain("当前是计划模式");
  });

  it("重新注入前只移除上一次的标记区间，保留其它扩展内容", () => {
    const other = "LANG: 中文";
    const injected = `base\n\n${other}\n\n${browserGuidanceFor({ activeTools: all })}`;
    expect(stripBrowserGuidance(injected)).toBe(`base\n\n${other}`);
    expect(stripBrowserGuidance("base")).toBe("base");
  });
});
