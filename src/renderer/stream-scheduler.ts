import type { AgentEvent } from "../shared/types";

const MAX_PENDING_STREAM_EVENTS = 256;

export function createStreamScheduler(dispatch: (events: AgentEvent[]) => void) {
  let pending: AgentEvent[] = [];
  let frame: number | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (fallback !== undefined) clearTimeout(fallback);
    frame = undefined;
    fallback = undefined;
  };
  const flush = () => {
    cancel();
    const events = pending;
    pending = [];
    if (!disposed && events.length) dispatch(events);
  };
  return {
    push(event: AgentEvent) {
      if (disposed) return;
      // Snapshots may omit earlier content. Preserve them all, including their ordering.
      if (event.type !== "message_update" && event.type !== "tool_execution_update") {
        flush();
        dispatch([event]);
        return;
      }
      pending.push(event);
      if (pending.length >= MAX_PENDING_STREAM_EVENTS) {
        flush();
        return;
      }
      if (frame === undefined) {
        frame = requestAnimationFrame(flush);
        fallback = setTimeout(flush, 100);
      }
    },
    flush,
    clear() { cancel(); pending = []; },
    dispose() { disposed = true; cancel(); pending = []; },
  };
}
