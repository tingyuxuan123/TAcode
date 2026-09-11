import { describe, expect, it } from "vitest";
import { MAX_SUBAGENT_MAX_TURNS } from "../shared/subagents";
import { delegationProviderTarget, delegationRunOptions, delegationTurnLimit } from "./delegation-run-options";

/**
 * 回归：角色定义里配的 `thinkingLevel` / `maxTurns` 必须真的进 worker 启动选项。
 * 桥接路径曾经完全不读它们（`buildStartOptions` 既不返回 `effort` 也无 `maxTurns`），
 * 等于「配了不生效」——explorer 40 / code-reviewer 40 / test-runner 30 / fixer 60 全部作废。
 */
describe("delegationRunOptions", () => {
  it("payload 里的思考等级优先（父会话/定义在桥接侧算出来的值）", () => {
    expect(delegationRunOptions({ thinkingLevel: "high" }, { thinkingLevel: "low" }))
      .toEqual({ effort: "high", maxTurns: MAX_SUBAGENT_MAX_TURNS });
  });

  it("payload 缺字段时回落到角色定义（continue() 重建 payload 的场景）", () => {
    expect(delegationRunOptions({}, { thinkingLevel: "medium" }).effort).toBe("medium");
    expect(delegationRunOptions({ thinkingLevel: "   " }, { thinkingLevel: " medium " }).effort).toBe("medium");
  });

  it("非法档位/畸形类型被忽略，不会塞进 --thinking 让 worker 启动失败", () => {
    expect(delegationRunOptions({ thinkingLevel: 123 }, { thinkingLevel: "high" }).effort).toBe("high");
    expect(delegationRunOptions({ thinkingLevel: "turbo" }, {}).effort).toBeUndefined();
    expect(delegationRunOptions({ thinkingLevel: null }, { thinkingLevel: "ultra" }).effort).toBeUndefined();
    expect(delegationRunOptions({ thinkingLevel: "off" }, {}).effort).toBe("off");
  });

  it("角色定义的 maxTurns 原样下发", () => {
    expect(delegationRunOptions({}, { maxTurns: 40 }).maxTurns).toBe(40);
    expect(delegationRunOptions({}, { maxTurns: 30 }).maxTurns).toBe(30);
  });
});

describe("delegationTurnLimit", () => {
  it("定义没配或值非法时用与进程内路径相同的默认值", () => {
    expect(delegationTurnLimit({})).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(delegationTurnLimit({ maxTurns: 0 })).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(delegationTurnLimit({ maxTurns: -3 })).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(delegationTurnLimit({ maxTurns: 2.5 })).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(delegationTurnLimit({ maxTurns: "40" })).toBe(MAX_SUBAGENT_MAX_TURNS);
  });

  it("不超过收敛上限", () => {
    expect(delegationTurnLimit({ maxTurns: 999 })).toBe(MAX_SUBAGENT_MAX_TURNS);
    expect(delegationTurnLimit({ maxTurns: MAX_SUBAGENT_MAX_TURNS })).toBe(MAX_SUBAGENT_MAX_TURNS);
  });

  it("默认值与内置角色定义一致（两条路径不会各算一套）", () => {
    expect(MAX_SUBAGENT_MAX_TURNS).toBe(60);
  });
});

/**
 * 子代理模型钉选的 provider 段可以是用户在「AI 服务」里加的服务 id：
 * 主进程查库命中就把服务一起接给子代理（它就能跑在与会话不同的服务上）；
 * 没命中时沿用父会话的供应商与服务，不会把「服务」偷换成别的东西。
 */
describe("delegationProviderTarget", () => {
  it("钉选命中服务时用该服务，运行时供应商固定为 openai", () => {
    expect(delegationProviderTarget({
      parentProvider: "openai",
      parentServiceId: "subapi",
      pinnedServiceId: "hub",
    })).toEqual({ provider: "openai", serviceId: "hub" });
  });

  it("没钉服务时沿用父会话的供应商与服务", () => {
    expect(delegationProviderTarget({ parentProvider: "openai", parentServiceId: "subapi" }))
      .toEqual({ provider: "openai", serviceId: "subapi" });
    expect(delegationProviderTarget({ parentProvider: "deepseek" }))
      .toEqual({ provider: "deepseek" });
  });

  it("钉选没命中服务（写的是内置供应商或服务已删除）时不带上服务", () => {
    expect(delegationProviderTarget({ parentProvider: "deepseek", pinnedServiceId: undefined }))
      .toEqual({ provider: "deepseek" });
  });
});
