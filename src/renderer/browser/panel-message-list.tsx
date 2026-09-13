import { memo, useMemo, useRef, type RefObject } from "react";
import type { ConversationGroup } from "../conversation";
import { MessageList, type MessageListItem } from "../message-list";
import { AssistantTurn, UserTurn } from "../ui";

const noContentRef = () => {};
type Item = { group: ConversationGroup; running: boolean; awaiting: boolean; stopping: boolean; item: MessageListItem };

/** 使用主对话同一套窗口化与条目缓存；稳定的历史消息不重复排版。 */
export const PanelMessageList = memo(function PanelMessageList({ groups, running, awaiting = false, stopping = false, scope, scrollerRef }: {
  groups: ConversationGroup[];
  running: boolean;
  awaiting?: boolean;
  stopping?: boolean;
  scope: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
}) {
  const cache = useRef(new Map<string, Item>());
  const items = useMemo(() => {
    const next = new Map<string, Item>();
    const items = groups.map((group, index) => {
      const last = index === groups.length - 1;
      const state = { running: last && running, awaiting: last && awaiting, stopping: last && stopping };
      const previous = cache.current.get(group.id);
      if (previous?.group === group && previous.running === state.running && previous.awaiting === state.awaiting && previous.stopping === state.stopping) {
        next.set(group.id, previous);
        return previous.item;
      }
      const item: MessageListItem = { key: group.id, render: () => group.type === "user"
        ? <UserTurn text={group.message.text} images={group.message.images} />
        : <AssistantTurn messages={group.messages} {...state} canAutoCollapse={false} /> };
      next.set(group.id, { group, ...state, item });
      return item;
    });
    cache.current = next;
    return items;
  }, [groups, running, awaiting, stopping]);
  return <MessageList items={items} scrollerRef={scrollerRef} contentRef={noContentRef} cacheKey={scope} bufferSize={600} />;
});
