import { describe, expect, it } from "vitest";
import { normalizeMessages } from "./conversation";
import { mergeHistoryMessages } from "./session-history";

const normalize = (times: number[]) => normalizeMessages(times.map((timestamp) => ({ __entryId: String(timestamp), role: timestamp % 2 ? "user" : "assistant", content: `message ${timestamp}`, timestamp })));

describe("merging paged history with a live snapshot", () => {
  it("keeps old pre-compaction messages and uses the latest partial answer", () => {
    const old = normalize([1, 2, 3, 4]);
    const live = normalize([3, 4, 5, 6]);
    live[1]!.text = "updated live answer";
    const merged = mergeHistoryMessages(old, live);
    expect(merged.map((message) => message.timestamp! / 1000)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged[3]!.text).toBe("updated live answer");
    expect(merged[0]).toBe(old[0]);
    expect(merged[3]!.id).toBe(old[3]!.id);
  });

  it("does not repeat a page already included in the full worker snapshot", () => {
    const merged = mergeHistoryMessages(normalize([3, 4, 5]), normalize([1, 2, 3, 4, 5, 6]));
    expect(merged.map((message) => message.timestamp! / 1000)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("preserves repeated text at different times and stable IDs across pages", () => {
    const old = normalizeMessages([{ role: "user", content: "继续", timestamp: 1, __entryId: "one" }]);
    const live = normalizeMessages([{ role: "user", content: "继续", timestamp: 2, __entryId: "two" }]);
    expect(mergeHistoryMessages(old, live).map((message) => message.id)).toEqual(["entry-one", "entry-two"]);
  });

  it("does not collapse distinct entries with identical text and timestamp", () => {
    const old = normalizeMessages([{ role: "user", content: "继续", timestamp: 1, __entryId: "one" }]);
    const live = normalizeMessages([{ role: "user", content: "继续", timestamp: 1, __entryId: "two" }]);
    expect(mergeHistoryMessages(old, live).map((message) => message.id)).toEqual(["entry-one", "entry-two"]);
  });
});
