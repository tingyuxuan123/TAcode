import { describe, expect, it } from "vitest";
import {
  AGENT_NO_SESSION_KEY,
  NO_ACTIVE_SESSION_MESSAGE,
  agentNoSessionResult,
  isAgentNoSessionResult,
} from "./agent-protocol";

describe("agent protocol", () => {
  it("识别无活动会话哨兵", () => {
    expect(isAgentNoSessionResult(agentNoSessionResult())).toBe(true);
    expect(isAgentNoSessionResult({ [AGENT_NO_SESSION_KEY]: true })).toBe(true);
  });

  it("不把正常返回值或近似值误判为哨兵", () => {
    expect(isAgentNoSessionResult(undefined)).toBe(false);
    expect(isAgentNoSessionResult(null)).toBe(false);
    expect(isAgentNoSessionResult({})).toBe(false);
    expect(isAgentNoSessionResult({ [AGENT_NO_SESSION_KEY]: false })).toBe(false);
    // 命令结果常带 messages / levels / model 等字段，不能因为对象形状相似就命中。
    expect(isAgentNoSessionResult({ messages: [], levels: ["off"] })).toBe(false);
    expect(isAgentNoSessionResult(NO_ACTIVE_SESSION_MESSAGE)).toBe(false);
  });

  it("渲染层可见的错误消息保持稳定（主进程与 preload 共用）", () => {
    expect(NO_ACTIVE_SESSION_MESSAGE).toBe("No active agent session");
    expect(Object.keys(agentNoSessionResult())).toEqual([AGENT_NO_SESSION_KEY]);
  });
});
