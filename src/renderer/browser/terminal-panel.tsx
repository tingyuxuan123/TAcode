import { useEffect, useRef, useState } from "react";
import { Eraser, Focus, Square, SquareTerminal } from "lucide-react";
import { useI18n } from "../i18n";
import type { TerminalEvent, TerminalInfo } from "../../shared/types";

const OUTPUT_LIMIT = 160_000;

export function TerminalPanel({ workspace }: { workspace?: string }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<TerminalInfo>();
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(Boolean(workspace));
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!workspace) {
      setInfo(undefined);
      setOutput("");
      setStarting(false);
      return;
    }
    let gone = false;
    let terminalId: string | undefined;
    setStarting(true);
    setError(undefined);
    setOutput("");
    const apply = (event: TerminalEvent) => {
      if (event.type === "output") setOutput((current) => `${current}${event.data}`.slice(-OUTPUT_LIMIT));
      else if (event.type === "exit") setInfo((current) => current ? { ...current, running: false, exitCode: event.exitCode } : current);
      else setError(event.message);
    };
    // start 回复先于 shell 首屏输出到达的顺序并无保证；回复前先缓冲事件，
    // 拿到 id 后按 id 回放，避免提示符等早期输出被过滤掉导致终端看起来是空的。
    const pending: TerminalEvent[] = [];
    const off = window.harness.terminal.onEvent((event) => {
      if (gone) return;
      if (!terminalId) {
        pending.push(event);
        return;
      }
      if (event.id !== terminalId) return;
      apply(event);
    });
    void window.harness.terminal.start(workspace).then((next) => {
      if (gone) {
        void window.harness.terminal.stop(next.id);
        return;
      }
      terminalId = next.id;
      for (const event of pending.splice(0)) {
        if (event.id === next.id) apply(event);
      }
      setInfo(next);
      setStarting(false);
      inputRef.current?.focus();
    }).catch((cause: unknown) => {
      if (gone) return;
      setStarting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      gone = true;
      off();
      if (terminalId) void window.harness.terminal.stop(terminalId);
    };
  }, [workspace]);

  const send = () => {
    const id = info?.id;
    if (!id || !info.running || !input) return;
    const command = input;
    setInput("");
    void window.harness.terminal.write(id, `${command}\n`).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="terminal-panel">
      <header className="terminal-panel-toolbar">
        <div className="terminal-panel-title"><SquareTerminal size={15} strokeWidth={1.8} /><span>{t("panel.terminal")}</span></div>
        <div className="terminal-panel-actions">
          <button type="button" className="panel-icon-button" onClick={() => setOutput("")} title={t("panel.terminalClear")} aria-label={t("panel.terminalClear")}><Eraser size={14} strokeWidth={1.8} /></button>
          {info?.running && <button type="button" className="panel-icon-button" onClick={() => void window.harness.terminal.stop(info.id)} title={t("panel.terminalStop")} aria-label={t("panel.terminalStop")}><Square size={14} strokeWidth={1.8} /></button>}
          <button type="button" className="panel-icon-button" onClick={() => inputRef.current?.focus()} title={t("panel.terminalFocus")} aria-label={t("panel.terminalFocus")}><Focus size={14} strokeWidth={1.8} /></button>
        </div>
      </header>
      <pre className="terminal-panel-output" aria-live="polite">{starting ? t("panel.terminalEmpty") : output || (error ?? t("panel.terminalEmpty"))}</pre>
      <form className="terminal-panel-input" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <span className="terminal-panel-prompt">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "c" && event.ctrlKey && info?.running && !input) {
              event.preventDefault();
              void window.harness.terminal.write(info.id, "\u0003");
            }
          }}
          placeholder={t("panel.terminalPlaceholder")}
          disabled={!info?.running}
          aria-label={t("panel.terminalPlaceholder")}
        />
      </form>
    </div>
  );
}
