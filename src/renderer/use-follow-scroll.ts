import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * 距离底部多近就直接贴底（不再缓动）。
 *
 * 流式期间内容每帧只长高几像素，缓动会一直落后一点点（实测距底平均 6.5px、139/835 帧
 * 超过 2px），滚动条于是每帧都在小幅追位置，看起来就是「抖」。近距直接贴底、
 * 远距（跳转/回到底部）仍然缓动滑行。
 */
const SNAP_DISTANCE = 96;

/** 用户手势把位置推离底部超过这么多像素，才算真的「离开了底部」。 */
export const RELEASE_DISTANCE = 2;

/** 不是用户手势造成的离开（跳转、历史加载、程序化位移）：回到这么近就恢复跟随。 */
export const REACQUIRE_DISTANCE = 16;

/**
 * 一次手势的时效（含触控板惯性尾）。
 *
 * 惯性滚动期间浏览器会持续派发 scroll 事件，但不再派发 wheel，所以要按「最近一次手势」
 * 判断这批位移是不是用户造成的，窗口必须盖住整段惯性。
 */
export const INTENT_WINDOW = 320;

export type ScrollIntent = "up" | "down" | "none";

/** `scrollIntent` 只关心事件里的这几个字段，便于单测直接传字面量。 */
export interface ScrollIntentEvent {
  type?: string;
  deltaY?: number;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Calculate one frame of the bottom-follow easing without reading the DOM. */
export function nextScrollTop(currentTop: number, target: number, dt: number, viewportHeight: number, reduced = false): number {
  const distance = target - currentTop;
  if (reduced || Math.abs(distance) < 1) return target;
  // 指数趋近 + 限速：近距离平滑收尾，远距离有界匀速滑行；
  // 步长按帧间隔换算，不同刷新率下速度一致。
  let step = distance * (1 - Math.exp(-dt / 45));
  const maxStep = Math.max(48, viewportHeight * 0.3) * (dt / 16.7);
  if (Math.abs(step) > maxStep) step = maxStep * Math.sign(step);
  return currentTop + step;
}

/**
 * 把一次输入手势翻译成滚动方向意图。
 *
 * 为什么要方向、而不是「离底部的距离」：跟随循环每帧都会把 `scrollTop` 贴回底部
 * （96px 内是瞬时贴底），所以向上的 wheel 事件到达时，距离几乎总是 0。旧的
 * `distance <= 16 就不算用户滚动` 判据因此在跟随期间永远不成立，用户滚出去的位移会被
 * 当成虚拟列表的被动补偿立刻拉回去——「往上滚一点就弹回底部」。方向判据不依赖距离，
 * 手势本身就能交出控制权。
 */
export function scrollIntent(event: ScrollIntentEvent): ScrollIntent {
  if (event.type === "wheel") {
    // Ctrl/⌘ + 滚轮是触控板捏合缩放（或浏览器缩放），内容并不滚动。
    if (event.ctrlKey || event.metaKey) return "none";
    const delta = event.deltaY ?? 0;
    if (delta < 0) return "up";
    if (delta > 0) return "down";
    // 纯横向滚动与零位移（惯性收尾）都不表达纵向意图。
    return "none";
  }
  if (event.type === "keydown") {
    const key = event.key;
    if (key === "ArrowUp" || key === "PageUp" || key === "Home") return "up";
    if (key === "ArrowDown" || key === "PageDown" || key === "End") return "down";
    // 空格 = 翻页向下；Shift+空格 = 翻页向上。
    if (key === " ") return event.shiftKey ? "up" : "down";
    return "none";
  }
  return "none";
}

/**
 * 跟随时，这次位置变化该不该把控制权交给用户。
 *
 * 只有「用户自己在往上滚、且位置确实动了」才交出跟随：虚拟列表/浏览器锚定的被动位移
 * 没有伴随手势，仍然由 followLatest 吸收掉，保持贴底。
 */
export function shouldReleaseFollow(distance: number, userScrollingUp: boolean): boolean {
  return distance > RELEASE_DISTANCE && userScrollingUp;
}

/**
 * 不在跟随时，什么时候恢复自动跟随（滞回）。
 *
 * 关键一条：用户主动往上滚离开后，不能再按「距底 16px 内」自动贴回去，否则小幅上滚
 * （触控板轻轻一推，位移常常不到 16px）又会被瞬时贴底打回；此时只有真触底，或者用户
 * 自己做出向下的手势滚回足够近，才恢复跟随。
 */
export function shouldReacquireFollow(input: { distance: number; intent: ScrollIntent; fresh: boolean; departed: boolean; within?: number }): boolean {
  const limit = input.within ?? REACQUIRE_DISTANCE;
  if (input.distance <= RELEASE_DISTANCE) return true;
  if (input.distance > limit) return false;
  if (!input.departed) return true;
  return input.fresh && input.intent === "down";
}

/**
 * 块内小滚动区（代码块、思考块）的「钉底」状态：内容增长时是否自动跟到最新。
 *
 * 与外层容器同一套手势判据，只是阈值更小（块的可视高度本来就只有几行）。不能只看
 * 「距底 ≤ 阈值」：贴底是一帧内瞬时完成的，用户往上滚几像素后距离仍在阈值内，下一次
 * 内容增长又会贴回底部——「往上滚一点就被拉回」的块内版。
 *
 * @param threshold 距底多少像素算「已经在底部」
 * @param onScroll  每次滚动回调（思考块用它同步上下渐隐遮罩）
 */
export function useScrollPin(threshold = 8, onScroll?: () => void) {
  const pinned = useRef(true);
  /** 程序化贴底自己触发的 scroll 事件不算用户滚动，要放行。 */
  const selfScroll = useRef(false);
  const lastIntent = useRef<{ direction: ScrollIntent; at: number }>({ direction: "none", at: 0 });
  /** 这次离开底部是不是用户手势造成的。 */
  const departed = useRef(false);
  const notify = useRef(onScroll);
  notify.current = onScroll;

  /** 贴到最新；返回是否写入（未钉底时不动，用户读到哪儿就是哪儿）。 */
  const stick = useCallback((node: HTMLElement | null): boolean => {
    if (!node || !pinned.current) return false;
    selfScroll.current = true;
    node.scrollTop = node.scrollHeight;
    // 已经在底部时不会触发 scroll 事件：兜底清掉标记，避免吞掉用户的下一次滚动。
    requestAnimationFrame(() => { selfScroll.current = false; });
    return true;
  }, []);

  /** 重新钉住（展开一块新内容，或换了一段文本时）。 */
  const reset = useCallback(() => {
    pinned.current = true;
    departed.current = false;
    lastIntent.current = { direction: "none", at: 0 };
  }, []);

  /** 滚动区的 ref 回调：装/拆手势与 scroll 监听（React 19 会调用它返回的清理函数）。 */
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return undefined;
    const onScrollEvent = () => {
      notify.current?.();
      if (selfScroll.current) {
        selfScroll.current = false;
        return;
      }
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const at = performance.now();
      const fresh = at - lastIntent.current.at < INTENT_WINDOW;
      pinned.current = shouldReacquireFollow({
        distance,
        intent: fresh ? lastIntent.current.direction : "none",
        fresh,
        departed: departed.current,
        within: threshold,
      });
      if (pinned.current) departed.current = false;
    };
    const onGesture = (event: Event) => {
      const direction = scrollIntent(event as ScrollIntentEvent);
      if (direction === "none") return;
      lastIntent.current = { direction, at: performance.now() };
      // 只有「往上」需要立刻处理：块内还有可滚空间时马上交给用户；往下滚回底部交给
      // scroll 事件里的滞回判据（这里不必先钉住）。
      if (direction !== "up") return;
      if (node.scrollHeight <= node.clientHeight + RELEASE_DISTANCE) return;
      pinned.current = false;
      departed.current = true;
    };
    node.addEventListener("scroll", onScrollEvent, { passive: true });
    node.addEventListener("wheel", onGesture, { passive: true });
    node.addEventListener("keydown", onGesture);
    return () => {
      node.removeEventListener("scroll", onScrollEvent);
      node.removeEventListener("wheel", onGesture);
      node.removeEventListener("keydown", onGesture);
    };
  }, [threshold]);

  return { attach, pinned, selfScroll, stick, reset };
}

/** Each viewport owns its follow intent; resizing content must not turn it back on. */
export function useFollowScroll(scope: string, enabled = true) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const following = useRef(true);
  const frame = useRef<number | undefined>(undefined);
  const lastAssigned = useRef<number | undefined>(undefined);
  const anchor = useRef<{ id: string; top: number } | undefined>(undefined);
  const positions = useRef(new Map<string, { top: number; follow: boolean }>());
  const currentTop = useRef(0);
  const resizeShield = useRef(0);
  const resizeEpoch = useRef(0);
  /** 用户往上滚的手势时效：这段时间内跟随循环让位，不写滚动位置。 */
  const upIntentUntil = useRef(0);
  /** 这次离开底部是不是用户手势造成的：决定要不要按「距底够近」自动恢复跟随。 */
  const departed = useRef(false);
  const lastIntent = useRef<{ direction: ScrollIntent; at: number }>({ direction: "none", at: 0 });
  /** 指针手势：按下且真的拖动过（拖滚动条、拖选到边缘）才算用户意图。 */
  const pointer = useRef({ down: false, moved: false, y: 0 });
  const touchStart = useRef<number | undefined>(undefined);

  const cancel = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);

  /** 记录视口上沿附近的那个锚点及其相对位置，供内容长高时保持阅读位置。 */
  const measureAnchor = useCallback(() => {
    if (!viewport || !content) return;
    const top = viewport.getBoundingClientRect().top;
    const nodes = content.querySelectorAll<HTMLElement>("[data-scroll-anchor]");
    const visible = Array.from(nodes).find((node) => node.getBoundingClientRect().bottom > top);
    anchor.current = visible ? { id: visible.dataset.scrollAnchor!, top: visible.getBoundingClientRect().top - top } : undefined;
  }, [viewport, content]);

  const capture = useCallback(() => {
    // 跟随中人不在阅读历史，位置本来就跟内容走，不需要锚点。
    if (following.current) return;
    measureAnchor();
  }, [following, measureAnchor]);

  /**
   * 重新记录锚点。程序化跳转（如轮次导航）会一次性改变滚动位置，之后的内容测量
   * 如果还按跳转前的锚点补偿，就会把跳转拉回去；跳转后立刻调用这个重新取样。
   */
  const reanchor = useCallback(() => { measureAnchor(); }, [measureAnchor]);
  const pause = useCallback(() => {
    cancel();
    following.current = false;
    departed.current = false;
    upIntentUntil.current = 0;
    lastIntent.current = { direction: "none", at: 0 };
    anchor.current = undefined;
    lastAssigned.current = undefined;
    setAtBottom(false);
  }, [cancel]);

  const followLatest = useCallback(() => {
    if (!viewport || !enabled) return;
    following.current = true;
    departed.current = false;
    upIntentUntil.current = 0;
    setAtBottom(true);
    // ResizeObserver can report several layout changes during one render. Keep
    // the existing loop alive so its next frame picks up the latest target
    // instead of restarting the easing from scratch on every report.
    if (frame.current !== undefined) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastFrame: number | undefined;
    const advance = (now: number) => {
      if (!following.current) {
        frame.current = undefined;
        return;
      }
      if (lastFrame === undefined) lastFrame = now;
      const dt = Math.min(64, Math.max(1, now - lastFrame));
      lastFrame = now;
      // 用户正在往上滚：这一帧让位，既不写位置也不结束循环——手势若是空响（没有真实位移），
      // 时效过后下一帧自动继续跟随。
      if (upIntentUntil.current > now) {
        frame.current = requestAnimationFrame(advance);
        return;
      }
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const next = Math.abs(target - viewport.scrollTop) <= SNAP_DISTANCE
        ? target
        : nextScrollTop(viewport.scrollTop, target, dt, viewport.clientHeight, reduced);
      viewport.scrollTop = next;
      lastAssigned.current = viewport.scrollTop;
      currentTop.current = viewport.scrollTop;
      if (next === target) {
        frame.current = undefined;
        return;
      }
      frame.current = requestAnimationFrame(advance);
    };
    frame.current = requestAnimationFrame(advance);
  }, [viewport, enabled]);

  useLayoutEffect(() => {
    if (!enabled || !viewport || !content) return;
    const saved = positions.current.get(scope);
    following.current = saved?.follow ?? true;
    departed.current = false;
    upIntentUntil.current = 0;
    lastIntent.current = { direction: "none", at: 0 };
    pointer.current = { down: false, moved: false, y: 0 };
    touchStart.current = undefined;
    setAtBottom(following.current);
    viewport.scrollTop = saved?.top ?? viewport.scrollHeight;
    currentTop.current = viewport.scrollTop;
    lastAssigned.current = viewport.scrollTop;
    capture();

    /** 记下一次方向手势；只有「向上」会打断跟随。 */
    const noteIntent = (direction: ScrollIntent) => {
      if (direction === "none") return;
      // 内容还没超出一屏，没有「往上翻」这回事，也就不该亮出「回到最新」。
      if (viewport.scrollHeight <= viewport.clientHeight + 1) return;
      const at = performance.now();
      lastIntent.current = { direction, at };
      if (direction === "up") upIntentUntil.current = at + INTENT_WINDOW;
    };
    const intent = (event: Event) => noteIntent(scrollIntent(event as ScrollIntentEvent));
    /** 交给用户：取消跟随、记住这次是用户手势离开、重新取样阅读锚点。 */
    const release = () => {
      cancel();
      following.current = false;
      departed.current = true;
      upIntentUntil.current = 0;
      lastAssigned.current = undefined;
      setAtBottom(false);
      capture();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchStart.current = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const start = touchStart.current;
      const y = event.touches[0]?.clientY;
      if (start === undefined || y === undefined) return;
      // 手指往屏幕下方拖 = 内容往下走 = 在往上翻历史。
      if (y - start > 4) noteIntent("up");
    };
    const onTouchEnd = () => { touchStart.current = undefined; };
    const onPointerDown = (event: PointerEvent) => {
      pointer.current = { down: true, moved: false, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      const state = pointer.current;
      if (!state.down) return;
      if (Math.abs(event.clientY - state.y) > 4) state.moved = true;
    };
    const onPointerUp = () => { pointer.current = { down: false, moved: false, y: pointer.current.y }; };
    const scroll = () => {
      currentTop.current = viewport.scrollTop;
      if (resizeShield.current !== 0) return;
      if (lastAssigned.current !== undefined && Math.abs(lastAssigned.current - viewport.scrollTop) < 1) return;
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      // 跟随中：位置被动变化就立刻拉回底部。窗口化之后，滚动过程中会不断测量新进入
      // 视口的条目，虚拟列表会为了“保持内容位置”反方向微调 scrollTop（未测量条目的
      // 估算高度被真实高度替换时也会这样），单次就有几十到几百像素；如果把它当成
      // “用户离开了底部”，就会停在离底部一截的位置不再自愈。
      // 用户自己的滚动一定伴随手势（wheel / 触摸拖动 / 拖滚动条 / 键盘），所以这里按
      // 手势判方向：手势往上就交出控制权，没有手势的位移才当成被动补偿吸收掉。
      if (following.current) {
        const userUp = upIntentUntil.current > performance.now() || (pointer.current.down && pointer.current.moved);
        if (shouldReleaseFollow(distance, userUp)) release();
        else if (distance > 1) followLatest();
        return;
      }
      // 已离开跟随：回到足够接近底部（较小阈值）才恢复跟随，形成滞回；用户主动上滚
      // 离开的场合还要等他真的往下滚（见 shouldReacquireFollow）。
      const at = performance.now();
      const fresh = at - lastIntent.current.at < INTENT_WINDOW;
      const bottom = shouldReacquireFollow({
        distance,
        intent: fresh ? lastIntent.current.direction : "none",
        fresh,
        departed: departed.current,
      });
      if (bottom) {
        departed.current = false;
        capture();
        followLatest();
        return;
      }
      setAtBottom(false);
      capture();
    };
    const resize = (entries: ResizeObserverEntry[] = []) => {
      if (following.current && entries.some((entry) => entry.target === viewport)) {
        // A viewport resize can clamp scrollTop before the observer callback.
        // Shield that browser-generated scroll event from the user-intent
        // handler, just like codeg-main's resizeDifference guard.
        const epoch = ++resizeEpoch.current;
        resizeShield.current = epoch;
        requestAnimationFrame(() => {
          window.setTimeout(() => {
            if (resizeShield.current === epoch) resizeShield.current = 0;
          }, 1);
        });
      }
      if (following.current) {
        followLatest();
      } else if (anchor.current) {
        const savedAnchor = anchor.current;
        const node = Array.from(content.querySelectorAll<HTMLElement>("[data-scroll-anchor]")).find((item) => item.dataset.scrollAnchor === savedAnchor.id);
        if (node) {
          const shift = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - savedAnchor.top;
          if (Math.abs(shift) > 0.5) {
            viewport.scrollTop += shift;
            lastAssigned.current = viewport.scrollTop;
            currentTop.current = viewport.scrollTop;
          }
        }
        capture();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("wheel", intent, { passive: true });
    viewport.addEventListener("touchstart", onTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: true });
    viewport.addEventListener("touchend", onTouchEnd, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("pointercancel", onPointerUp);
    viewport.addEventListener("keydown", intent);
    viewport.addEventListener("scroll", scroll, { passive: true });
    resize();
    return () => {
      positions.current.set(scope, { top: currentTop.current, follow: following.current });
      if (positions.current.size > 30) positions.current.delete(positions.current.keys().next().value!);
      cancel();
      observer.disconnect();
      viewport.removeEventListener("wheel", intent);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchmove", onTouchMove);
      viewport.removeEventListener("touchend", onTouchEnd);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("pointercancel", onPointerUp);
      viewport.removeEventListener("keydown", intent);
      viewport.removeEventListener("scroll", scroll);
    };
  }, [scope, enabled, viewport, content, capture, cancel, followLatest]);

  return { viewportRef: setViewport, contentRef: setContent, atBottom, following, followLatest, reanchor, pause };
}
