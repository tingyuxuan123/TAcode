import { afterEach, expect, it } from "vitest";
import { applyAgentEvent, setConversationLocale, toolRow } from "./conversation";

afterEach(() => setConversationLocale("zh"));

it("shows browser actions as page operations and keeps filled text out of collapsed chips", () => {
  setConversationLocale("zh");
  const messages = applyAgentEvent([], { type: "tool_execution_start", toolCallId: "browser-fill", toolName: "browser_fill", args: { ref: "tab-e2", text: "private field content" } });
  const tool = messages.at(-1)!.tools[0];
  expect(tool.title).toBe("填写网页字段");
  const row = toolRow(tool);
  expect(row.kind).toBe("look");
  expect(row.chip).toBe("tab-e2");
  expect(JSON.stringify({ label: row.label, chip: row.chip })).not.toContain("private field content");
});
