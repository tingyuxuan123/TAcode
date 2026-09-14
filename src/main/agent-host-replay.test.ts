import { describe, expect, it } from "vitest";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";

function harness() {
  const events: AgentEvent[] = [];
  const host = new AgentHost((event) => events.push(event), () => undefined);
  (host as unknown as { child: unknown }).child = {
    exitCode: null,
    stdin: { write: () => true, destroyed: false },
  };
  const emit = (event: Record<string, unknown>) => {
    (host as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(event));
  };
  return { host, events, emit };
}

describe("AgentHost bounded replay", () => {
  it("reports a replay gap after the bounded event window rolls over", () => {
    const { host, emit } = harness();
    for (let index = 0; index < 501; index += 1) emit({ type: "message_update", text: `event-${index}` });

    expect(host.replayGap(0)).toBe(true);
    expect(host.replaySince(0)[0].__seq).toBeGreaterThan(1);
    expect(host.replayGap(host.replaySince(0)[0].__seq! - 1)).toBe(false);
  });

  it("notifies turn observers without retaining the observer after unsubscribe", () => {
    const { host, emit } = harness();
    const seen: string[] = [];
    const off = host.onEvent((event) => seen.push(event.type));
    emit({ type: "message_end", message: { role: "assistant", content: "done" } });
    off();
    emit({ type: "message_end", message: { role: "assistant", content: "later" } });

    expect(seen).toEqual(["message_end"]);
  });
});
