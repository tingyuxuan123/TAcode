import { useCallback, useLayoutEffect, useRef, useState } from "react";

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

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
    cancel();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastFrame: number | undefined;
    const advance = (now: number) => {
      if (!following.current) return;
      if (lastFrame === undefined) lastFrame = now;
      const dt = Math.min(64, Math.max(1, now - lastFrame));
      lastFrame = now;
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const distance = target - viewport.scrollTop;
      if (reduced || Math.abs(distance) < 1) {
        viewport.scrollTop = target;
        lastAssigned.current = viewport.scrollTop;
        currentTop.current = viewport.scrollTop;
        frame.current = undefined;
        return;
      }
      // 指数趋近 + 限速：近距离平滑收尾，远距离有界匀速滑行，任何距离都不瞬移；
      // 步长按帧间隔换算，不同刷新率下速度一致。流式追加内容时 target 每帧重算，持续跟随。
      let step = distance * (1 - Math.exp(-dt / 45));
      const maxStep = Math.max(48, viewport.clientHeight * 0.3) * (dt / 16.7);
      if (Math.abs(step) > maxStep) step = maxStep * Math.sign(step);
      viewport.scrollTop += step;
      lastAssigned.current = viewport.scrollTop;
      currentTop.current = viewport.scrollTop;
      frame.current = requestAnimationFrame(advance);
    };
    frame.current = requestAnimationFrame(advance);
  }, [viewport, enabled, cancel]);

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
      following.current = bottom;
      setAtBottom(bottom);
      capture();
    };
    const resize = () => {
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
