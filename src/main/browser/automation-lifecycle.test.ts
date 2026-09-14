import { describe, expect, it } from "vitest";
import { BrowserAutomation } from "./automation";

describe("BrowserAutomation session lifecycle", () => {
  it("drops an agent session when reset leaves no owned tabs", () => {
    const automation = new BrowserAutomation(() => undefined);
    const internals = automation as unknown as { session(runtimeId: string): unknown; sessions: Map<string, unknown> };
    internals.session("runtime-1");
    expect(internals.sessions.has("runtime-1")).toBe(true);
    automation.resetAgent("runtime-1");
    expect(internals.sessions.has("runtime-1")).toBe(false);
  });

  it("drops the legacy default session after its queue becomes idle", async () => {
    const automation = new BrowserAutomation(() => undefined);
    const internals = automation as unknown as { sessions: Map<string, unknown> };
    await automation.execute("browser_list_tabs", {}, new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(internals.sessions.has("default")).toBe(false);
  });
});
