import { useLayoutEffect, useRef, useState } from "react";
import { nextStreamText } from "./stream-text";

export function useStreamText(text: string, streaming: boolean, identity: string) {
  const [shown, setShown] = useState({ identity, text });
  const current = useRef(shown);
  const queuedAt = useRef<number | undefined>(undefined);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  useLayoutEffect(() => {
    let frame: number | undefined;
    const sync = () => {
      current.current = { identity, text };
      queuedAt.current = undefined;
      setShown(current.current);
    };
    if (!streaming || reduced.matches || current.current.identity !== identity || !text.startsWith(current.current.text)) {
      sync();
      return;
    }
    if (current.current.text === text) return;
    queuedAt.current ??= performance.now();
    const advance = (now: number) => {
      const next = nextStreamText(current.current.text, text, now - queuedAt.current!);
      current.current = { identity, text: next };
      setShown(current.current);
      if (next !== text) frame = requestAnimationFrame(advance);
      else queuedAt.current = undefined;
    };
    frame = requestAnimationFrame(advance);
    const visibility = () => { if (document.hidden) { if (frame !== undefined) cancelAnimationFrame(frame); sync(); } };
    const preference = () => { if (reduced.matches) { if (frame !== undefined) cancelAnimationFrame(frame); sync(); } };
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", preference);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", preference);
    };
  }, [text, streaming, identity]);

  // Reparented blocks and historical messages never replay an old animation.
  return !streaming || reduced.matches || shown.identity !== identity || !text.startsWith(shown.text) ? text : shown.text;
}
