import { memo, useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle, Square } from "lucide-react";
import {
  delegateStatusLabel,
  groupConversation,
  normalizeMessages,
  type ChatMessage,
  type DelegateTaskStatus,
} from "../conversation";
import { useI18n } from "../i18n";
import { ApprovalCard, AssistantTurn, Markdown, UserTurn } from "../ui";
import { useFollowScroll } from "../use-follow-scroll";
import type { ChildSessionPanelInfo } from "./panel-state";

/** 运行中标签的刷新间隔：子会话 JSONL 边跑边写，面板按此频率跟随。 */
const POLL_MS = 2_000;
/** 常规任务状态复用委派卡片的文案，其余终态在面板单独翻译。 */
const TASK_STATUSES = new Set<string>(["pending", "running", "completed", "failed"]);

function statusText(status: string | undefined, t: ReturnType<typeof useI18n>["t"]): string {
  if (!status) return "";
  if (status === "cancelled") return t("subagent.stopped");
  if (status === "interrupted") return t("subagent.interrupted");
  if (status === "truncated") return t("subagent.limitReached");
  return TASK_STATUSES.has(status) ? delegateStatusLabel(status as DelegateTaskStatus) : status;
}

function formatElapsed(startedAt?: number, completedAt?: number): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round(((completedAt ?? Date.now()) - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 有子会话转录文件才读盘；进程内委派没有文件，只能看卡片上的报告/活动。 */
const isTranscriptPath = (value: string | undefined): boolean => Boolean(value && /\.jsonl$/i.test(value));

/** 去掉运行时注入给子代理的那段超长 prompt（面板顶部已单独展示委派任务）。 */
const INJECTED_PROMPT = /^\s*(You are the .{0,80}subagent inside TACode|You are the .{0,80} subagent inside TACode)/;

/**
 * 子代理子会话的只读视图（右侧面板标签）。
 *
 * 与「打开会话」的区别：不启动 worker、不改活动会话。有子会话文件时读盘渲染完整转录；
 * 没有文件（进程内委派）时回退展示卡片上的最终报告 + 活动流。两种形态都是只读。
 */
export const ChildSessionPanel = memo(function ChildSessionPanel({
  info,
  isActive,
  delegationId,
}: {
  info: ChildSessionPanelInfo;
  isActive: boolean;
  delegationId?: string;
}) {
  const { t } = useI18n();
  const sessionPath = info.sessionPath ?? "";
  const readable = isTranscriptPath(sessionPath);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(readable ? "loading" : "ready");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [controlError, setControlError] = useState("");
  const isRunning = info.status === "running" || info.status === "pending";

  /**
   * 子会话是只读直播：内容每 2s 追加一段，视图必须跟着最新走。
   * 用户往上滚时自动停止跟随、滚回底部附近再恢复（与主转录同一套语义）；
   * 标签页切回时容器尺寸变化会重新贴底（隐藏标签保持挂载、display:none → 尺寸 0）。
   */
  const follow = useFollowScroll(`child-session:${delegationId ?? sessionPath}`);

  useEffect(() => {
    setMessages([]);
    setPhase(readable ? "loading" : "ready");
    setError("");
    setTruncated(false);
    setControlError("");
  }, [readable, sessionPath]);

  useEffect(() => {
    if (!readable || !isActive) return;
    let gone = false;
    let loading = false;
    const load = (): void => {
      if (gone || loading) return;
      loading = true;
      // 桥接缺失/同步抛错都不该炸掉整个界面：统一转成 rejected promise 走下面的错误分支。
      void Promise.resolve()
        .then(() => window.harness.sessions.read(sessionPath))
        .then((transcript) => {
          if (gone) return;
          setMessages(normalizeMessages(transcript.messages));
          setTruncated(transcript.truncated);
          setPhase("ready");
        })
        .catch((cause: unknown) => {
          if (gone) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase("error");
        }).finally(() => { loading = false; });
    };
    load();
    // 长工具调用期间消息数可能很久不变，只有协调器的终态才算结束。
    // 终态变化会重新运行 effect，读取最后一次转录后停止轮询。
    const timer = isRunning ? window.setInterval(load, POLL_MS) : undefined;
    return () => {
      gone = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [readable, sessionPath, isActive, isRunning, info.completedAt]);

  const stop = async () => {
    if (!delegationId || stopping) return;
    setStopping(true);
    setControlError("");
    try { await window.harness.delegations.stop(delegationId); }
    catch (cause) { setControlError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };

  const groups = useMemo(() => {
    const visible = messages.filter((message, index) =>
      // 注入的 prompt 作为第一条 user 消息出现，隐藏它（任务单独展示）。
      !(index === 0 && message.role === "user" && INJECTED_PROMPT.test(message.text)));
    return groupConversation(visible);
  }, [messages]);
  const activity = info.activity ?? [];
  const meta = [
    info.uiRequest ? t("subagent.awaitingInput") : statusText(info.status, t),
    formatElapsed(info.startedAt, info.completedAt),
    info.toolCalls ? t("delegate.steps", { n: info.toolCalls }) : "",
    info.totalTokens ? `${info.totalTokens.toLocaleString()} tokens` : "",
  ].filter(Boolean);

  return (
    <div className="child-session-panel">
      <header className="child-session-head">
        <span className="child-session-role">{info.role}</span>
        {meta.length > 0 && <span className="child-session-meta">{meta.join(" · ")}</span>}
        <span className="child-session-live" aria-hidden="true">
          {isRunning && !info.uiRequest
            ? <LoaderCircle size={12} className="progress-spinner" />
            : info.status === "failed" ? <CircleAlert size={12} className="progress-err" /> : null}
        </span>
        {isRunning && delegationId && window.harness.delegations && (
          <button type="button" className="ghost child-session-stop" data-subagent-stop disabled={stopping} onClick={() => void stop()}>
            <Square size={11} fill="currentColor" aria-hidden="true" />
            {stopping ? t("subagent.stopping") : t("subagent.stop")}
          </button>
        )}
      </header>
      <div className="child-session-body" ref={follow.viewportRef}>
        {/* contentRef 必须挂在内层：只观察滚动容器本身，内容长高（容器高度不变）时不会触发。 */}
        <div className="child-session-flow" ref={follow.contentRef}>
          {controlError && <p className="child-session-note is-error" role="alert">{controlError}</p>}
          {info.status === "failed" && info.error && <p className="child-session-note is-error" role="alert">{info.error}</p>}
          {info.uiRequest && delegationId && (
            <ApprovalCard
              key={info.uiRequest.id}
              request={info.uiRequest}
              onDone={() => setControlError("")}
              onError={setControlError}
              onRespond={(response) => window.harness.delegations.respondToUi(delegationId, info.uiRequest!.id, response)}
            />
          )}
          {info.live?.trim() && isRunning && !info.uiRequest && (
            <p className="child-session-live-step">
              <LoaderCircle size={12} className="progress-spinner" aria-hidden="true" />
              <span>{info.live}</span>
            </p>
          )}
          {info.task?.trim() && <p className="child-session-task">{info.task}</p>}
          {truncated && <p className="child-session-note">{t("subagent.truncated")}</p>}
          {!readable && <p className="child-session-note">{t("subagent.noTranscript")}</p>}
          {readable && phase === "loading" && <p className="child-session-note">{t("preview.reading")}</p>}
          {readable && phase === "error" && <p className="child-session-note is-error">{error}</p>}
          {readable && phase === "ready" && groups.length === 0 && (
            <p className="child-session-note">{isRunning ? t("preview.reading") : t("chat.emptySession")}</p>
          )}
          {groups.map((group, index) => group.type === "user"
            ? <UserTurn key={group.id} text={group.message.text} images={group.message.images} />
            : (
              <AssistantTurn
                key={group.id}
                messages={group.messages}
                running={isRunning && index === groups.length - 1}
                canAutoCollapse={false}
              />
            ))}
          {info.report?.trim() && (!readable || phase === "error" || groups.length === 0) && (
            <section className="child-session-section">
              <h4>{t("delegate.detailReport")}</h4>
              <div className="child-session-report markdown"><Markdown>{info.report}</Markdown></div>
            </section>
          )}
          {activity.length > 0 && (
            <section className="child-session-section">
              <h4>{t("delegate.detailActivity")}</h4>
              <ul className="delegate-activity">
                {activity.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className={`delegate-activity-item kind-${entry.kind}${entry.isError ? " is-error" : ""}`}>
                    <time>{new Date(entry.at).toLocaleTimeString()}</time>
                    <span>{entry.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
});
