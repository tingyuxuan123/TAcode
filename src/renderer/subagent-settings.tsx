import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MAX_SUBAGENT_DOCUMENT_BYTES,
  parseSubagentDocument,
  type SubagentInfo,
} from "../shared/subagents";
import { useI18n } from "./i18n";

const TEMPLATE = `---
name: my-helper
description: One line telling the main agent when to delegate here.
tools: [read_file, list_files, search_files]
# model: deepseek/deepseek-v4-pro
# thinkingLevel: medium
# maxTurns: 30
---

You are the my-helper subagent. Finish exactly the delegated task.
Report findings with exact paths and line numbers, and say what you could not finish.
`;

function sourceLabel(source: SubagentInfo["source"], t: ReturnType<typeof useI18n>["t"]): string {
  return source === "builtin" ? t("subagents.builtin") : t("subagents.custom");
}

export function SubagentsSettings() {
  const { t } = useI18n();
  const [rows, setRows] = useState<SubagentInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ name?: string; text: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.harness.subagents.list();
    setRows(result.subagents);
    setWarnings(result.warnings);
  }, []);

  useEffect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [refresh]);

  const parsed = useMemo(
    () => (draft ? parseSubagentDocument({ text: draft.text, source: "user" }) : undefined),
    [draft],
  );

  const openEditor = useCallback(async (name?: string) => {
    setError(undefined);
    if (!name) {
      setDraft({ text: TEMPLATE });
      return;
    }
    const text = await window.harness.subagents.read(name);
    setDraft({ name, text: text ?? TEMPLATE });
  }, []);

  const save = useCallback(async () => {
    if (!draft || !parsed?.definition) return;
    setBusy(true);
    setError(undefined);
    try {
      await window.harness.subagents.save(draft.text);
      setDraft(undefined);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [draft, parsed, refresh]);

  const toggle = useCallback(async (row: SubagentInfo) => {
    setBusy(true);
    setError(undefined);
    try {
      await window.harness.subagents.setEnabled(row.name, !row.enabled);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const remove = useCallback(async (row: SubagentInfo) => {
    if (row.source !== "user") return;
    setBusy(true);
    setError(undefined);
    try {
      await window.harness.subagents.remove(row.name);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="settings-pane">
      <div className="pane-head">
        <p className="settings-hint">{t("subagents.hint")}</p>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => void window.harness.subagents.reveal()}>
            {t("subagents.openFolder")}
          </button>
          <button type="button" className="primary" onClick={() => void openEditor()}>
            {t("subagents.new")}
          </button>
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
      {warnings.length > 0 && (
        <ul className="settings-warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="subagent-list">
        {rows.map((row) => (
          <div key={row.name} className={`subagent-row${row.enabled ? "" : " disabled"}`}>
            <div className="subagent-main">
              <div className="subagent-title">
                <code>{row.name}</code>
                <span className={`subagent-badge${row.source === "builtin" ? " source" : ""}`}>{sourceLabel(row.source, t)}</span>
                {row.model && <span className="subagent-badge mono">{row.model.providerId}/{row.model.modelId}</span>}
                {row.thinkingLevel && <span className="subagent-badge">{row.thinkingLevel}</span>}
                {row.maxTurns ? <span className="subagent-badge">{t("subagents.maxTurns", { n: row.maxTurns })}</span> : null}
              </div>
              <p className="subagent-description">{row.description}</p>
              <div className="subagent-tools">
                {row.tools.map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </div>
            </div>
            <div className="subagent-actions">
              <label className="switch" title={t("subagents.enabled")}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  disabled={busy}
                  onChange={() => void toggle(row)}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-knob" />
                </span>
                <span className="switch-label">{row.enabled ? t("subagents.enabled") : t("subagents.disabled")}</span>
              </label>
              <button type="button" className="ghost" disabled={busy} onClick={() => void openEditor(row.name)}>
                {t("subagents.edit")}
              </button>
              {row.source === "user" && (
                <button type="button" className="ghost danger" disabled={busy} onClick={() => void remove(row)}>
                  {t("subagents.delete")}
                </button>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="sidebar-empty">{t("subagents.empty")}</p>}
      </div>

      {draft && (
        <div className="modal" onClick={(event) => event.target === event.currentTarget && setDraft(undefined)}>
          <div className="panel subagent-editor" role="dialog" aria-label={t("subagents.editorTitle")}>
            <h2>{draft.name ? t("subagents.editTitle", { name: draft.name }) : t("subagents.newTitle")}</h2>
            <p className="settings-hint">{t("subagents.editorHint")}</p>
            <textarea
              className="subagent-textarea"
              value={draft.text}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              rows={18}
            />
            <div className="subagent-editor-meta">
              <span>
                {draft.text.length} / {MAX_SUBAGENT_DOCUMENT_BYTES}
              </span>
              {parsed && parsed.warnings.length > 0 && (
                <ul className="settings-warnings">
                  {parsed.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {parsed && !parsed.definition && <span className="settings-error">{t("subagents.invalid")}</span>}
              {parsed?.definition && (
                <span className="settings-ok">
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12.5l4 4 10-10" />
                  </svg>
                  {parsed.definition.name} · {parsed.definition.tools.join(", ")}
                </span>
              )}
            </div>
            <div className="row-actions">
              <button type="button" className="ghost" onClick={() => setDraft(undefined)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !parsed?.definition || draft.text.length > MAX_SUBAGENT_DOCUMENT_BYTES}
                onClick={() => void save()}
              >
                {busy ? t("settings.saving") : t("settings.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
