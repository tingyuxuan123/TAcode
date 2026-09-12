import { useCallback, useLayoutEffect, useRef, useState } from "react";

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * 距离底部多近就直接贴底（不再缓动）。
 *
 * 流式期间内容每帧只长高几像素，缓动会一直落后一点点（实测距底平均 6.5px、139/835 帧
 * 超过 2px），滚动条于是每帧都在小幅追位置，看起来就是「抖」。近距直接贴底、
 * 远距（跳转/回到底部）仍然缓动滑行。
 */
const SNAP_DISTANCE = 96;

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

  const followLatest = useCallback(() => {
    if (!viewport || !enabled) return;
    following.current = true;
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
    setAtBottom(following.current);
    viewport.scrollTop = saved?.top ?? viewport.scrollHeight;
    currentTop.current = viewport.scrollTop;
    lastAssigned.current = viewport.scrollTop;
    capture();

    const intent = () => {
      if (viewport.scrollHeight <= viewport.clientHeight + 1) return;
      // 已在底部附近（如到底后再向下滚、触控板回弹）不视为离开，避免箭头误显示。
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distance <= 16) return;
      cancel();
      following.current = false;
      lastAssigned.current = undefined;
      setAtBottom(false);
      capture();
    };
    const key = (event: KeyboardEvent) => { if (scrollKeys.has(event.key)) intent(); };
    const scroll = () => {
      currentTop.current = viewport.scrollTop;
      if (resizeShield.current !== 0) return;
      if (lastAssigned.current !== undefined && Math.abs(lastAssigned.current - viewport.scrollTop) < 1) return;
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      // 跟随中：位置被动变化就立刻拉回底部。窗口化之后，滚动过程中会不断测量新进入
      // 视口的条目，虚拟列表会为了“保持内容位置”反方向微调 scrollTop（未测量条目的
      // 估算高度被真实高度替换时也会这样），单次就有几十到几百像素；如果把它当成
      // “用户离开了底部”，就会停在离底部一截的位置不再自愈。
      // 用户的主动滚动一定先经过 intent()（wheel/touchstart/pointerdown/键盘）把跟随
      // 关掉，所以这里不会和用户抢滚动。
      if (following.current) {
        if (distance > 1) followLatest();
        return;
      }
      // 已离开跟随：回到足够接近底部（较小阈值）才恢复跟随，形成滞回。
      const bottom = distance <= 16;
      following.current = bottom;
      setAtBottom(bottom);
      capture();
      if (bottom) followLatest();
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
    viewport.addEventListener("touchstart", intent, { passive: true });
    viewport.addEventListener("pointerdown", intent);
    viewport.addEventListener("keydown", key);
    viewport.addEventListener("scroll", scroll, { passive: true });
    resize();
    return () => {
      positions.current.set(scope, { top: currentTop.current, follow: following.current });
      if (positions.current.size > 30) positions.current.delete(positions.current.keys().next().value!);
      cancel();
      observer.disconnect();
      viewport.removeEventListener("wheel", intent);
      viewport.removeEventListener("touchstart", intent);
      viewport.removeEventListener("pointerdown", intent);
      viewport.removeEventListener("keydown", key);
      viewport.removeEventListener("scroll", scroll);
    };
  }, [scope, enabled, viewport, content, capture, cancel, followLatest]);

  return { viewportRef: setViewport, contentRef: setContent, atBottom, following, followLatest, reanchor };
}
