import { describe, expect, it } from "vitest";
import { normalizeBrowserParams, validateBrowserParams } from "./browser-tools";

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
