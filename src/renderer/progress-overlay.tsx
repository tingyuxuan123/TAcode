import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CheckCircle2, ChevronRight, CircleAlert, Clock, ListTodo, LoaderCircle } from "lucide-react";
import type { ProgressTask } from "./conversation";
import { useI18n } from "./i18n";

/** 完成/中断后保留反馈时长的毫秒数（对齐 Proma-main FINISH_RETENTION_MS）。 */
const FINISH_RETENTION_MS = 4_000;
const FADE_OUT_DURATION_MS = 200;

/** 终态状态集合（已完成/失败）——用于计算进度完成数。 */
function isTerminal(status: ProgressTask["status"]): boolean {
  return status === "completed" || status === "failed";
}

function statusGlyph(task: ProgressTask | undefined): ReactNode {
  if (!task) return <ListTodo size={15} aria-hidden="true" />;
  if (task.status === "running") return <LoaderCircle size={15} className="progress-spinner" aria-hidden="true" />;
  if (task.status === "completed") return <CheckCircle2 size={15} className="progress-ok" aria-hidden="true" />;
  if (task.status === "failed") return <CircleAlert size={15} className="progress-err" aria-hidden="true" />;
  // 等待中（已登记、还没轮到它跑）：用时钟表示排队，不要用清单图标——那是「无活动任务」的兜底图标。
  if (task.status === "pending") return <Clock size={15} className="progress-pending" aria-hidden="true" />;
  return <ListTodo size={15} aria-hidden="true" />;
}

function statusLabel(task: ProgressTask | undefined, t: ReturnType<typeof useI18n>["t"]): string {
  if (!task) return "";
  if (task.status === "running") return t("trace.delegateRunning");
  if (task.status === "pending") return t("trace.delegatePending");
  if (task.status === "failed") return t("trace.delegateFailed");
  return t("trace.delegateDone");
}

/** 计划步骤（顺序维度）。 */
function planRows(tasks: ProgressTask[]): ProgressTask[] {
  return tasks.filter((task) => task.kind !== "delegate");
}

/** 委派子任务（并行维度）。 */
function delegateRows(tasks: ProgressTask[]): ProgressTask[] {
  return tasks.filter((task) => task.kind === "delegate");
}

/** 当前正在进展的任务：优先计划步骤（顺序主线）；计划已走完但仍有子代理在跑时回落到子代理。 */
function currentTask(tasks: ProgressTask[]): ProgressTask | undefined {
  const plan = planRows(tasks);
  return plan.find((item) => item.status === "running")
    ?? plan.find((item) => !isTerminal(item.status))
    ?? tasks.find((item) => !isTerminal(item.status));
}

export interface ProgressOverlayProps {
  tasks: ProgressTask[];
  /** 是否仍在流式运行；为 false（完成/暂停/中断）时浮层进入收尾态并延迟隐藏。 */
  streaming: boolean;
  atBottom: boolean;
  onFollowLatest(): void;
  renderTaskDetail?(task: ProgressTask): ReactNode;
}

/**
 * 复合浮层：有任务活动（delegate/plan）时显示「完成数/总数 + 当前任务标题」单行进度，
 * 点击展开最小任务列表；无任务、且不在底部时退化为独立 ↓ 箭头；位于底部时隐藏。
 * 流式运行时保持展示；完成后短暂保留反馈（FINISH_RETENTION_MS）再淡出隐藏。
 * 对齐 Proma-main TaskProgressOverlay。
 */
export const ProgressOverlay = memo(function ProgressOverlay({
  tasks,
  streaming,
  atBottom,
  onFollowLatest,
  renderTaskDetail,
}: ProgressOverlayProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const timers = useRef<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // 展开时点击外部或按 ESC 关闭弹窗。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);


  // 流式运行时：清除收尾计时、确保可见。
  useEffect(() => {
    if (streaming) {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
      setFading(false);
      setVisible(true);
      return;
    }
    // 非流式：若当前仍展示任务，短暂保留反馈后淡出隐藏。
    if (tasks.length === 0) return;
    const fadeTimer = window.setTimeout(() => setFading(true), Math.max(0, FINISH_RETENTION_MS - FADE_OUT_DURATION_MS));
    const hideTimer = window.setTimeout(() => {
      setVisible(false);
      setOpen(false);
      setFading(false);
    }, FINISH_RETENTION_MS);
    timers.current = [fadeTimer, hideTimer];
    return () => {
      for (const timer of timers.current) window.clearTimeout(timer);
      timers.current = [];
    };
  }, [streaming, tasks.length]);

  const hasTasks = visible && tasks.length > 0;
  // 无任务但不处理浮层：仅在非底部且非流式收尾时仍展示箭头。
  if (!hasTasks) {
    if (atBottom) return null;
    // 流式运行但暂无任务、不在底部：仅箭头；非流式无任务：仅箭头。
    return (
      <button type="button" className="conversation-latest" title={t("flow.latest")} aria-label={t("flow.latest")} onClick={onFollowLatest}>
        <ArrowDown size={17} aria-hidden="true" />
      </button>
    );
  }

  // 计数口径：有计划时以计划步骤为分母，子代理另算一组；没有计划时退回扁平计数。
  const plan = planRows(tasks);
  const delegates = delegateRows(tasks);
  const counted = plan.length > 0 ? plan : tasks;
  const completed = counted.filter((item) => isTerminal(item.status)).length;
  const delegateCount = plan.length > 0 && delegates.length > 0
    ? t("inspect.delegates", {
      done: delegates.filter((item) => isTerminal(item.status)).length,
      total: delegates.length,
    })
    : "";
  // 流式运行时才把未完成项当作“当前任务”；完成后（收尾态）统一显示「任务已完成」。
  const active = streaming ? currentTask(tasks) : undefined;
  const liveActive = streaming && active?.status === "running" ? active : undefined;
  const pillLabel = active?.activeForm ?? active?.subject ?? t("task.doneLabel");
  const statusText = streaming && active && !isTerminal(active.status) ? statusLabel(active, t) : "";
  // 有计划时给步骤编号 1..N；子代理行不编号，靠缩进 + role chip 表达从属关系。
  const ordinals = new Map<string, number>();
  if (plan.length > 0) {
    let n = 0;
    for (const task of tasks) {
      if (task.kind === "delegate") continue;
      n += 1;
      ordinals.set(task.id, n);
    }
  }

  return (
    <div ref={rootRef} className={`progress-overlay${fading ? " fading" : ""}`}>
      {/* 不在底部时点击胶囊直接回到底部；已在底部时点击展开任务列表。 */}
      <div
        className="progress-overlay-trigger"
        role="button"
        tabIndex={0}
        aria-expanded={atBottom ? open : undefined}
        title={atBottom ? undefined : t("flow.latest")}
        onClick={() => {
          if (!atBottom) {
            setOpen(false);
            onFollowLatest();
            return;
          }
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!atBottom) {
              setOpen(false);
              onFollowLatest();
              return;
            }
            setOpen((value) => !value);
          }
        }}
      >
        {statusGlyph(liveActive ?? (active && isTerminal(active.status) ? active : undefined))}
        <span className="progress-overlay-count">{completed}/{counted.length}</span>
        <span className="progress-overlay-title">{pillLabel}</span>
        {statusText && <span className="progress-overlay-status">{statusText}</span>}
        {delegateCount && <span className="progress-overlay-status">{delegateCount}</span>}
        {atBottom
          ? <ChevronRight size={14} className={open ? "progress-chevron-rotated" : "progress-chevron"} aria-hidden="true" />
          : <ArrowDown size={14} className="progress-chevron" aria-hidden="true" />}
      </div>
      {open && (
        <div className="progress-overlay-popover">
          <div className="progress-overlay-head">
            <span>{t("inspect.progress")}</span>
            <span className="progress-overlay-head-count">
              {completed}/{counted.length}{delegateCount ? ` · ${delegateCount}` : ""}
            </span>
          </div>
          <ul className="progress-overlay-list">
            {tasks.map((task) => {
              // 非流式（收尾态）不把任务当作进行中，避免继续转圈。
              const displayTask = streaming ? task : (isTerminal(task.status) ? task : undefined);
              const nested = task.kind === "delegate" && Boolean(task.parentId);
              const ordinal = ordinals.get(task.id);
              // 子代理行固定显示短标题（完整 brief 留在 tooltip），正在执行的步骤挪到行尾状态位。
              const text = task.kind === "delegate" ? task.subject : task.activeForm ?? task.subject;
              const live = !isTerminal(task.status) && streaming ? task.activeForm?.trim() : undefined;
              const status = isTerminal(task.status) || streaming ? statusLabel(task, t) : t("task.doneLabel");
              return (
                <li
                  key={task.id}
                  className={`progress-task ${task.status}${nested ? " nested" : ""}${task.kind === "delegate" ? " delegated" : ""}`}
                >
                  <span className="progress-task-glyph">{statusGlyph(displayTask)}</span>
                  {ordinal && <span className="progress-task-ordinal">{ordinal}</span>}
                  {task.kind === "delegate" && task.role && <span className="progress-role-chip">{task.role}</span>}
                  <span className="progress-task-text" title={task.detail}>{text}</span>
                  <span className="progress-task-status">{task.kind === "delegate" && live && live !== text ? live : status}</span>
                  {renderTaskDetail?.(task)}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
});
