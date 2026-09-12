import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Virtualizer, type VirtualizerHandle, type CacheSnapshot } from "virtua";

/**
 * 会话消息列表的窗口化渲染（借鉴 codeg-main：virtua + 稳定 memo 的历史条目）。
 *
 * 为什么不用 `groups.map` 直接铺满 DOM：一次 agent 运行会持续把事件写进
 * `messages`，父组件每帧重渲染时整棵列表都要重新遍历、提交；历史越长，每帧的
 * 固定成本越高，和滚动抢主线程，于是「运行中滚动」明显掉帧。窗口化之后，一帧里
 * 只有视口附近的几条真正渲染（组件、Markdown、代码高亮、DOM），成本与历史长度解耦。
 *
 * 约定：
 * - 滚动容器由调用方提供（`scrollerRef`，即 `.conversation`），本组件只是它内部
 *   的内容块；`contentRef` 挂在内容块上，供 `useFollowScroll` 观察高度与查找锚点。
 * - 每个条目自带渲染函数，只有进入视口（含 `bufferSize` 缓冲）的条目会被调用，
 *   因此未被挂载的条目不会产生任何组件渲染与 DOM。
 * - 条目高度由 virtua 测量；未测量过的条目先用估算高度，滚动到附近时再校正。
 * - 条目对象在调用方按组缓存（流式期间未变的条目保持同一引用），配合下面的
 *   `MemoItem`，纯内容更新帧里已挂载的历史条目会整体跳过对账。
 */
export interface MessageListItem {
  /** React key，同时作为条目的稳定标识。 */
  key: string;
  /** 用户提问轮的锚点 id（`turnAnchorId`），供轮次导航跳转。 */
  anchor?: string;
  render(): ReactNode;
}

export interface MessageListHandle {
  /**
   * 跳到某个锚点所在的条目；该条目可能尚未挂载。
   *
   * 目标条目之前从未挂载过时，第一跳用的是估算高度；条目挂载并测量后，
   * 估算误差会落在起始偏移上，所以再补两跳把位置收敛，
   * 最后在测量稳定时回调 `onSettled`（调用方用它重新取样滚动锚点）。
   */
  scrollToAnchor(anchor: string, options?: { smooth?: boolean; onSettled?: () => void }): void;
  /** 当前阅读位置对应的锚点：最后一条已滚过顶部 `offset` 像素的提问轮。 */
  anchorAt(offset?: number): string | undefined;
}

/**
 * 已测条目高度的跨会话缓存：key 是条目 key（消息 id），value 是最近一次测得的
 * 内容高度（px，含上下 margin）。virtua 实例随会话切换重建，自身的测量结果
 * 会丢掉——没有这层缓存，重开一个长会话时所有条目都从「默认 40px」起步，
 * 总高度严重失真，滚动条与跳转落点会连续跳好几帧才收敛。
 */
const measuredHeights = new Map<string, number>();
const MEASURED_HEIGHTS_LIMIT = 4000;

function rememberMeasuredHeight(key: string, height: number): void {
  if (measuredHeights.size >= MEASURED_HEIGHTS_LIMIT && !measuredHeights.has(key)) {
    const oldest = measuredHeights.keys().next().value;
    if (oldest !== undefined) measuredHeights.delete(oldest);
  }
  measuredHeights.set(key, height);
}

/**
 * 把缓存换算成 virtua 的挂载快照（对齐当前条目顺序；没量过的条目记 -1）。
 * `defaultSize` 用已测高度的中位数：条目高度从几十 px（提问轮）到上万 px
 * （长回答）差两个数量级，中位数比均值抗离群。
 */
function buildCacheSnapshot(items: MessageListItem[], heightKey: (item: MessageListItem) => string): CacheSnapshot {
  const sizes: number[] = [];
  const measured: number[] = [];
  for (const item of items) {
    const height = measuredHeights.get(heightKey(item));
    if (height === undefined) {
      sizes.push(-1);
      continue;
    }
    sizes.push(height);
    measured.push(height);
  }
  if (!measured.length) return [sizes];
  const sorted = [...measured].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle! - 1]! + sorted[middle]!) / 2);
  return [sizes, median];
}

/**
 * 单条目渲染的 memo 壳：条目对象引用不变时整棵子树跳过对账。
 * 流式每帧只重建最后一两条的条目对象（见 App 的 listItems 缓存），
 * 视口里其余历史条目在这里被挡住，不再产生每帧的元素 diff。
 */
const MemoItem = memo(function MemoItem({ item, index, first, last, recordHeight }: {
  item: MessageListItem;
  index: number;
  first: boolean;
  last: boolean;
  /** 记录本条目实测高度的回调（含会话隔离，见 MessageList）。 */
  recordHeight(item: MessageListItem, node: HTMLElement): void;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const record = () => recordHeight(item, node);
    record();
    const observer = new ResizeObserver(record);
    observer.observe(node);
    return () => observer.disconnect();
  }, [item.key, recordHeight]);
  const classes = ["message-item"];
  if (first) classes.push("first");
  if (last) classes.push("last");
  return <div className={classes.join(" ")} data-index={index} ref={nodeRef}>{item.render()}</div>;
}, (previous, next) =>
  previous.item === next.item && previous.index === next.index
  && previous.first === next.first && previous.last === next.last
  && previous.recordHeight === next.recordHeight);

export const MessageList = forwardRef<MessageListHandle, {
  items: MessageListItem[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  contentRef: (node: HTMLDivElement | null) => void;
  /** 有进行中的任务时给底部留出进度胶囊的高度。 */
  progressActive?: boolean;
  /** 视口外额外挂载的像素高度；越大越不容易在快速滚动时露白。 */
  bufferSize?: number;
  /**
   * 高度缓存的会话标识：同一会话的条目高度只在会话内复用。换会话时
   * 条目 key 可能与别的会话撞车（消息 id 在不同会话里可重复），靠它隔开。
   */
  cacheKey?: string;
}>(function MessageList({ items, scrollerRef, contentRef, progressActive = false, bufferSize = 1200, cacheKey = "" }, ref) {
  const virtualizer = useRef<VirtualizerHandle>(null);

  // 高度缓存按会话隔离：不同会话的消息 id 可能撞车，把 cacheKey 拼进缓存键。
  const recordHeight = useCallback((item: MessageListItem, node: HTMLElement) => {
    const style = getComputedStyle(node);
    const height = node.offsetHeight + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
    if (height > 0) rememberMeasuredHeight(`${cacheKey}\u0000${item.key}`, Math.round(height));
  }, [cacheKey]);

  // virtua 只在挂载时消费 `cache` 快照；这里按「会话 + 条目数」缓存最近一份，
  // 避免流式期间每帧都重建 O(条目数) 的快照对象。
  const snapshotRef = useRef<{ key: string; length: number; snapshot: CacheSnapshot } | null>(null);
  const cache = useMemo(() => {
    const cached = snapshotRef.current;
    if (cached && cached.key === cacheKey && cached.length === items.length) return cached.snapshot;
    const snapshot = buildCacheSnapshot(items, (item) => `${cacheKey}\u0000${item.key}`);
    snapshotRef.current = { key: cacheKey, length: items.length, snapshot };
    return snapshot;
  }, [items, cacheKey]);

  useImperativeHandle(ref, () => ({
    scrollToAnchor(anchor, options = {}) {
      const index = items.findIndex((item) => item.anchor === anchor);
      const box = scrollerRef.current;
      const handle = virtualizer.current;
      if (index < 0 || !box || !handle) return;
      const { smooth = true, onSettled } = options;
      handle.scrollToIndex(index, { align: "start", smooth });

      // virtua 按自己记录的条目偏移滚动；目标条目此前没挂载过时偏移是估算值，
      // 挂载测量后起始偏移会被修正，落点会差出一截。所以滚动到位后再按真实 DOM
      // 位置逐帧校正，直到稳定（平滑滚动期间不插手，等它自己停下来）。
      let frames = 0;
      let stable = 0;
      let lastActivity = performance.now();
      let lastCorrection = 0;
      let corrections = 0;
      let settled = false;
      const touch = () => { lastActivity = performance.now(); };
      const finish = () => {
        if (settled) return;
        settled = true;
        box.removeEventListener("scroll", touch);
        onSettled?.();
      };
      box.addEventListener("scroll", touch, { passive: true });
      const tick = () => {
        if (settled) return;
        const node = box.querySelector<HTMLElement>(`.message-item[data-index="${index}"]`);
        const idle = performance.now() - lastActivity > 120;
        if (node) {
          const delta = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
          if (Math.abs(delta) <= 1) {
            stable += 1;
            if (stable >= 3 && idle) { finish(); return; }
          } else if (!smooth || idle) {
            stable = 0;
            box.scrollTop += delta;
            lastActivity = performance.now();
          }
        } else if (idle && performance.now() - lastCorrection > 300 && corrections < 8) {
          // 目标条目还没挂载：跳进「从未测量过」的区域时，virtua 会在测量条目后为
          // 保持内容位置把 scrollTop 反向推走。逐帧去抢会跟它的内部状态拉锯
          // （实测永不收敛），所以只在完全安静 150ms 后补一次 scrollToIndex——
          // 它同步更新 virtua 内部状态和 DOM；每轮修正后测量误差都比上轮小。
          corrections += 1;
          lastCorrection = performance.now();
          stable = 0;
          handle.scrollToIndex(index, { align: "start", smooth: false });
          lastActivity = lastCorrection;
        }
        frames += 1;
        if (frames < 240 && (frames < 120 || corrections < 8)) requestAnimationFrame(tick);
        else finish();
      };
      requestAnimationFrame(tick);
    },
    anchorAt(offset = 160) {
      const box = scrollerRef.current;
      const handle = virtualizer.current;
      if (!box || !handle) return undefined;
      const line = box.scrollTop + offset;
      let found: string | undefined;
      items.forEach((item, index) => {
        if (!item.anchor) return;
        if (handle.getItemOffset(index) < line) found = item.anchor;
      });
      return found;
    },
  }), [items, scrollerRef]);

  // 条目渲染函数只在条目进入视口时才被调用；`first` / `last` 用来把列表内边距与
  // 末条边距交给真实的首/尾条目（`.turn:last-child` 在窗口化后匹配不到真实末条）。
  const renderItem = useCallback((item: MessageListItem, index: number) => (
    <MemoItem
      item={item}
      index={index}
      first={index === 0}
      last={index === items.length - 1}
      recordHeight={recordHeight}
    />
  ), [items.length, recordHeight]);

  return (
    <div className={progressActive ? "messages has-progress" : "messages"} ref={contentRef}>
      <Virtualizer ref={virtualizer} data={items} scrollRef={scrollerRef} bufferSize={bufferSize} cache={cache}>
        {renderItem}
      </Virtualizer>
    </div>
  );
});
