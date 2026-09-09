import { describe, expect, it } from "vitest";
import { drainUtf8Lines } from "./rpc-lines";

describe("drainUtf8Lines", () => {
  it("keeps UTF-8 characters intact when a line spans stdout chunks", () => {
    const payload = JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "消除散落在 JSX 里的重复动画对象" }] } });
    const bytes = Buffer.from(`${payload}\n`, "utf8");
    const split = bytes.indexOf("散") + 1;
    let rest = Buffer.alloc(0);
    const first = drainUtf8Lines(rest, bytes.subarray(0, split));
    rest = Buffer.from(first.rest);
    expect(first.lines).toEqual([]);
    const second = drainUtf8Lines(rest, bytes.subarray(split));
    expect(second.lines).toHaveLength(1);
    expect(JSON.parse(second.lines[0]!).message.content[0].text).toBe("消除散落在 JSX 里的重复动画对象");
  });

  it("drops lines beyond the configured maximum and reports them", () => {
    const payload = `${"x".repeat(50)}\n${"y".repeat(4)}\n`;
    const result = drainUtf8Lines(Buffer.alloc(0), Buffer.from(payload, "utf8"), {
      maxLineBytes: 10,
    });
    expect(result.lines).toEqual(["yyyy"]);
    expect(result.oversized).toBe(1);
    expect(result.rest).toHaveLength(0);
  });

  it("discards an oversized unterminated buffer instead of growing forever", () => {
    const result = drainUtf8Lines(Buffer.alloc(0), Buffer.from("z".repeat(64), "utf8"), {
      maxLineBytes: 16,
    });
    expect(result.lines).toEqual([]);
    expect(result.oversized).toBe(1);
    expect(result.rest).toHaveLength(0);
  });

  it("keeps normal lines when no limit is configured", () => {
    const result = drainUtf8Lines(Buffer.alloc(0), Buffer.from("a\nbb\n", "utf8"));
    expect(result.lines).toEqual(["a", "bb"]);
    expect(result.oversized).toBe(0);
  });
});
