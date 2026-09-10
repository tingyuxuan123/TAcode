import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  mergeSubagentDefinitions,
  normalizeSubagentName,
  parseSubagentDocument,
  renderSubagentDocument,
  subagentCanMutate,
  type SubagentDefinition,
} from "./subagents";

const doc = (frontmatter: string, body = "Do the task and report."): string =>
  `---\n${frontmatter}\n---\n\n${body}\n`;

describe("parseSubagentDocument", () => {
  it("解析完整定义", () => {
    const { definition, warnings } = parseSubagentDocument({
      text: doc(
        [
          "name: Code-Reviewer",
          "description: Review a diff for defects",
          "tools: [read_file, search_files]",
          "model: openai/gpt-5.6-sol",
          "thinkingLevel: high",
          "permission: plan",
          "maxTurns: 12",
        ].join("\n"),
      ),
      source: "user",
      filePath: "/tmp/code-reviewer.md",
    });
    expect(warnings).toEqual([]);
    expect(definition).toMatchObject({
      name: "code-reviewer",
      description: "Review a diff for defects",
      tools: ["read_file", "search_files"],
      model: { providerId: "openai", modelId: "gpt-5.6-sol" },
      thinkingLevel: "high",
      permission: "plan",
      maxTurns: 12,
      source: "user",
      filePath: "/tmp/code-reviewer.md",
    });
  });

  it("缺省 tools 时只读", () => {
    const { definition } = parseSubagentDocument({
      text: doc("name: explorer\ndescription: Explore the repo"),
      source: "builtin",
    });
    expect(definition?.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
    expect(subagentCanMutate(definition!)).toBe(false);
  });

  it("tools: * 展开为全部可分配工具", () => {
    const { definition } = parseSubagentDocument({
      text: doc("name: fixer\ndescription: Fix bugs\ntools: *"),
      source: "builtin",
    });
    expect(definition?.tools).toEqual([...SUBAGENT_ASSIGNABLE_TOOLS]);
    expect(subagentCanMutate(definition!)).toBe(true);
  });

  it("忽略不可分配的工具并告警", () => {
    const { definition, warnings } = parseSubagentDocument({
      text: doc("name: mixed\ndescription: Mixed tools\ntools: read_file, Task, update_plan"),
      source: "user",
    });
    expect(definition?.tools).toEqual(["read_file"]);
    expect(warnings.join(" ")).toContain("Task");
    expect(warnings.join(" ")).toContain("update_plan");
  });

  it("缺少 description 或正文时解析失败", () => {
    expect(
      parseSubagentDocument({ text: doc("name: no-desc"), source: "user" }).definition,
    ).toBeUndefined();
    expect(
      parseSubagentDocument({
        text: "---\nname: empty-body\ndescription: nothing\n---\n",
        source: "user",
      }).definition,
    ).toBeUndefined();
  });

  it("frontmatter 未给 name 时回退文件名", () => {
    const { definition } = parseSubagentDocument({
      text: doc("description: Legacy helper"),
      fallbackName: "Legacy Helper",
      source: "user",
    });
    expect(definition?.name).toBe("legacy-helper");
  });

  it("完全缺少 frontmatter 时告警并按缺少 description 失败", () => {
    const { definition, warnings } = parseSubagentDocument({
      text: "Just a body with no frontmatter.",
      fallbackName: "Legacy Helper",
      source: "user",
    });
    expect(definition).toBeUndefined();
    expect(warnings.join(" ")).toContain("frontmatter");
    expect(warnings.join(" ")).toContain("description");
  });

  it("收敛超过上限的 maxTurns 并忽略非法值", () => {
    const { definition, warnings } = parseSubagentDocument({
      text: doc("name: big\ndescription: Big\ntools: read_file\nmaxTurns: 999"),
      source: "user",
    });
    expect(definition?.maxTurns).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(warnings.join(" ")).toContain("maxTurns");

    const invalid = parseSubagentDocument({
      text: doc("name: bad\ndescription: Bad\ntools: read_file\nmaxTurns: many"),
      source: "user",
    });
    expect(invalid.definition?.maxTurns).toBeUndefined();
  });
});

describe("renderSubagentDocument", () => {
  it("渲染后可被解析回等价定义", () => {
    const original: SubagentDefinition = {
      name: "test-runner",
      description: "Run the focused tests and report failures",
      tools: ["read_file", "exec_command"],
      model: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      thinkingLevel: "medium",
      permission: "auto",
      maxTurns: 20,
      prompt: "Run the tests.\nReport failures with exact output.",
      source: "user",
    };
    const { definition, warnings } = parseSubagentDocument({
      text: renderSubagentDocument(original),
      source: "user",
    });
    expect(warnings).toEqual([]);
    expect(definition).toMatchObject({
      name: original.name,
      description: original.description,
      tools: original.tools,
      model: original.model,
      thinkingLevel: original.thinkingLevel,
      permission: original.permission,
      maxTurns: original.maxTurns,
      prompt: original.prompt,
    });
  });
});

describe("mergeSubagentDefinitions", () => {
  it("用户定义按名覆盖内置定义并保持顺序", () => {
    const builtin = (name: string): SubagentDefinition => ({
      name,
      description: `${name} builtin`,
      tools: [...DEFAULT_SUBAGENT_TOOLS],
      prompt: "builtin",
      source: "builtin",
    });
    const merged = mergeSubagentDefinitions(
      [builtin("explorer"), builtin("reviewer")],
      [{ ...builtin("explorer"), description: "user override", source: "user" }],
    );
    expect(merged.map((item) => item.name)).toEqual(["explorer", "reviewer"]);
    expect(merged[0]?.description).toBe("user override");
  });
});

describe("normalizeSubagentName", () => {
  it("归一化为 slug", () => {
    expect(normalizeSubagentName("  Code Reviewer!  ")).toBe("code-reviewer");
    expect(normalizeSubagentName("---")).toBe("");
  });
});
