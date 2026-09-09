import { useCallback, useLayoutEffect, useRef, useState } from "react";

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

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

  const capture = useCallback(() => {
    if (!viewport || !content || following.current) return;
    const top = viewport.getBoundingClientRect().top;
    const nodes = content.querySelectorAll<HTMLElement>("[data-scroll-anchor]");
    const visible = Array.from(nodes).find((node) => node.getBoundingClientRect().bottom > top);
    anchor.current = visible ? { id: visible.dataset.scrollAnchor!, top: visible.getBoundingClientRect().top - top } : undefined;
  }, [viewport, content]);

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
      const next = nextScrollTop(viewport.scrollTop, target, dt, viewport.clientHeight, reduced);
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
      let bottom;
      if (following.current) {
        // 正在跟随：仅在明显离开底部（超过较大阈值）时翻转，避免阈值边缘抖动。
        bottom = distance <= 32;
      } else {
        // 已离开跟随：回到足够接近底部（较小阈值）才恢复跟随，形成滞回。
        bottom = distance <= 16;
      }
      const wasFollowing = following.current;
      following.current = bottom;
      setAtBottom(bottom);
      capture();
      // 用户从历史滚回底部即自动恢复跟随：立即吸附到最底并进入后续自动跟随，
      // 无需手动点“到最新”。只在“非跟随 → 回到底部”时触发，避免跟随中的重复调用。
      if (bottom && !wasFollowing) followLatest();
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

  return { viewportRef: setViewport, contentRef: setContent, atBottom, following, followLatest };
}
