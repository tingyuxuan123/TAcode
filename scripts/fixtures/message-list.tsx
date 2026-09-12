import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "../../src/renderer/i18n";
import { AssistantTurn, UserTurn } from "../../src/renderer/ui";
import { MessageList, type MessageListHandle, type MessageListItem } from "../../src/renderer/message-list";
import { useFollowScroll } from "../../src/renderer/use-follow-scroll";
import { turnAnchorId, type ChatMessage, type ToolActivity, type WorkItem } from "../../src/renderer/conversation";
import "../../src/renderer/styles.css";

/**
 * 消息列表窗口化探针：在生产组件链路（MessageList + useFollowScroll +
 * AssistantTurn/UserTurn）上跑真实浏览器布局，供 `scripts/message-list-smoke.ts`
 * 断言窗口化、滚动定位、跟随与布局正确性。
 *
 * 查询参数：`?turns=N`（默认 150）。
 */

const PARAGRAPHS = [
  "先把结论说清楚：卡的是渲染进程的主线程，不是网络。每次事件到达都会把整棵消息列表重新过一遍，历史越长，每帧的固定开销越高。",
  "窗口化之后，一帧里只有视口附近的那几条真正渲染，成本与可见范围相关，与历史长度无关。",
  "未测量的条目会先用估算高度占位，滚动到附近再校正；校正时需要保持阅读位置不跳动。",
  "滚动跟随要一次读完目标位置、一次写入，避免同一帧内读写交替导致的强制同步布局。",
];

const FIXED_TIME = 1_760_000_000_000;

function tools(index: number): ToolActivity[] {
  return [
    { id: `t${index}-1`, name: "read", title: "读取文件", status: "complete", startedAt: FIXED_TIME, endedAt: FIXED_TIME + 120, resultRecorded: true, output: "src/renderer/App.tsx" },
    { id: `t${index}-2`, name: "search", title: "搜索符号", status: "complete", startedAt: FIXED_TIME + 200, endedAt: FIXED_TIME + 640, resultRecorded: true, output: "3 处匹配" },
  ];
}

function turnMessages(index: number, text: string): ChatMessage[] {
  const work: WorkItem[] = [
    { type: "thinking", id: `think-${index}`, text: PARAGRAPHS[index % PARAGRAPHS.length]! },
    { type: "tool", id: `tool-t${index}-1`, toolId: `t${index}-1` },
    { type: "tool", id: `tool-t${index}-2`, toolId: `t${index}-2` },
    { type: "text", id: `beat-${index}`, text },
  ];
  return [{
    id: `assistant-${index}`,
    role: "assistant",
    text,
    streaming: false,
    timestamp: FIXED_TIME + index * 1000,
    images: [],
    tools: tools(index),
    work,
  }];
}

function Fixture({ turns }: { turns: number }) {
  const follow = useFollowScroll("fixture", true);
  const box = useRef<HTMLDivElement | null>(null);
  const setBox = useCallback((node: HTMLDivElement | null) => {
    box.current = node;
    follow.viewportRef(node);
  }, [follow.viewportRef]);
  const list = useRef<MessageListHandle>(null);
  const grownRef = useRef(0);
  const [tail, setTail] = useState(() => turnMessages(turns - 1, `### 第 ${turns} 轮\n\n${PARAGRAPHS[0]!}`));

  const canAutoCollapse = useCallback(() => follow.following.current, []);
  const onOpenFile = useCallback(() => undefined, []);

  const items: MessageListItem[] = [];
  for (let index = 0; index < turns; index += 1) {
    const anchor = turnAnchorId(`user-${index}`);
    items.push({
      key: `user-${index}`,
      anchor,
      render: () => <UserTurn anchor={anchor} text={`第 ${index + 1} 轮的问题：为什么会卡？`} />,
    });
    if (index === turns - 1) {
      items.push({
        key: `assistant-${index}`,
        render: () => (
          <AssistantTurn
            messages={tail}
            running
            canAutoCollapse={canAutoCollapse}
            onOpenFile={onOpenFile}
          />
        ),
      });
    } else {
      items.push({
        key: `assistant-${index}`,
        render: () => (
          <AssistantTurn
            messages={turnMessages(index, `### 第 ${index + 1} 轮\n\n${PARAGRAPHS[index % PARAGRAPHS.length]!}\n\n- 一条要点\n- 另一条要点`)}
            canAutoCollapse={canAutoCollapse}
            onOpenFile={onOpenFile}
          />
        ),
      });
    }
  }

  // 探针专用的读写面（供 smoke 脚本调用）；写在渲染里只做赋值，不触发状态更新。
  (window as unknown as Record<string, unknown>).__messageListFixture = {
    scrollToAnchor: (anchor: string) => list.current?.scrollToAnchor(anchor, { smooth: false, onSettled: () => follow.reanchor() }),
    anchorAt: (offset?: number) => list.current?.anchorAt(offset),
    reanchor: () => follow.reanchor(),
    grow: () => {
      const next = grownRef.current + 1;
      grownRef.current = next;
      setTail(turnMessages(turns - 1, `### 第 ${turns} 轮\n\n${PARAGRAPHS[next % PARAGRAPHS.length]!}\n\n${PARAGRAPHS[(next + 1) % PARAGRAPHS.length]!}\n\n${PARAGRAPHS[(next + 2) % PARAGRAPHS.length]!}`));
    },
    grown: () => grownRef.current,
    turns,
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="conversation" ref={setBox}>
        <MessageList
          ref={list}
          items={items}
          scrollerRef={box}
          contentRef={follow.contentRef}
        />
      </div>
    </div>
  );
}

// 探针页面不接主进程：给组件链用到的 harness 面（语言、外链、版本）一个最小实现。
(window as unknown as Record<string, unknown>).harness = {
  platform: "darwin",
  app: {
    getLocale: async () => "zh",
    openExternal: async () => undefined,
    version: async () => "0.0.0-probe",
  },
  browser: { onAgentPresentation: () => () => undefined },
};

const turns = Number(new URLSearchParams(location.search).get("turns") ?? "") || 150;
const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <Fixture turns={turns} />
    </LocaleProvider>
  </StrictMode>,
);
