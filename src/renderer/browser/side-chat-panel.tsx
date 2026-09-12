import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageCirclePlus, Plus } from "lucide-react";
import type { AgentSessionStats, PermissionMode, ProviderStatus } from "../../shared/types";
import type { ModelOption } from "../../shared/model-selection";
import { toPromptImages } from "../../shared/vision-api";
import {
  applyAgentEvent,
  friendlyAgentError,
  groupConversation,
  normalizeMessages,
  type ChatMessage,
} from "../conversation";
import { AssistantTurn, ContextStats, PermissionPicker, UserTurn } from "../ui";
import { EffortPicker, ModelPicker } from "../composer-pickers";
import { PromptToolbar } from "../prompt-toolbar";
import { useI18n } from "../i18n";
import { modelOptionKey } from "../../shared/model-selection";

/** 主进程已无该 runtime（被 stop / worker 退出）时的报错特征：回到「已结束」态而不是裸错误。 */
const NO_SESSION_PATTERN = /no active agent session|agent session closed|session not found/i;
const MAX_ATTACHMENTS = 6;

/**
 * 侧边聊天（Codex 模式）：从主聊天派生的临时会话。可并开多个（`ordinal` 编号），
 * `draft` 是选中文字预填的草稿；runtime 惰性创建——首条消息才 start 并快照当时的
 * 参数。底部输入区与主会话 composer 同款：模型/思考深度/权限随时可调（runtime
 * 在跑时通过运行时命令即时下发），发送位在运行中变成停止键。顶部不设标题行——
 * 标签上已经写明是哪个侧边聊天。
 */
export function SideChatPanel({ workspace, provider, model, modelKey, models, effort, effortLevels, permission, ordinal, sourceSession, draft, onRecreate }: {
  workspace?: string;
  provider?: ProviderStatus;
  /** 初始模型（主会话当前值）；此后由本面板的选择器独立管理。 */
  model: string;
  modelKey: string;
  models: ModelOption[];
  effort: string;
  effortLevels: string[];
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
  const [attachments, setAttachments] = useState<string[]>([]);
  const [runtimeId, setRuntimeId] = useState<string>();
  const runtimeRef = useRef<string | undefined>(undefined);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [chatModel, setChatModel] = useState(model);
  const [chatModelKey, setChatModelKey] = useState(modelKey);
  const [chatEffort, setChatEffort] = useState(effort);
  const [chatPermission, setChatPermission] = useState<PermissionMode>(permission);
  const [stats, setStats] = useState<AgentSessionStats>();

  useEffect(() => {
    const offEvent = window.harness.sideChat.onEvent((event) => {
      if (event.__runtimeId && event.__runtimeId !== runtimeRef.current) return;
      if (event.type === "agent_start") setRunning(true);
      if (event.type === "agent_settled") setRunning(false);
      const withStats = event as { stats?: unknown };
      if (withStats.stats && typeof withStats.stats === "object") setStats(withStats.stats as AgentSessionStats);
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

  // 跟主会话输入框一致：随内容长高，封顶 140px。
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

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
        ...(chatModel ? { model: chatModel } : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        effort: chatEffort,
        permission: chatPermission,
        sandbox: chatPermission === "full" ? "danger-full-access" : "workspace-write",
        ...(chatPermission !== "plan" ? { network: true } : {}),
        ...(sourceSession ? { sourceSession } : {}),
      });
      runtimeRef.current = snapshot.runtimeId;
      setRuntimeId(snapshot.runtimeId);
      setStats(snapshot.stats);
      setMessages(normalizeMessages(snapshot.messages));
      return snapshot.runtimeId;
    } finally {
      setStarting(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || running || starting) return;
    const images = attachments;
    setInput("");
    setAttachments([]);
    setError(undefined);
    setRunning(true);
    try {
      const id = await ensureStarted();
      await window.harness.sideChat.command(
        "prompt",
        { message: text, ...(images.length ? { images: toPromptImages(images) } : {}) },
        id,
      );
    } catch (cause: unknown) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      setRunning(false);
      // runtime 已不存在（被停止/退出）：回滚输入、回到「已结束」态，不再复用死句柄。
      if (NO_SESSION_PATTERN.test(raw)) {
        resetRuntime();
        setInput((current) => (current.trim() ? current : text));
        setAttachments((current) => (current.length ? current : images));
        return;
      }
      setInput((current) => (current.trim() ? current : text));
      setAttachments((current) => (current.length ? current : images));
      setError(friendlyAgentError(raw) || raw);
    }
  };

  /** 运行中切模型：本地立即生效（下次 start 用），runtime 在跑时同步下发。 */
  const applyModel = (key: string) => {
    const option = models.find((item) => item.value === key);
    if (!option) return;
    setChatModelKey(key);
    setChatModel(option.modelId);
    const id = runtimeRef.current;
    if (id && provider) {
      void window.harness.sideChat
        .command("set_model", { provider: provider.id, modelId: option.modelId }, id)
        .catch((cause: unknown) => setError(friendlyAgentError(cause instanceof Error ? cause.message : String(cause)) || String(cause)));
    }
  };

  const applyEffort = (next: string) => {
    setChatEffort(next);
    const id = runtimeRef.current;
    if (id) {
      void window.harness.sideChat
        .command("set_thinking_level", { level: next }, id)
        .catch((cause: unknown) => setError(friendlyAgentError(cause instanceof Error ? cause.message : String(cause)) || String(cause)));
    }
  };

  const applyPermission = (next: string) => {
    setChatPermission(next as PermissionMode);
    const id = runtimeRef.current;
    // 与主会话同一套机制：运行时通过 /permissions 斜杠命令即时切换。
    if (id) {
      void window.harness.sideChat
        .command("prompt", { message: `/permissions ${next}` }, id)
        .catch((cause: unknown) => setError(friendlyAgentError(cause instanceof Error ? cause.message : String(cause)) || String(cause)));
    }
  };

  const addAttachments = (files: FileList | null) => {
    if (!files?.length) return;
    void Promise.all(
      Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .slice(0, MAX_ATTACHMENTS)
        .map((file) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        })),
    )
      .then((images) => setAttachments((current) => [...current, ...images].slice(0, MAX_ATTACHMENTS)))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="side-chat-panel">
      <div className="side-chat-body">
        {groups.length === 0 && !running && !starting && <div className="side-chat-empty"><MessageCirclePlus size={24} strokeWidth={1.5} /><p>{t("panel.sideChatEmpty")}</p><p className="side-chat-empty-note">{t("panel.sideChatEphemeral")}</p></div>}
        {groups.map((group) => group.type === "user"
          ? <UserTurn key={group.id} text={group.message.text} images={group.message.images} />
          : <AssistantTurn key={group.id} messages={group.messages} running={running} canAutoCollapse={false} />)}
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
        {attachments.length > 0 && (
          <div className="prompt-attachments">
            {attachments.map((image, index) => (
              <div key={`${index}-${image.slice(-16)}`} className="prompt-attachment">
                <span className="prompt-attachment-img"><img src={image} alt="" /></span>
                <button
                  type="button"
                  className="prompt-attachment-remove"
                  aria-label={t("common.remove")}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t("panel.sideChatPlaceholder")}
          rows={1}
          disabled={ended || running || starting || !workspace}
        />
        <PromptToolbar
          action={running ? (
            <button type="button" className="send stop" aria-label={t("composer.abort")} onClick={stop}>
              <i />
            </button>
          ) : (
            <button type="submit" className="send" disabled={(!input.trim() && attachments.length === 0) || ended || starting || !workspace} aria-label={t("composer.send")}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          )}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              addAttachments(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="prompt-attach"
            aria-label={t("composer.uploadImage")}
            title={t("composer.uploadImage")}
            disabled={attachments.length >= MAX_ATTACHMENTS || ended || !workspace}
            onClick={() => fileRef.current?.click()}
          >
            <Plus size={16} strokeWidth={1.8} />
          </button>
          <ModelPicker
            value={chatModelKey}
            fallback={chatModel}
            options={models}
            disabled={ended || !workspace}
            onChange={applyModel}
          />
          <EffortPicker value={chatEffort} levels={effortLevels} onChange={applyEffort} />
          <PermissionPicker value={chatPermission} onChange={applyPermission} />
          <ContextStats
            stats={stats}
            model={chatModel}
            effort={chatEffort}
            effortLevels={effortLevels}
            running={running}
            busy={starting}
          />
        </PromptToolbar>
      </form>
    </div>
  );
}
