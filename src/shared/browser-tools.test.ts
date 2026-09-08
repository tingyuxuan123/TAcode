import { describe, expect, it } from "vitest";
import { validateBrowserParams } from "./browser-tools";

describe("browser command boundary", () => {
  it.each([
    ["browser_unknown", {}], ["browser_click", {}], ["browser_click", { ref: "" }],
    ["browser_click", { ref: "e1", webContentsId: 1 }],
    ["browser_wait_for", { kind: "text", value: "ready", timeoutMs: 999999 }],
    ["browser_find", {}], ["browser_dom", { selector: "#editor", action: "fill" }],
    ["browser_scroll", { position: "top", deltaY: 100 }],
    ["browser_click", { ref: "e1", waitKind: "text" }],
    ["browser_select_option", { ref: "e1", value: "CN", label: "中国" }],
  ])("rejects invalid %s input", (name, params) => expect(() => validateBrowserParams(name as string, params)).toThrow());
  it("allows empty fill text for clearing a field and valid click-and-wait", () => {
    expect(() => validateBrowserParams("browser_fill", { ref: "tab-e1", text: "" })).not.toThrow();
    expect(() => validateBrowserParams("browser_click", { ref: "tab-e2", waitKind: "text", waitValue: "成功" })).not.toThrow();
  });
});
