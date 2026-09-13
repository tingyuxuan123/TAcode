import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Square } from "lucide-react";
import {
  applyAgentEvent,
  delegateStatusLabel,
  groupConversation,
  markRunningTail,
  normalizeMessages,
  type ChatMessage,
  type DelegateTaskStatus,
} from "../conversation";
import { useI18n } from "../i18n";
import { ApprovalCard, AssistantTurn, Markdown, UserTurn } from "../ui";
import { useFollowScroll } from "../use-follow-scroll";
import type { AgentEvent } from "../../shared/types";
import type { ChildSessionPanelInfo } from "./panel-state";

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
 * 子代理子会话的只读直播视图（右侧面板标签）。
 *
 * 与「打开会话」的区别：不启动 worker、不改活动会话。运行中订阅委派的实时事件流
 * （`delegations.onAgentEvent`）边跑边渲染，与侧聊同一套机制；初始加载与终态对账
 * 读子会话转录补齐已完成的前缀。没有文件（进程内委派）时回退展示卡片上的最终报告。
 * 两种形态都是只读。
 */
export const ChildSessionPanel = memo(function ChildSessionPanel({
  info,
  delegationId,
}: {
  info: ChildSessionPanelInfo;
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
   * 子会话是实时直播（与侧聊同一套机制）：worker 的事件流推流式文本与工具行，
   * JSONL 只在消息完成时落盘，仅用于初始加载与终态对账。初次读盘返回前到达的
   * 事件先在这里排队，读盘后按序补齐——与主会话 snapshot+replay 的次序语义一致。
   * null 表示快照已落定，之后的事件直接套到当前消息列表上。
   */
  const pendingRef = useRef<AgentEvent[] | null>([]);

  /**
   * 直播内容不断追加，视图必须跟着最新走。用户往上滚时自动停止跟随、
   * 滚回底部附近再恢复（与主转录同一套语义）；标签页切回时容器尺寸变化会重新贴底
   * （隐藏标签保持挂载、display:none → 尺寸 0）。
   */
  const follow = useFollowScroll(`child-session:${delegationId ?? sessionPath}`);

  useEffect(() => {
    pendingRef.current = [];
    setMessages([]);
    setPhase(readable ? "loading" : "ready");
    setError("");
    setTruncated(false);
    setControlError("");
  }, [readable, sessionPath]);

  // 初始加载：转录里是已完成消息的前缀。标签未激活也加载——事件订阅不挑激活态，
  // 否则后台标签会拿着空列表套事件，激活时反而缺前缀。
  useEffect(() => {
    if (!readable) return;
    let gone = false;
    const load = (): void => {
      // 桥接缺失/同步抛错都不该炸掉整个界面：统一转成 rejected promise 走下面的错误分支。
      void Promise.resolve()
        .then(() => window.harness.sessions.read(sessionPath))
        .then((transcript) => {
          if (gone) return;
          const base = normalizeMessages(transcript.messages);
          const buffered = pendingRef.current ?? [];
          pendingRef.current = null;
          setMessages(buffered.reduce((current, event) => applyAgentEvent(current, event), base));
          setTruncated(transcript.truncated);
          setPhase("ready");
        })
        .catch((cause: unknown) => {
          if (gone) return;
          // 读盘失败也放行已缓冲的事件：直播继续，错误横幅提示快照缺失。
          const buffered = pendingRef.current ?? [];
          pendingRef.current = null;
          setMessages(buffered.reduce((current, event) => applyAgentEvent(current, event), [] as ChatMessage[]));
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase("error");
        });
    };
    load();
    return () => { gone = true; };
  }, [readable, sessionPath]);

  // 实时事件流：流式文本、思考、工具行都从这里来。初次读盘返回前先排队，读盘后按序补齐。
  useEffect(() => {
    const api = window.harness.delegations;
    if (!delegationId || !api?.onAgentEvent) return;
    return api.onAgentEvent((payload) => {
      if (payload.delegationId !== delegationId) return;
      const pending = pendingRef.current;
      if (pending) {
        pending.push(payload.event);
        return;
      }
      setMessages((current) => applyAgentEvent(current, payload.event));
    });
  }, [delegationId]);

  // 终态对账：落终态时子会话已写完，读一次盘拿权威内容与截断标记。
  // 初次读盘未返回时跳过：它本身就是最新快照，并发读盘会把已补齐的事件冲掉。
  useEffect(() => {
    if (!readable || isRunning || pendingRef.current !== null) return;
    let gone = false;
    void Promise.resolve()
      .then(() => window.harness.sessions.read(sessionPath))
      .then((transcript) => {
        if (gone) return;
        setMessages(normalizeMessages(transcript.messages));
        setTruncated(transcript.truncated);
        setPhase("ready");
      })
      .catch(() => undefined);
    return () => { gone = true; };
  }, [readable, sessionPath, isRunning, info.completedAt]);

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
    return markRunningTail(groupConversation(visible), isRunning);
  }, [messages, isRunning]);
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
                // 等用户确认 / 正在停止：与侧边聊天同款的状态呈现，别让过程区在这两个状态下看起来还在闷头跑。
                awaiting={Boolean(info.uiRequest) && index === groups.length - 1}
                stopping={stopping && index === groups.length - 1}
                canAutoCollapse={false}
              />
            ))}
          {info.report?.trim() && (!readable || phase === "error" || groups.length === 0) && (
            <section className="child-session-section">
              <h4>{t("delegate.detailReport")}</h4>
              <div className="child-session-report markdown"><Markdown>{info.report}</Markdown></div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
});
