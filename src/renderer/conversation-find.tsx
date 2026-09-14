import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { ChatMessage } from "./conversation";
import { searchConversation, type ConversationMatch } from "./session-search";
import { useI18n } from "./i18n";
import { createImeGuard } from "./ime";

export function ConversationFind({ messages, hasEarlier, loading, error, onEarlier, onNavigate, onClose }: {
  messages: ChatMessage[]; hasEarlier: boolean; loading: boolean; error?: string;
  onEarlier(): void; onNavigate(match: ConversationMatch): void; onClose(): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => searchConversation(messages, deferred), [messages, deferred]);
  const [selected, setSelected] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const ime = useRef(createImeGuard()).current;
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const index = Math.max(0, matches.findIndex(match => match.id === selected));
  const current = matches[index];
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setSelected(undefined); }, [deferred]);
  useEffect(() => {
    if (query.trim() && hasEarlier && !loading && !error) onEarlier();
  }, [query, hasEarlier, loading, error, onEarlier]);
  // 较早页面加载期间先显示已找到的数量，读完才自动定位，避免每页都拉动阅读位置。
  useEffect(() => { if (!hasEarlier && current) navigate.current(current); }, [current?.id, deferred, hasEarlier]);
  const step = (delta: number) => {
    if (!matches.length) return;
    const match = matches[(index + delta + matches.length) % matches.length]!;
    setSelected(match.id);
    navigate.current(match);
  };
  return <section className="conversation-find" aria-label={t("find.title")}>
    <div className="conversation-find-controls">
      <input ref={input} value={query} maxLength={500} placeholder={t("find.placeholder")} aria-label={t("find.title")}
        onChange={event => setQuery(event.target.value)} onCompositionStart={ime.start} onCompositionEnd={ime.end}
        onKeyDown={event => { if (ime.handles(event.nativeEvent)) return; if (event.key === "Escape") { event.stopPropagation(); onClose(); } if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
      <span role="status">{query.trim() ? t("find.count", { n: current ? index + 1 : 0, total: matches.length }) : ""}</span>
      <button type="button" disabled={!matches.length} aria-label={t("find.previous")} onClick={() => step(-1)}><ChevronUp size={16} /></button>
      <button type="button" disabled={!matches.length} aria-label={t("find.next")} onClick={() => step(1)}><ChevronDown size={16} /></button>
      <button type="button" aria-label={t("common.close")} onClick={onClose}><X size={16} /></button>
    </div>
    {query.trim() && (loading || hasEarlier) && !error && <p role="status">{t("find.reading")}</p>}
    {error && <p role="alert">{t("find.failed")} <button type="button" onClick={onEarlier}>{t("common.retry")}</button></p>}
    {query.trim() && !matches.length && !hasEarlier && !loading && !error && <p>{t("find.empty")}</p>}
    {current && <p className="conversation-find-snippet"><span>{t(`find.${current.section}`)} · </span>{current.before}<mark>{current.match}</mark>{current.after}</p>}
  </section>;
}
