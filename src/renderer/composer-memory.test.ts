import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_MEMORY_PREFIX,
  composerMemoryKey,
  readProjectComposerMemory,
  writeProjectComposerMemory,
} from "./composer-memory";

describe("project composer memory", () => {
  it("key 以项目路径结尾，便于按项目隔离", () => {
    expect(composerMemoryKey("/tmp/demo")).toBe(`${COMPOSER_MEMORY_PREFIX}/tmp/demo`);
  });

  it("合并写入并读回 mode/model，项目之间互不影响", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    writeProjectComposerMemory("/tmp/demo", { mode: "full" });
    writeProjectComposerMemory("/tmp/demo", { model: "GLM-5.3-Flash" });
    expect(readProjectComposerMemory("/tmp/demo")).toEqual({ mode: "full", model: "GLM-5.3-Flash" });
    expect(readProjectComposerMemory("/tmp/other")).toEqual({});
  });

  it("丢弃损坏或越界的值，存储不可读时返回空对象", () => {
    vi.stubGlobal("localStorage", { getItem: () => '{"mode":"yolo","model":42}' });
    expect(readProjectComposerMemory("/tmp/demo")).toEqual({});
    vi.stubGlobal("localStorage", { getItem: () => "not-json" });
    expect(readProjectComposerMemory("/tmp/demo")).toEqual({});
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
    expect(readProjectComposerMemory("/tmp/demo")).toEqual({});
  });

  it("空项目路径与写入失败都静默忽略", () => {
    expect(readProjectComposerMemory("")).toEqual({});
    expect(() => writeProjectComposerMemory("", { mode: "auto" })).not.toThrow();
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("quota"); } });
    expect(() => writeProjectComposerMemory("/tmp/demo", { mode: "auto" })).not.toThrow();
  });
});
