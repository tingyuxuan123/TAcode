import { afterEach, describe, expect, it, vi } from "vitest";
import { clampInspectWidth, readInspectWidth, writeInspectWidth } from "./panel-width";

afterEach(() => vi.unstubAllGlobals());

describe("右侧面板动态宽度", () => {
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
