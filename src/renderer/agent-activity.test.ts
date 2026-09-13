import { describe, expect, it } from "vitest";
import type { AgentSessionActivity } from "../shared/types";
import { mergeAgentActivity } from "./agent-activity";

const activity = (patch: Partial<AgentSessionActivity> = {}): AgentSessionActivity => ({
  runtimeId: "a", sessionPath: "/a.jsonl", version: 1, status: "running", running: true, pendingRequests: [], unread: false, ...patch,
});

describe("activity snapshot reconciliation", () => {
  it("does not resurrect an answered request from a delayed snapshot", () => {
    const answered = activity({ version: 9 });
    const current = new Map([[answered.sessionPath!, answered]]);
    const delayed = activity({ version: 5, status: "waiting", pendingRequests: [{ type: "extension_ui_request", id: "done", method: "confirm" }] });
    expect(mergeAgentActivity(current, delayed)).toBe(current);
  });

  it("replaces an old worker without losing the activity of other sessions", () => {
    const old = activity();
    const b = activity({ runtimeId: "b", sessionPath: "/b.jsonl" });
    const current = new Map([[old.sessionPath!, old], [b.sessionPath!, b]]);
    const replacement = activity({ runtimeId: "new-a", version: 4 });
    const next = mergeAgentActivity(current, replacement);
    expect(next.get("/a.jsonl")).toBe(replacement);
    expect(next.get("/b.jsonl")).toBe(b);
    expect(mergeAgentActivity(next, old)).toBe(next);
  });

  it("rekeys a request that arrived before the session file was known", () => {
    const early = activity({ sessionPath: undefined });
    const next = mergeAgentActivity(new Map([["a", early]]), activity({ version: 2 }));
    expect(next.has("a")).toBe(false);
    expect(next.get("/a.jsonl")?.runtimeId).toBe("a");
  });
});
