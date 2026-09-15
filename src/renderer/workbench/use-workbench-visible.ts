import { useLayoutEffect, useRef, useState } from "react";

/** Includes the outer drawer and background window, not only the selected tab. */
export function useWorkbenchVisible(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) { setVisible(false); return; }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      // Chromium can suspend animation frames while the window is hidden.
      // Release subscriptions immediately instead of waiting for such a frame.
      if (document.visibilityState === "hidden") { setVisible(false); return; }
      frame = requestAnimationFrame(() => setVisible(document.visibilityState !== "hidden" && element.clientWidth > 0 && element.clientHeight > 0));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.addEventListener("visibilitychange", measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("visibilitychange", measure); };
  }, [active]);
  return { ref, visible: active && visible };
}
