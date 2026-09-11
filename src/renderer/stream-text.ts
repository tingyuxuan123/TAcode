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
  /** 覆盖落字间隔推导（测试注入用），默认 `streamEmitInterval`。 */
  emitInterval?(chars: number): number;
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
 * 落字最短间隔（毫秒）：文本越长，单次 Markdown 解析越贵（整段重解析 + 整棵子树
 * diff + 样式布局），而流式期间目标文本每帧都在变，逐帧落字就等于逐帧重解析。
 * 按长度分档限制落字频率，把解析次数从 60Hz 降到与文本长度相称的量级；
 * 短文本单次解析很便宜，保持逐帧，不做任何节流。
 */
export function streamEmitInterval(chars: number): number {
  if (chars <= 1200) return 0;
  if (chars <= 3000) return 24;
  if (chars <= 8000) return 48;
  if (chars <= 20000) return 80;
  return 120;
}

/**
 * Keep one animation loop per streamed text block. Incoming snapshots only
 * replace `target`; they never cancel and recreate the RAF that is already
 * advancing `current`. This prevents a high-frequency stream from constantly
 * resetting its animation clock and gives the renderer one stable cadence.
 *
 * 落字按 `emitInterval` 限频：帧循环仍在跑，但冷却帧不做分词、不落字，
 * 因而不会引发 React 渲染与 Markdown 重解析。
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
  const emitInterval = options.emitInterval ?? streamEmitInterval;
  let lastEmitAt = 0;

  const cancel = () => {
    if (frame !== undefined) options.cancelFrame(frame);
    frame = undefined;
  };

  const emit = (value: StreamTextValue, at = now()) => {
    current = value;
    lastEmitAt = at;
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
    // 冷却帧：只比一次时间，不做分词、不改状态，因此也不触发 React 渲染。
    if (timestamp - lastEmitAt < emitInterval(target.text.length)) {
      frame = options.requestFrame(advance);
      return;
    }
    const elapsed = timestamp - (queuedAt ?? timestamp);
    const text = nextStreamText(current.text, target.text, elapsed);
    if (text !== current.text) emit({ identity: current.identity, text }, timestamp);
    if (current.text === target.text) {
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
