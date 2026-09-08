import { describe, expect, it } from "vitest";
import { sidebarLayoutReducer } from "./sidebar-layout";

const expanded = { manualCollapsed: false, autoCollapsed: false };

describe("自动侧栏布局", () => {
  it("自动收起保留原来的手动展开偏好", () => {
    const state = sidebarLayoutReducer(expanded, "auto-collapse");
    expect(state).toEqual({ manualCollapsed: false, autoCollapsed: true });
    expect(sidebarLayoutReducer(state, "auto-collapse")).toBe(state);
  });

  it("自动收起之后可以手动展开，并在后续拖动中再次自动收起", () => {
    const auto = sidebarLayoutReducer(expanded, "auto-collapse");
    const manual = sidebarLayoutReducer(auto, "toggle");
    expect(manual).toEqual(expanded);
    expect(sidebarLayoutReducer(manual, "auto-collapse").autoCollapsed).toBe(true);
  });

  it("手动收起不被自动请求覆盖，手动展开会同时清除自动状态", () => {
    const manual = sidebarLayoutReducer(expanded, "toggle");
    expect(manual).toEqual({ manualCollapsed: true, autoCollapsed: false });
    expect(sidebarLayoutReducer(manual, "auto-collapse")).toBe(manual);
    expect(sidebarLayoutReducer(manual, "toggle")).toEqual(expanded);
  });
});
