import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createStreamTextAnimator, type StreamTextAnimator } from "./stream-text";

export function useStreamText(text: string, streaming: boolean, identity: string) {
  const [shown, setShown] = useState({ identity, text });
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);
  const animator = useRef<StreamTextAnimator | undefined>(undefined);
  if (!animator.current) {
    animator.current = createStreamTextAnimator({
      initial: { identity, text },
      onChange: setShown,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      reducedMotion: reduced.matches,
    });
  }

  useLayoutEffect(() => {
    const controller = animator.current!;
    controller.setTarget({ identity, text }, streaming);
  }, [identity, streaming, text]);

  useEffect(() => {
    const controller = animator.current!;
    const visibility = () => controller.setPaused(document.hidden);
    const preference = () => controller.setReducedMotion(reduced.matches);

    visibility();
    preference();
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", preference);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", preference);
    };
  }, [reduced]);

  useEffect(() => () => {
    animator.current?.dispose();
  }, []);

  // Reparented blocks and historical messages never replay an old animation.
  return !streaming || reduced.matches || shown.identity !== identity || !text.startsWith(shown.text) ? text : shown.text;
}
