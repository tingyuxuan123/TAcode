import { describe, expect, it } from "vitest";
import {
  IPC_LIMITS,
  assertByteLimit,
  assertPayloadLimit,
  base64PayloadBytes,
  byteLength,
  formatBytes,
  optionalStringArray,
  redactSecrets,
  requireRecord,
  requireString,
  validateAgentStartOptions,
  validateConnectionInput,
  validatePromptMessage,
} from "./ipc-validation";

describe("requireString", () => {
  it("rejects non-strings and blank values", () => {
    expect(() => requireString(42, "provider")).toThrow("无效的 provider");
    expect(() => requireString("   ", "provider")).toThrow("无效的 provider");
  });

  it("allows empty values when asked and enforces length", () => {
    expect(requireString("", "key", { allowEmpty: true })).toBe("");
    expect(() => requireString("abcdef", "key", { maxLength: 3 })).toThrow("key过长");
  });
});

describe("requireRecord", () => {
  it("rejects arrays and primitives", () => {
    expect(() => requireRecord([], "参数")).toThrow("无效的 参数");
    expect(() => requireRecord(null, "参数")).toThrow("无效的 参数");
    expect(requireRecord({ a: 1 }, "参数")).toEqual({ a: 1 });
  });
});

describe("optionalStringArray", () => {
  it("passes through undefined and validates items", () => {
    expect(optionalStringArray(undefined, "extraModels")).toBeUndefined();
    expect(optionalStringArray(["a", "b"], "extraModels")).toEqual(["a", "b"]);
    expect(() => optionalStringArray("a", "extraModels")).toThrow("无效的 extraModels");
    expect(() => optionalStringArray([1], "extraModels")).toThrow("无效的 extraModels[0]");
    expect(() =>
      optionalStringArray(["a", "b"], "extraModels", { maxItems: 1 }),
    ).toThrow("数量过多");
  });
});

describe("byte limits", () => {
  it("counts UTF-8 bytes, not code units", () => {
    expect(byteLength("中文")).toBe(6);
    expect(() => assertByteLimit("中文", 3, "prompt")).toThrow("prompt过大");
    expect(assertByteLimit("中文", 6, "prompt")).toBe("中文");
  });

  it("measures serialized payload size", () => {
    expect(() => assertPayloadLimit({ message: "x".repeat(100) }, 10, "命令内容")).toThrow(
      "命令内容过大",
    );
    expect(assertPayloadLimit({ ok: true }, 1_000, "命令内容")).toEqual({ ok: true });
  });

  it("formats readable sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("validatePromptMessage", () => {
  it("accepts a normal message", () => {
    expect(validatePromptMessage("你好")).toBe("你好");
  });

  it("rejects non-strings and oversized prompts", () => {
    expect(() => validatePromptMessage(1)).toThrow("无效的 prompt");
    expect(() =>
      validatePromptMessage("x".repeat(IPC_LIMITS.promptBytes + 1)),
    ).toThrow("prompt过大");
  });
});

describe("validateAgentStartOptions", () => {
  const base = { provider: "deepseek", permission: "ask", sandbox: "workspace-write" };

  it("accepts a minimal payload and keeps optional fields", () => {
    expect(validateAgentStartOptions(base)).toEqual(base);
    const withOptionals = validateAgentStartOptions({
      ...base,
      cwd: "/tmp/work",
      model: "deepseek-chat",
      network: true,
      maxTokens: 4096,
      extraModels: ["a"],
      writableRoots: ["/tmp/extra"],
    });
    expect(withOptionals).toMatchObject({
      cwd: "/tmp/work",
      model: "deepseek-chat",
      network: true,
      maxTokens: 4096,
      extraModels: ["a"],
      writableRoots: ["/tmp/extra"],
    });
  });

  it("rejects unknown permission or sandbox modes", () => {
    expect(() => validateAgentStartOptions({ ...base, permission: "yolo" })).toThrow(
      "无效的 权限模式",
    );
    expect(() => validateAgentStartOptions({ ...base, sandbox: "root" })).toThrow(
      "无效的 沙箱模式",
    );
  });

  it("rejects malformed optional fields", () => {
    expect(() => validateAgentStartOptions({ ...base, cwd: 5 })).toThrow("无效的 cwd");
    expect(() => validateAgentStartOptions({ ...base, maxTokens: -1 })).toThrow("无效的 maxTokens");
    expect(() => validateAgentStartOptions({ ...base, network: "yes" })).toThrow("无效的 network");
    expect(() => validateAgentStartOptions({ ...base, extraModels: "a" })).toThrow(
      "无效的 extraModels",
    );
  });
});

describe("validateConnectionInput", () => {
  it("accepts a URL, key and style", () => {
    expect(validateConnectionInput("https://api.example.com", "sk-1", "responses")).toEqual({
      baseUrl: "https://api.example.com",
      apiKey: "sk-1",
      apiStyle: "responses",
    });
  });

  it("omits an absent style and rejects oversized input", () => {
    expect(validateConnectionInput("https://api.example.com", "", undefined)).toEqual({
      baseUrl: "https://api.example.com",
      apiKey: "",
    });
    expect(() =>
      validateConnectionInput(`https://${"x".repeat(IPC_LIMITS.urlLength)}`, "k", undefined),
    ).toThrow("API URL过长");
  });
});

describe("redactSecrets", () => {
  it("replaces known secrets and skips short or empty ones", () => {
    const key = "sk-1234567890abcdef";
    expect(redactSecrets(`failed with ${key}`, [key])).toBe("failed with [REDACTED]");
    expect(redactSecrets("plain text", ["", "abc", undefined])).toBe("plain text");
  });

  it("redacts every occurrence", () => {
    const key = "sk-abcdefgh";
    expect(redactSecrets(`${key} and ${key}`, [key])).toBe("[REDACTED] and [REDACTED]");
  });
});

describe("base64PayloadBytes", () => {
  it("estimates decoded size for data URLs and raw base64", () => {
    const payload = Buffer.from("hello world").toString("base64");
    expect(base64PayloadBytes(`data:image/png;base64,${payload}`)).toBe(11);
    expect(base64PayloadBytes(payload)).toBe(11);
  });
});
