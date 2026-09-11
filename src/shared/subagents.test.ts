import { describe, expect, it } from "vitest";
import { DELEGATION_MAX_CONCURRENCY, DELEGATION_MAX_REPORT_CHARS, boundedDelegationText } from "./delegation";
import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_REPORT_CHARS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  mergeSubagentDefinitions,
  normalizeSubagentName,
  parseSubagentDocument,
  renderSubagentDocument,
  closestSubagentName,
  subagentCanMutate,
  subagentCatalogText,
  subagentEditsFiles,
  unknownSubagentMessage,
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

describe("可写性与常量来源", () => {
  const withTools = (tools: string[]): Pick<SubagentDefinition, "tools"> =>
    ({ tools }) as Pick<SubagentDefinition, "tools">;

  it("只跑命令的角色算「可写子代理」，但不算「会改文件」", () => {
    // test-runner 声明 exec_command/write_stdin：不能被提示词告知「可以改文件」。
    const runner = withTools(["read_file", "exec_command", "write_stdin"]);
    expect(subagentCanMutate(runner)).toBe(true);
    expect(subagentEditsFiles(runner)).toBe(false);

    const fixer = withTools(["read_file", "edit_file", "apply_patch"]);
    expect(subagentCanMutate(fixer)).toBe(true);
    expect(subagentEditsFiles(fixer)).toBe(true);

    const explorer = withTools([...DEFAULT_SUBAGENT_TOOLS]);
    expect(subagentCanMutate(explorer)).toBe(false);
    expect(subagentEditsFiles(explorer)).toBe(false);
  });

  it("未知角色提示附可用清单 + 最接近的名字（模型看不到目录）", () => {
    const definitions = [
      { name: "explorer", description: "Read-only repository explorer." },
      { name: "code-reviewer", description: "Adversarial reviewer." },
    ];
    // 换大小写/拼写：都要给出「你是不是想找 X」
    expect(closestSubagentName("Explore", definitions.map((item) => item.name))).toBe("explorer");
    expect(closestSubagentName("reviewer", definitions.map((item) => item.name))).toBe("code-reviewer");
    expect(closestSubagentName("fixr", definitions.map((item) => item.name))).toBeUndefined();

    const message = unknownSubagentMessage("Explore", definitions);
    expect(message).toContain('Unknown subagent: Explore');
    expect(message).toContain('Did you mean "explorer"?');
    expect(message).toContain("Available:");
    expect(message).toContain("- code-reviewer: Adversarial reviewer.");
  });

  it("一个角色都没启用时给出配置指引", () => {
    const message = unknownSubagentMessage("explorer", []);
    expect(message).toContain("Unknown subagent: explorer");
    expect(message).toContain("Settings → Subagents");
  });

  it("模型可见的子代理目录含角色、工具与上限", () => {
    const catalog = subagentCatalogText([
      { name: "explorer", description: "Read-only explorer.", tools: ["read_file"], maxTurns: 40, thinkingLevel: "medium" },
    ]);
    expect(catalog).toContain("Subagent catalog");
    expect(catalog).toContain("- explorer: Read-only explorer. (tools: read_file; maxTurns 40; thinking medium)");
    expect(subagentCatalogText([])).toBe("");
  });

  it("解析与渲染 execPolicy（只读命令策略）", () => {
    const { definition, warnings } = parseSubagentDocument({
      text: doc("name: explorer\ndescription: Explore\nexecPolicy: readonly"),
      source: "builtin",
    });
    expect(definition?.execPolicy).toBe("readonly");
    expect(warnings).toEqual([]);
    expect(renderSubagentDocument(definition!)).toContain("execPolicy: readonly");

    const invalid = parseSubagentDocument({
      text: doc("name: explorer\ndescription: Explore\nexecPolicy: yolo"),
      source: "builtin",
    });
    expect(invalid.definition?.execPolicy).toBeUndefined();
    expect(invalid.warnings.join("\n")).toContain("execPolicy 非法");
  });

  it("并发与报告上限只有一份来源（本地与桥接不会漂移）", () => {
    expect(MAX_SUBAGENT_CONCURRENCY).toBe(DELEGATION_MAX_CONCURRENCY);
    expect(MAX_SUBAGENT_REPORT_CHARS).toBe(DELEGATION_MAX_REPORT_CHARS);
    // 钉住数值本身：只断言「两者相等」的话，把来源常量一起改回 50 000 也照样绿。
    expect(DELEGATION_MAX_REPORT_CHARS).toBe(12_000);
    expect(DELEGATION_MAX_CONCURRENCY).toBe(8);
    const long = "x".repeat(DELEGATION_MAX_REPORT_CHARS + 5_000);
    const bounded = boundedDelegationText(long);
    expect(bounded.length).toBeLessThanOrEqual(DELEGATION_MAX_REPORT_CHARS);
    expect(bounded).toContain("delegation text truncated");
  });
});
