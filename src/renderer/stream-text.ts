const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface StreamTextValue {
  identity: string;
  text: string;
}

export interface StreamTextAnimatorOptions {
  initial: StreamTextValue;
  onChange(value: StreamTextValue): void;
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(id: number): void;
  now?: () => number;
  paused?: boolean;
  reducedMotion?: boolean;
}

export interface StreamTextAnimator {
  setTarget(value: StreamTextValue, streaming: boolean): void;
  setPaused(paused: boolean): void;
  setReducedMotion(reduced: boolean): void;
  syncToTarget(): void;
  dispose(): void;
}

export function nextStreamText(displayed: string, target: string, elapsed: number): string {
  if (!target.startsWith(displayed) || elapsed >= 160) return target;
  const remaining = Array.from(segmenter.segment(target.slice(displayed.length)), (part) => part.segment);
  return displayed + remaining.slice(0, Math.max(1, Math.ceil(remaining.length / 3))).join("");
}

/**
 * Keep one animation loop per streamed text block. Incoming snapshots only
 * replace `target`; they never cancel and recreate the RAF that is already
 * advancing `current`. This prevents a high-frequency stream from constantly
 * resetting its animation clock and gives the renderer one stable cadence.
 */
export function createStreamTextAnimator(options: StreamTextAnimatorOptions): StreamTextAnimator {
  let current = options.initial;
  let target = options.initial;
  let streaming = false;
  let paused = options.paused ?? false;
  let reducedMotion = options.reducedMotion ?? false;
  let frame: number | undefined;
  let queuedAt: number | undefined;
  let disposed = false;
  const now = options.now ?? (() => performance.now());

  const cancel = () => {
    if (frame !== undefined) options.cancelFrame(frame);
    frame = undefined;
  };

  const emit = (value: StreamTextValue) => {
    current = value;
    options.onChange(value);
  };

  const syncToTarget = () => {
    cancel();
    queuedAt = undefined;
    if (current.identity !== target.identity || current.text !== target.text) emit(target);
  };

  const canAnimate = () => (
    !disposed
    && !paused
    && !reducedMotion
    && streaming
    && current.identity === target.identity
    && target.text.startsWith(current.text)
    && target.text !== current.text
  );

  const advance = (timestamp: number) => {
    frame = undefined;
    if (!canAnimate()) {
      if (!paused && !reducedMotion && current.identity !== target.identity) syncToTarget();
      return;
    }
    const elapsed = timestamp - (queuedAt ?? timestamp);
    const text = nextStreamText(current.text, target.text, elapsed);
    if (text !== current.text) emit({ identity: current.identity, text });
    if (text === target.text) {
      queuedAt = undefined;
      return;
    }
    frame = options.requestFrame(advance);
  };

  const schedule = () => {
    if (!canAnimate() || frame !== undefined) return;
    queuedAt ??= now();
    frame = options.requestFrame(advance);
  };

  return {
    setTarget(value, nextStreaming) {
      if (disposed) return;
      target = value;
      streaming = nextStreaming;
      if (!streaming || paused || reducedMotion || current.identity !== value.identity || !value.text.startsWith(current.text)) {
        syncToTarget();
        return;
      }
      schedule();
    },
    setPaused(nextPaused) {
      if (disposed || paused === nextPaused) return;
      paused = nextPaused;
      if (paused) syncToTarget();
      else schedule();
    },
    setReducedMotion(nextReduced) {
      if (disposed || reducedMotion === nextReduced) return;
      reducedMotion = nextReduced;
      if (reducedMotion) syncToTarget();
      else schedule();
    },
    syncToTarget,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      queuedAt = undefined;
    },
  };
}
