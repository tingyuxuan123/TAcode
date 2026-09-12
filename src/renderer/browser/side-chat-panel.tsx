import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageCirclePlus, Send, Square } from "lucide-react";
import type { PermissionMode, ProviderStatus } from "../../shared/types";
import {
  applyAgentEvent,
  friendlyAgentError,
  groupConversation,
  normalizeMessages,
  type ChatMessage,
} from "../conversation";
import { AssistantTurn, UserTurn } from "../ui";
import { useI18n } from "../i18n";

/** 主进程已无该 runtime（被 stop / worker 退出）时的报错特征：回到「已结束」态而不是裸错误。 */
const NO_SESSION_PATTERN = /no active agent session|agent session closed|session not found/i;

/**
 * 侧边聊天（Codex 模式）：从主聊天派生的临时会话。可并开多个（`ordinal` 编号），
 * `draft` 是选中文字预填的草稿；runtime 惰性创建——首条消息才 start 并快照当时的
 * 参数。停止/失效后消息保留并进入「已结束」态，继续对话需要新开一个实例。
 */
export function SideChatPanel({ workspace, provider, model, effort, permission, ordinal, sourceSession, draft, onRecreate }: {
  workspace?: string;
  provider?: ProviderStatus;
  model: string;
  effort: string;
  permission: PermissionMode;
  ordinal: number;
  /** 发起时的主会话转录路径（元数据，随 start 选项留档）。 */
  sourceSession?: string;
  draft?: string;
  onRecreate?(): void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(draft ?? "");
  const [runtimeId, setRuntimeId] = useState<string>();
  const runtimeRef = useRef<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const offEvent = window.harness.sideChat.onEvent((event) => {
      if (event.__runtimeId && event.__runtimeId !== runtimeRef.current) return;
      if (event.type === "agent_start") setRunning(true);
      if (event.type === "agent_settled") setRunning(false);
      setMessages((current) => applyAgentEvent(current, event));
    });
    const offError = window.harness.sideChat.onError((payload) => {
      if (payload.__runtimeId && payload.__runtimeId !== runtimeRef.current) return;
      setRunning(false);
      setError(friendlyAgentError(payload.message) || payload.message);
    });
    return () => {
      offEvent();
      offError();
      const id = runtimeRef.current;
      if (id) void window.harness.sideChat.stop(id);
      runtimeRef.current = undefined;
    };
  }, []);

  // 只清本地句柄，保留转录：UI 进入「已结束」态，继续对话走 onRecreate 新开实例。
  const resetRuntime = () => {
    runtimeRef.current = undefined;
    setRuntimeId(undefined);
    setRunning(false);
    setStarting(false);
  };

  const stop = () => {
    const id = runtimeRef.current;
    resetRuntime();
    if (id) void window.harness.sideChat.stop(id);
  };

  const groups = useMemo(() => groupConversation(messages), [messages]);
  // 已产生过对话且 runtime 不在：这是声明式临时会话的「已结束」态（Codex 的 expired 语义）。
  const ended = messages.length > 0 && !runtimeId && !running && !starting;

  const ensureStarted = async (): Promise<string> => {
    if (runtimeRef.current) return runtimeRef.current;
    if (!workspace || !provider?.configured) throw new Error(t("toast.fillConfig"));
    setStarting(true);
    setError(undefined);
    try {
      const snapshot = await window.harness.sideChat.start({
        cwd: workspace,
        project: true,
        provider: provider.id,
        ...(provider.serviceId ? { serviceId: provider.serviceId } : {}),
        ...(model ? { model } : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        effort,
        permission,
        sandbox: permission === "full" ? "danger-full-access" : "workspace-write",
        ...(permission !== "plan" ? { network: true } : {}),
        ...(sourceSession ? { sourceSession } : {}),
      });
      runtimeRef.current = snapshot.runtimeId;
      setRuntimeId(snapshot.runtimeId);
      setMessages(normalizeMessages(snapshot.messages));
      return snapshot.runtimeId;
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || running || starting) return;
    setInput("");
    setError(undefined);
    setRunning(true);
    try {
      const id = await ensureStarted();
      await window.harness.sideChat.command("prompt", { message: text }, id);
    } catch (cause: unknown) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      setRunning(false);
      // runtime 已不存在（被停止/退出）：回滚输入、回到「已结束」态，不再复用死句柄。
      if (NO_SESSION_PATTERN.test(raw)) {
        resetRuntime();
        setInput((current) => (current.trim() ? current : text));
        return;
      }
      setInput((current) => (current.trim() ? current : text));
      setError(friendlyAgentError(raw) || raw);
    }
  };

  return (
    <div className="side-chat-panel">
      <header className="side-chat-toolbar">
        <div className="side-chat-title"><MessageCirclePlus size={15} strokeWidth={1.8} /><span>{t("panel.sideChatNumbered", { n: ordinal })}</span></div>
        {runtimeId && <button type="button" className="panel-icon-button" onClick={stop} title={t("panel.sideChatStop")} aria-label={t("panel.sideChatStop")}><Square size={14} strokeWidth={1.8} /></button>}
      </header>
      <div className="side-chat-body">
        {groups.length === 0 && !running && !starting && <div className="side-chat-empty"><MessageCirclePlus size={24} strokeWidth={1.5} /><p>{t("panel.sideChatEmpty")}</p><p className="side-chat-empty-note">{t("panel.sideChatEphemeral")}</p></div>}
        {groups.map((group) => group.type === "user"
          ? <UserTurn key={group.id} text={group.message.text} images={group.message.images} />
          : <AssistantTurn key={group.id} messages={group.messages} running={running} canAutoCollapse={() => false} />)}
        {ended && (
          <div className="side-chat-ended" role="status">
            <span>{t("panel.sideChatEnded")}</span>
            {onRecreate && <button type="button" className="side-chat-recreate" onClick={onRecreate}>{t("panel.sideChatRecreate")}</button>}
          </div>
        )}
        {error && <p className="side-chat-error">{error}</p>}
        {(running || starting) && <p className="side-chat-status"><LoaderCircle size={13} className="progress-spinner" />{starting ? t("panel.sideChatStarting") : t("flow.running")}</p>}
      </div>
      <form className="side-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("panel.sideChatPlaceholder")} rows={2} disabled={ended || running || starting || !workspace} />
        <button type="submit" className="send" disabled={!input.trim() || ended || running || starting || !workspace} aria-label={t("composer.send")}><Send size={14} strokeWidth={1.8} /></button>
      </form>
    </div>
  );
}
