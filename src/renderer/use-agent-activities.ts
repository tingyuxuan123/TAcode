import { useCallback, useEffect, useState } from "react";
import type { AgentSessionActivity } from "../shared/types";
import { mergeAgentActivity } from "./agent-activity";

export function useAgentActivities() {
  const [activities, setActivities] = useState<ReadonlyMap<string, AgentSessionActivity>>(() => new Map());
  const mergeActivity = useCallback((activity: AgentSessionActivity) => {
    setActivities((current) => mergeAgentActivity(current, activity));
  }, []);

  useEffect(() => {
    let gone = false;
    const api = window.harness.agent;
    // 开发时旧 preload 与新 renderer 可能短暂共存，仍保留原有聊天能力。
    if (!api.activities || !api.onActivity) return;
    const unsubscribe = api.onActivity(mergeActivity);
    void api.activities().then((snapshot) => {
      if (!gone) setActivities((current) => snapshot.reduce(mergeAgentActivity, current));
    }).catch(() => undefined);
    return () => { gone = true; unsubscribe(); };
  }, [mergeActivity]);

  return { activities, mergeActivity };
}
