import { beforeEach, describe, expect, it } from "vitest";
import {
  applyToolSet,
  captureToolSetCarryOver,
  clearToolContribution,
  clearToolSetCarryOver,
  computeActiveToolNames,
  contributionNames,
  resetToolSet,
  setToolContribution,
  setToolSetPolicy,
  toolSetDiff,
} from "./tool-set";

function fakePi(initial: string[] = []) {
  let active = [...initial];
  return {
    pi: {
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = [...names];
      },
    },
    active: () => active,
  };
}

const BASE = ["read_file", "exec_command", "apply_patch", "update_plan"];
const PLAN_ALLOWED = ["read_file", "exec_command", "update_plan"];

function policy(permission: "plan" | "ask" | "auto" | "full", base = BASE) {
  setToolSetPolicy({ permission, baseToolNames: base, planAllowedToolNames: PLAN_ALLOWED });
}

beforeEach(() => {
  resetToolSet();
});

describe("computeActiveToolNames", () => {
  it("把扩展贡献并入基础工具", () => {
    policy("auto");
    setToolContribution("browser", { names: ["browser_navigate", "browser_observe"] });
    expect(computeActiveToolNames()).toEqual([...BASE, "browser_navigate", "browser_observe"]);
  });

  it("plan 模式只保留白名单基础工具 + planAllowed 贡献 + update_plan", () => {
    policy("plan");
    setToolContribution("browser", { names: ["browser_navigate"] });
    setToolContribution("vision", { names: ["vision"], planAllowed: true });
    expect(computeActiveToolNames()).toEqual(["read_file", "exec_command", "update_plan", "vision"]);
  });

  it("未配置策略时不猜工具集", () => {
    setToolContribution("browser", { names: ["browser_navigate"] });
    expect(computeActiveToolNames()).toBeUndefined();
  });

  it("收回贡献后工具名消失", () => {
    policy("auto");
    setToolContribution("browser", { names: ["browser_navigate"] });
    expect(contributionNames()).toEqual(["browser_navigate"]);
    clearToolContribution("browser");
    expect(contributionNames()).toEqual([]);
    expect(computeActiveToolNames()).toEqual(BASE);
  });
});

describe("applyToolSet", () => {
  it("回归：切到 full 权限不再把 browser_* 摘掉（本次故障的直接原因）", () => {
    const { pi, active } = fakePi();
    policy("auto");
    setToolContribution("browser", { names: ["browser_navigate", "browser_list_tabs"] });
    applyToolSet(pi);
    expect(active()).toEqual([...BASE, "browser_navigate", "browser_list_tabs"]);

    // 旧实现在这里会把激活集换成 options.activeTools（不含 browser_*），
    // 模型随后撞 `Tool browser_navigate not found`。
    policy("full");
    const diff = applyToolSet(pi);
    expect(diff.removed).toEqual([]);
    expect(active()).toContain("browser_navigate");
    expect(active()).toContain("browser_list_tabs");
  });

  it("进入 plan 摘掉交互工具，离开后连同 carryOver 一起恢复", () => {
    const { pi, active } = fakePi();
    policy("auto");
    setToolContribution("browser", { names: ["browser_navigate"] });
    applyToolSet(pi);
    expect(active()).toEqual([...BASE, "browser_navigate"]);

    // MCP 之类的工具由 TACode 之外激活：进 plan 前快照，离开后按原样恢复。
    active().push("mcp__foo");
    captureToolSetCarryOver(active(), BASE);
    policy("plan");
    expect(applyToolSet(pi).removed).toEqual(["apply_patch", "browser_navigate", "mcp__foo"]);
    expect(active()).toEqual(["read_file", "exec_command", "update_plan"]);

    policy("auto");
    expect(applyToolSet(pi).added).toEqual(["apply_patch", "browser_navigate", "mcp__foo"]);
  });

  it("收敛掉 pi 自动激活的内置工具（TACode 工具表才是权威）", () => {
    const { pi, active } = fakePi(["read", "bash", "edit", "write", "read_file"]);
    policy("auto");
    expect(applyToolSet(pi).removed).toEqual(["read", "bash", "edit", "write"]);
    expect(active()).toEqual(BASE);
  });

  it("没有变化时不动 setActiveTools（不重建系统提示）", () => {
    const { pi, active } = fakePi();
    policy("auto");
    setToolContribution("browser", { names: ["browser_navigate"] });
    applyToolSet(pi);
    const snapshot = active();
    const calls: string[][] = [];
    const spy = {
      getActiveTools: () => snapshot,
      setActiveTools: (names: string[]) => calls.push(names),
    };
    const diff = applyToolSet(spy);
    expect(diff).toEqual({ added: [], removed: [], skipped: false });
    expect(calls).toEqual([]);
  });

  it("策略缺失时跳过而不是清空工具集", () => {
    const { pi, active } = fakePi(["read_file"]);
    const diff = applyToolSet(pi);
    expect(diff.skipped).toBe(true);
    expect(active()).toEqual(["read_file"]);
  });
});

describe("toolSetDiff", () => {
  it("分别给出新增与摘掉的名字", () => {
    expect(toolSetDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });
});

describe("carryOver", () => {
  it("clearToolSetCarryOver 清掉快照", () => {
    policy("auto");
    captureToolSetCarryOver(["read_file", "mcp__foo"], BASE);
    expect(computeActiveToolNames()).toContain("mcp__foo");
    clearToolSetCarryOver();
    expect(computeActiveToolNames()).not.toContain("mcp__foo");
  });
});
