import { useEffect, useRef, useState } from "react";
import { Eraser, RotateCcw, Square, SquareTerminal } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "../i18n";
import type { TerminalEvent, TerminalInfo } from "../../shared/types";

/** xterm 的字体/配色跟随设置里的「代码字体 / 代码字号」与代码屏令牌；主题切换时重读。 */
function readTerminalStyle() {
  const style = getComputedStyle(document.documentElement);
  return {
    fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
    fontSize: Math.max(9, Math.round(12 * (Number.parseFloat(style.getPropertyValue("--code-font-scale")) || 1))),
    theme: {
      background: style.getPropertyValue("--code-screen").trim() || "#22262e",
      foreground: style.getPropertyValue("--code-screen-ink").trim() || "#d7dae0",
    },
  };
}

function shellDisplayName(shell: string | undefined): string | undefined {
  const name = shell?.split(/[\\/]/).pop();
  return name ? name.replace(/\.exe$/i, "") : undefined;
}

export function TerminalPanel({ workspace, isActive = false }: {
  workspace?: string;
  isActive?: boolean;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<TerminalInfo>();
  const [starting, setStarting] = useState(Boolean(workspace));
  const [error, setError] = useState<string>();
  const [runId, setRunId] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const idRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!workspace) {
      setInfo(undefined);
      setStarting(false);
      setError(undefined);
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    setStarting(true);
    setError(undefined);
    setInfo(undefined);

    const style = readTerminalStyle();
    const term = new Terminal({
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      theme: style.theme,
      cursorBlink: true,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    let gone = false;
    let terminalId: string | undefined;
    // start 回复与 shell 首屏输出（PTY 下会立即打印提示符）的到达顺序没有保证：
    // 回复前先缓冲事件，拿到 id 后按 id 回放。
    const pending: TerminalEvent[] = [];
    const apply = (event: TerminalEvent) => {
      if (event.type === "output") {
        term.write(event.data);
      } else if (event.type === "exit") {
        setInfo((current) => (current ? { ...current, running: false, exitCode: event.exitCode } : current));
        term.write(`\r\n\x1b[2m${t("panel.terminalExited", { code: event.exitCode ?? "" })}\x1b[0m\r\n`);
      } else {
        setError(event.message);
      }
    };
    const off = window.harness.terminal.onEvent((event) => {
      if (gone) return;
      if (!terminalId) {
        pending.push(event);
        return;
      }
      if (event.id !== terminalId) return;
      apply(event);
    });

    const fitNow = () => {
      if (gone) return;
      try {
        fit.proposeDimensions();
        fit.fit();
      } catch {
        return; // 容器尺寸为 0（标签隐藏）时 fit 会抛错，忽略本轮
      }
      const id = idRef.current;
      if (id && term.cols > 2 && term.rows > 2) {
        void window.harness.terminal.resize(id, term.cols, term.rows).catch(() => undefined);
      }
    };
    const observer = new ResizeObserver(() => window.requestAnimationFrame(fitNow));
    observer.observe(host);
    // 主题 / 代码字号切换时重读令牌（根元素 class/style 变化即触发）。
    const themeObserver = new MutationObserver(() => {
      if (gone) return;
      const next = readTerminalStyle();
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.theme = next.theme;
      fitNow();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    // 键盘输入直达 PTY：xterm 负责回显与行编辑，不再有单独的输入行。
    term.onData((data) => {
      const id = idRef.current;
      if (!id || gone) return;
      void window.harness.terminal.write(id, data).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    });

    window.harness.terminal.start(workspace).then((next) => {
      if (gone) {
        void window.harness.terminal.stop(next.id);
        return;
      }
      terminalId = next.id;
      idRef.current = next.id;
      setInfo(next);
      setStarting(false);
      fitNow();
      for (const event of pending.splice(0)) {
        if (event.id === next.id) apply(event);
      }
      term.focus();
    }).catch((cause: unknown) => {
      if (gone) return;
      setStarting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      gone = true;
      observer.disconnect();
      themeObserver.disconnect();
      off();
      idRef.current = undefined;
      const id = terminalId;
      if (id) void window.harness.terminal.stop(id);
      term.dispose();
      termRef.current = undefined;
      fitRef.current = undefined;
    };
  }, [workspace, runId, t]);

  // 标签被激活时重新测量并聚焦（隐藏期间容器尺寸为 0，需要补一次 fit）。
  useEffect(() => {
    if (!isActive) return;
    const fit = fitRef.current;
    const term = termRef.current;
    try {
      fit?.fit();
    } catch {
      // 尺寸未就绪，等 ResizeObserver
    }
    const id = idRef.current;
    if (id && term && term.cols > 2 && term.rows > 2) {
      void window.harness.terminal.resize(id, term.cols, term.rows).catch(() => undefined);
    }
    term?.focus();
  }, [isActive]);

  const shell = shellDisplayName(info?.shell);

  return (
    <div className="terminal-panel">
      <header className="terminal-panel-toolbar">
        <div className="terminal-panel-title"><SquareTerminal size={15} strokeWidth={1.8} /><span>{t("panel.terminal")}</span></div>
        {shell && <span className="terminal-shell-chip">{shell}</span>}
        <div className="terminal-panel-actions">
          <button type="button" className="panel-icon-button" onClick={() => termRef.current?.reset()} title={t("panel.terminalClear")} aria-label={t("panel.terminalClear")}><Eraser size={14} strokeWidth={1.8} /></button>
          {info?.running && <button type="button" className="panel-icon-button" onClick={() => { const id = idRef.current; if (id) void window.harness.terminal.stop(id); }} title={t("panel.terminalStop")} aria-label={t("panel.terminalStop")}><Square size={14} strokeWidth={1.8} /></button>}
          {!info?.running && !starting && workspace && <button type="button" className="panel-icon-button" onClick={() => setRunId((value) => value + 1)} title={t("panel.terminalRestart")} aria-label={t("panel.terminalRestart")}><RotateCcw size={14} strokeWidth={1.8} /></button>}
        </div>
      </header>
      <div className="terminal-panel-body" ref={hostRef} />
      {(starting || error || !workspace) && (
        <div className="terminal-panel-overlay">
          {error ? <p className="is-error">{error}</p> : <p>{workspace ? t("panel.terminalStarting") : t("panel.terminalEmpty")}</p>}
        </div>
      )}
    </div>
  );
}
