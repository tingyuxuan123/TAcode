import { afterEach, describe, expect, it, vi } from "vitest";
import { clampInspectWidth, readInspectWidth, shouldAutoCollapseSidebar, writeInspectWidth } from "./panel-width";

afterEach(() => vi.unstubAllGlobals());

describe("右侧面板动态宽度", () => {
  it("向左拖大使会话不足420px时才触发收起", () => {
    expect(shouldAutoCollapseSidebar(268, 780, 1200)).toBe(false);
    expect(shouldAutoCollapseSidebar(268, 781, 1200)).toBe(true);
    expect(shouldAutoCollapseSidebar(268, 1500, 1200)).toBe(true);
    expect(shouldAutoCollapseSidebar(900, 850, 1200)).toBe(false);
    expect(shouldAutoCollapseSidebar(900, 900, 1200)).toBe(false);
  });

  it("越过最小宽度的拖动保持220px，不反跳到默认宽度", () => {
    expect(clampInspectWidth(100, 1200)).toBe(220);
    expect(clampInspectWidth(0, 1200)).toBe(220);
    expect(clampInspectWidth(-500, 1200)).toBe(220);
  });
  it("宽窗口可超过480px，并为对话保留320px", () => {
    expect(clampInspectWidth(900, 1220)).toBe(900);
    expect(clampInspectWidth(1500, 1220)).toBe(900);
    expect(clampInspectWidth(2200, 2400)).toBe(2080);
  });

  it("窄窗口自动收窄，恢复空间后重新使用原偏好", () => {
    const preferred = 900;
    expect(clampInspectWidth(preferred, 700)).toBe(380);
    expect(clampInspectWidth(preferred, 1220)).toBe(900);
    expect(clampInspectWidth(preferred, 400)).toBe(200);
    expect(clampInspectWidth(preferred, 0)).toBe(0);
  });

  it("保存和读取较宽的设置不会再被截断", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    expect(readInspectWidth()).toBe(268);
    writeInspectWidth(980);
    expect(readInspectWidth()).toBe(980);
    expect(clampInspectWidth(readInspectWidth(), 700)).toBe(380);
    expect(readInspectWidth()).toBe(980);
  });

  it.each([null, "not-a-number", "Infinity", "0", "-1"])("缺失或异常配置 %s 使用默认宽度", (raw) => {
    vi.stubGlobal("localStorage", { getItem: () => raw });
    expect(readInspectWidth()).toBe(268);
  });
});
