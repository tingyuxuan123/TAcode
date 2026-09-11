import { describe, expect, it } from "vitest";
import { parseSubagentDocument, SUBAGENT_THINKING_LEVELS, type SubagentInfo } from "../shared/subagents";
import type { ProviderRecord } from "../shared/types";
import {
  clampThinkingLevel,
  emptySubagentDraft,
  subagentBodyBytes,
  subagentBodyTemplate,
  subagentDraftError,
  subagentDraftFromInfo,
  subagentDraftToDocument,
  subagentModelOptions,
  subagentServiceNames,
  subagentThinkingLevelsFor,
  type SubagentDraft,
} from "./subagent-draft";

const draft = (over: Partial<SubagentDraft> = {}): SubagentDraft => ({
  ...emptySubagentDraft(),
  name: "doc-reviewer",
  description: "改动需要复核时使用。",
  tools: ["read_file", "list_files"],
  body: "You are the doc-reviewer subagent.",
  ...over,
});

describe("subagent draft validation", () => {
  it("合法草稿可保存，缺哪一项就给哪一项的提示", () => {
    expect(subagentDraftError(draft())).toBeNull();
    expect(subagentDraftError(draft({ name: "  " }))).toBe("subagents.errorName");
    expect(subagentDraftError(draft({ name: "!!" }))).toBe("subagents.errorSlug");
    expect(subagentDraftError(draft({ description: " " }))).toBe("subagents.errorDescription");
    expect(subagentDraftError(draft({ tools: [] }))).toBe("subagents.errorTools");
    expect(subagentDraftError(draft({ model: "deepseek-v4-pro" }))).toBe("subagents.errorModel");
    expect(subagentDraftError(draft({ maxTurns: 61 }))).toBe("subagents.errorMaxTurns");
    expect(subagentDraftError(draft({ maxTurns: 1.5 }))).toBe("subagents.errorMaxTurns");
    expect(subagentDraftError(draft({ body: "   " }))).toBe("subagents.errorBody");
  });

  it("轮次上限 0 表示不限制，不算错误", () => {
    expect(subagentDraftError(draft({ maxTurns: 0 }))).toBeNull();
  });

  it("正文超过 32 KB 才算超限", () => {
    const within = "x".repeat(32 * 1024);
    expect(subagentBodyBytes(within)).toBe(32 * 1024);
    expect(subagentDraftError(draft({ body: within }))).toBeNull();
    expect(subagentDraftError(draft({ body: `${within}x` }))).toBe("subagents.errorTooBig");
  });
});

describe("subagent draft round trip", () => {
  it("写出的文档能被解析器读回，含 TACode 特有的 permission / execPolicy", () => {
    const text = subagentDraftToDocument(draft({
      name: "Explorer Helper",
      model: "deepseek/deepseek-v4-pro",
      thinkingLevel: "medium",
      permission: "auto",
      maxTurns: 40,
      execPolicy: "readonly",
      tools: ["read_file", "search_files", "exec_command"],
    }));
    const parsed = parseSubagentDocument({ text, source: "user" });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.definition).toMatchObject({
      name: "explorer-helper",
      model: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      thinkingLevel: "medium",
      permission: "auto",
      maxTurns: 40,
      execPolicy: "readonly",
      tools: ["read_file", "search_files", "exec_command"],
    });
  });

  it("多行说明收敛成单行，frontmatter 不会被打断", () => {
    const text = subagentDraftToDocument(draft({ description: "第一行\n第二行" }));
    expect(text).toContain("description: 第一行 第二行");
    expect(parseSubagentDocument({ text, source: "user" }).definition?.description).toBe("第一行 第二行");
  });

  it("清空模型与推理强度后不再写回这两个键", () => {
    const text = subagentDraftToDocument(draft({ model: "", thinkingLevel: "" }));
    expect(text).not.toContain("model:");
    expect(text).not.toContain("thinkingLevel:");
  });

  it("从既有定义预填后原样回写", () => {
    const info: SubagentInfo = {
      name: "explorer",
      description: "只读探索器。",
      tools: ["read_file", "list_files", "search_files", "exec_command"],
      execPolicy: "readonly",
      thinkingLevel: "medium",
      maxTurns: 40,
      prompt: subagentBodyTemplate("explorer"),
      source: "builtin",
      enabled: true,
    };
    const again = parseSubagentDocument({
      text: subagentDraftToDocument(subagentDraftFromInfo(info)),
      source: "user",
    }).definition;
    expect(again).toMatchObject({
      name: "explorer",
      description: "只读探索器。",
      tools: [...info.tools],
      execPolicy: "readonly",
      thinkingLevel: "medium",
      maxTurns: 40,
    });
  });
});

const service = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: "hub",
  name: "hub",
  vendorKey: "custom",
  baseUrl: "https://hub.example.com",
  apiStyle: "anthropic_messages",
  models: [
    { id: "glm-5.3-flash", reasoning: true, thinkingLevels: ["low", "medium", "high", "max"] },
    { id: "deepseek-v4-flash", reasoning: false },
  ],
  isEnabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("subagent model options", () => {
  it("只列已启用服务里的模型，值是 <服务 id>/<模型 id>", () => {
    const options = subagentModelOptions([
      service(),
      service({ id: "subapi", name: "subapi", models: [{ id: "gpt-5.6-luna", reasoning: true }] }),
      service({ id: "off", name: "off", isEnabled: false }),
      service({ id: "empty", name: "empty", models: [] }),
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "hub/glm-5.3-flash",
      "hub/deepseek-v4-flash",
      "subapi/gpt-5.6-luna",
    ]);
    expect(options[0]).toMatchObject({ serviceId: "hub", serviceName: "hub", modelId: "glm-5.3-flash" });
  });

  it("推理档位按模型能力算：支持推理的给配置档位（含关闭推理的 off），只读模型只有 off", () => {
    const options = subagentModelOptions([service()]);
    expect(options[0]?.thinkingLevels).toEqual(["off", "low", "medium", "high", "max"]);
    expect(options[1]?.thinkingLevels).toEqual(["off"]);
  });

  it("服务 id → 名称用于列表徽标", () => {
    const names = subagentServiceNames([service({ id: "e1f6c399", name: "subapi" })]);
    expect(names.get("e1f6c399")).toBe("subapi");
    expect(names.get("missing")).toBeUndefined();
  });

  it("没钉模型或模型不在列表里时不限制档位（交给运行时按会话模型收敛）", () => {
    const options = subagentModelOptions([service()]);
    expect(subagentThinkingLevelsFor("", options)).toEqual([...SUBAGENT_THINKING_LEVELS]);
    expect(subagentThinkingLevelsFor("old/deepseek-v4-pro", options)).toEqual([...SUBAGENT_THINKING_LEVELS]);
    expect(subagentThinkingLevelsFor("hub/deepseek-v4-flash", options)).toEqual(["off"]);
    expect(subagentThinkingLevelsFor("hub/glm-5.3-flash", options)).toEqual(["off", "low", "medium", "high", "max"]);
  });

  it("换模型时把不支持的档位收敛到有效值，“与会话一致”保持不变", () => {
    expect(clampThinkingLevel("max", ["off"])).toBe("off");
    expect(clampThinkingLevel("max", ["low", "medium", "high"])).toBe("high");
    expect(clampThinkingLevel("xhigh", ["low", "high"])).toBe("high");
    expect(clampThinkingLevel("medium", ["low", "medium", "high"])).toBe("medium");
    expect(clampThinkingLevel("", ["low"])).toBe("");
    expect(clampThinkingLevel("medium", [])).toBe("");
  });
});
