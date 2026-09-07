const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function nextStreamText(displayed: string, target: string, elapsed: number): string {
  if (!target.startsWith(displayed) || elapsed >= 160) return target;
  const remaining = Array.from(segmenter.segment(target.slice(displayed.length)), (part) => part.segment);
  return displayed + remaining.slice(0, Math.max(1, Math.ceil(remaining.length / 3))).join("");
}
