import { useEffect, useMemo, useRef } from "react";
import type { ChatMessage } from "../conversation";
import type { useBrowserPanels } from "./use-browser-panels";
import { collectDelegations, mergeDelegationSummaries, planDelegationTabs } from "./delegation-tabs";
import type { DelegationRecords } from "../delegation-state";

const EMPTY_RECORDS: DelegationRecords = new Map();

/**
 * 父代理**创建子代理**时自动在右侧面板开一个标签，并实时刷新它的状态。
 *
 * 对齐 Proma（`useGlobalAgentListeners.ts:759-777`）：收到「子会话已启动」就打开右侧面板并
 * 激活该标签，让用户能看到子代理的执行过程。TACode 里的「启动事件」就是当前会话里出现的
 * delegate 工具条目（后台会话的事件不会进入当前 messages，因此天然只在父会话在前台时触发）。
 *
 * 边界：
 * - 只对**正在执行**的委派自动开标签；重开会话时见到的历史已完成委派不会弹一堆标签。
 * - 首次出现抢焦点（和 Proma 一致），之后的实时刷新用 `activate:false`，不顶掉用户正在看的标签。
 * - 用户手动关掉后不再自动重开；进程内委派（没有子会话文件）不自动开面板。
 */
export function useDelegationTabs(
  messages: ChatMessage[],
  panels: Pick<ReturnType<typeof useBrowserPanels>, "tabs" | "openChildSession">,
  records: DelegationRecords = EMPTY_RECORDS,
  parentSessionPath?: string,
): void {
  const autoOpened = useRef(new Set<string>());
  const lastSignature = useRef("");
  const summaries = useMemo(() => collectDelegations(messages), [messages]);
  const openKeys = useMemo(
    () => new Set(panels.tabs.filter((tab) => tab.type === "child-session").map((tab) => tab.key)),
    [panels.tabs],
  );
  const openChildSession = panels.openChildSession;
  const delegations = useMemo(() => mergeDelegationSummaries(summaries, records, parentSessionPath, openKeys), [summaries, records, parentSessionPath, openKeys]);

  useEffect(() => {
    // 流式期间 messages 每帧都变，用签名挡掉无变化的重复派发；
    // 派发后 tabs 变化会再跑一次，这里直接短路（不会形成循环）。
    const signature = JSON.stringify([delegations, [...openKeys]]);
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    const plan = planDelegationTabs({ delegations, openKeys, autoOpenedKeys: autoOpened.current });
    if (plan.autoOpened.length === 0 && plan.requests.length === 0) return;
    for (const key of plan.autoOpened) autoOpened.current.add(key);
    for (const request of plan.requests) {
      openChildSession(request.key, request.info, { activate: request.activate });
    }
  }, [delegations, openKeys, openChildSession]);
}
