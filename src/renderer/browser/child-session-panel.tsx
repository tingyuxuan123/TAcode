import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import {
  delegateStatusLabel,
  groupConversation,
  normalizeMessages,
  type ChatMessage,
  type DelegateTaskStatus,
} from "../conversation";
import { useI18n } from "../i18n";
import { AssistantTurn, Markdown, UserTurn } from "../ui";
import type { ChildSessionPanelInfo } from "./panel-state";

/** 运行中标签的刷新间隔：子会话 JSONL 边跑边写，面板按此频率跟随。 */
const POLL_MS = 2_000;
/** 连续多少次轮询消息条数不变就认为已收口，停止轮询。 */
const IDLE_POLLS = 3;
/** `delegateStatusLabel` 认识的四个状态；其余（interrupted/cancelled…）原样显示。 */
const TASK_STATUSES = new Set<string>(["pending", "running", "completed", "failed"]);

function statusText(status: string | undefined): string {
  if (!status) return "";
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
}: {
  info: ChildSessionPanelInfo;
  isActive: boolean;
}) {
  const { t } = useI18n();
  const sessionPath = info.sessionPath ?? "";
  const readable = isTranscriptPath(sessionPath);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(readable ? "loading" : "ready");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const lastCount = useRef(-1);
  const idlePolls = useRef(0);

  useEffect(() => {
    if (!readable) return;
    let gone = false;
    setMessages([]);
    setPhase("loading");
    setError("");
    setTruncated(false);
    lastCount.current = -1;
    idlePolls.current = 0;
    const load = (): void => {
      // 桥接缺失/同步抛错都不该炸掉整个界面：统一转成 rejected promise 走下面的错误分支。
      void Promise.resolve()
        .then(() => window.harness.sessions.read(sessionPath))
        .then((transcript) => {
          if (gone) return;
          setMessages(normalizeMessages(transcript.messages));
          setTruncated(transcript.truncated);
          setPhase("ready");
          const count = transcript.messages.length;
          idlePolls.current = count === lastCount.current ? idlePolls.current + 1 : 0;
          lastCount.current = count;
        })
        .catch((cause: unknown) => {
          if (gone) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase("error");
        });
    };
    load();
    // 仅在标签可见、且内容还在增长时轮询；收口后停止，避免后台标签常年打 IPC。
    const timer = window.setInterval(() => {
      if (!isActive || idlePolls.current >= IDLE_POLLS) return;
      load();
    }, POLL_MS);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [readable, sessionPath, isActive]);

  const groups = useMemo(() => {
    const visible = messages.filter((message, index) =>
      // 注入的 prompt 作为第一条 user 消息出现，隐藏它（任务单独展示）。
      !(index === 0 && message.role === "user" && INJECTED_PROMPT.test(message.text)));
    return groupConversation(visible);
  }, [messages]);
  const activity = info.activity ?? [];
  const meta = [
    statusText(info.status),
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
          {info.status === "running" || info.status === "pending"
            ? <LoaderCircle size={12} className="progress-spinner" />
            : info.status === "failed" ? <CircleAlert size={12} className="progress-err" /> : null}
        </span>
      </header>
      <div className="child-session-body">
        {info.live?.trim() && (
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
        {readable && phase === "ready" && groups.length === 0 && <p className="child-session-note">{t("chat.emptySession")}</p>}
        {groups.map((group) => group.type === "user"
          ? <UserTurn key={group.id} text={group.message.text} images={group.message.images} />
          : (
            <AssistantTurn
              key={group.id}
              messages={group.messages}
              running={false}
              canAutoCollapse={false}
            />
          ))}
        {info.report?.trim() && (
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
  );
});
