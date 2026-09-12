import { describe, expect, it } from "vitest";
import { MIN_REPLAY_THINKING_CHARS, sanitizeProviderBody } from "./provider-sanitize";

const LONG = "先".repeat(MIN_REPLAY_THINKING_CHARS + 5);
const SHORT = "现在写第一段。";

describe("sanitizeProviderBody", () => {
  it("strips every thinking block from history when the request ends with a user prompt", () => {
    const body = JSON.stringify({
      model: "glm-5.3-flash",
      messages: [
        { role: "user", content: "帮我写一个 SVG" },
        { role: "assistant", content: [{ type: "thinking", thinking: SHORT }, { type: "text", text: "好的" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "tool_use", id: "t1", name: "write_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "text", text: "完成" }] },
        { role: "user", content: "再来一个" },
      ],
    });
    const next = sanitizeProviderBody(body);
    expect(next).toBeDefined();
    const parsed = JSON.parse(next!) as { messages: Array<{ role: string; content: unknown[] }> };
    // 非续跑场景：所有 assistant 消息的 thinking 全部剔除，其余块原样保留
    expect(parsed.messages[1].content).toEqual([{ type: "text", text: "好的" }]);
    expect(parsed.messages[2].content).toEqual([{ type: "tool_use", id: "t1", name: "write_file", input: {} }]);
    expect(parsed.messages[4].content).toEqual([{ type: "text", text: "完成" }]);
    expect(JSON.parse(next!).model).toBe("glm-5.3-flash");
  });

  it("keeps long thinking only on the assistant turn about to continue after a tool result", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "写文件" },
        { role: "assistant", content: [{ type: "thinking", thinking: "历史轮的思考" }, { type: "tool_use", id: "t1", name: "write_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    const next = sanitizeProviderBody(body);
    const parsed = JSON.parse(next!) as { messages: Array<{ content: unknown[] }> };
    // 续跑场景：前面轮次的 thinking 全剔，最后一条 assistant 保留长 thinking、剔除短块
    expect(parsed.messages[1].content).toEqual([{ type: "tool_use", id: "t1", name: "write_file", input: {} }]);
  });

  it("strips too-short thinking even on the continuing turn", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "写文件" },
        { role: "assistant", content: [{ type: "thinking", thinking: SHORT, signature: "sig" }, { type: "tool_use", id: "t1", name: "write_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    const parsed = JSON.parse(sanitizeProviderBody(body)!) as { messages: Array<{ content: unknown[] }> };
    expect(parsed.messages[1].content).toEqual([{ type: "tool_use", id: "t1", name: "write_file", input: {} }]);
  });

  it("removes an assistant message that contains only invalid thinking", () => {
    const body = JSON.stringify({
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: SHORT }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    const parsed = JSON.parse(sanitizeProviderBody(body)!) as { messages: Array<{ role: string }> };
    expect(parsed.messages).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }]);
  });

  it("returns undefined when there is nothing to sanitize", () => {
    const noThinking = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "text", text: "好" }] }] });
    expect(sanitizeProviderBody(noThinking)).toBeUndefined();
    const inFlightLong = JSON.stringify({
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: LONG }, { type: "tool_use", id: "t1", name: "write_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    expect(sanitizeProviderBody(inFlightLong)).toBeUndefined();
  });

  it("never throws on non-JSON or non-message bodies", () => {
    expect(sanitizeProviderBody("not json")).toBeUndefined();
    expect(sanitizeProviderBody("{}")).toBeUndefined();
    expect(sanitizeProviderBody(JSON.stringify({ messages: "not-an-array" }))).toBeUndefined();
    expect(sanitizeProviderBody(JSON.stringify({ messages: [null, 3, "x"] }))).toBeUndefined();
  });
});
