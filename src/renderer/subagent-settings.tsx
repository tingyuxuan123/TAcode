import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  MAX_SUBAGENT_DOCUMENT_BYTES,
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_MUTATING_TOOLS,
  normalizeSubagentName,
  subagentCanMutate,
  type SubagentExecPolicy,
  type SubagentInfo,
  type SubagentPermission,
  type SubagentThinkingLevel,
  type SubagentToolName,
} from "../shared/subagents";
import type { ProviderRecord } from "../shared/types";
import {
  SUBAGENT_COMMAND_TOOLS,
  clampThinkingLevel,
  emptySubagentDraft,
  subagentBodyBytes,
  subagentBodyTemplate,
  subagentDraftError,
  subagentDraftFromInfo,
  subagentDraftToDocument,
  subagentModelOptions,
  subagentServiceNames,
  subagentThinkingLevelsFor,
  type SubagentDraft,
  type SubagentEditorState,
  type SubagentModelOption,
} from "./subagent-draft";
import { useI18n } from "./i18n";
import { useBackdropClose } from "./use-backdrop-close";

function sourceLabel(source: SubagentInfo["source"], t: ReturnType<typeof useI18n>["t"]): string {
  return source === "builtin" ? t("subagents.builtin") : t("subagents.custom");
}

/** 按服务分组，供 <select> 的 <optgroup> 使用（保持 AI 服务里的顺序）。 */
function groupByService(options: readonly SubagentModelOption[]): Array<{ serviceId: string; serviceName: string; options: SubagentModelOption[] }> {
  const groups = new Map<string, { serviceId: string; serviceName: string; options: SubagentModelOption[] }>();
  for (const option of options) {
    const group = groups.get(option.serviceId) ?? { serviceId: option.serviceId, serviceName: option.serviceName, options: [] };
    group.options.push(option);
    groups.set(option.serviceId, group);
  }
  return [...groups.values()];
}

/**
 * 子代理设置页。
 *
 * `providers` 就是用户在「AI 服务」里加的供应商：模型下拉只列它们里面的模型，
 * 推理强度按所选模型的能力过滤。没传（或还没加服务）时下拉只剩「跟随会话」。
 */
export function SubagentsSettings({ providers = [] }: { providers?: readonly ProviderRecord[] }) {
  const { t } = useI18n();
  const modelOptions = useMemo(() => subagentModelOptions(providers), [providers]);
  const serviceNames = useMemo(() => subagentServiceNames(providers), [providers]);
  const [rows, setRows] = useState<SubagentInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editor, setEditor] = useState<SubagentEditorState>();
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

  /** 新建=空草稿；编辑=用列表里已解析的定义预填（内置定义也可编辑，保存即写成用户文档覆盖它）。 */
  const openEditor = useCallback((row?: SubagentInfo) => {
    setError(undefined);
    setEditor(row
      ? { draft: subagentDraftFromInfo(row), original: { name: row.name, source: row.source } }
      : { draft: emptySubagentDraft() });
  }, []);

  const save = useCallback(async () => {
    if (!editor) return;
    const { draft, original } = editor;
    if (subagentDraftError(draft)) return;
    const name = normalizeSubagentName(draft.name);
    setBusy(true);
    setError(undefined);
    try {
      await window.harness.subagents.save(subagentDraftToDocument(draft));
      // 名称就是文件名：改名后清掉旧文档，避免同名定义重复出现。
      if (original?.source === "user" && original.name !== name) {
        await window.harness.subagents.remove(original.name);
      }
      setEditor(undefined);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [editor, refresh]);

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
          <button type="button" className="primary" onClick={() => openEditor()}>
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
                {row.model && <span className="subagent-badge mono">{serviceNames.get(row.model.providerId) ?? row.model.providerId}/{row.model.modelId}</span>}
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
              <button type="button" className="ghost" disabled={busy} onClick={() => openEditor(row)}>
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

      {editor && (
        <SubagentEditorSheet
          draft={editor.draft}
          original={editor.original}
          modelOptions={modelOptions}
          busy={busy}
          saveError={error}
          onChange={(next) => setEditor({ ...editor, draft: next })}
          onClose={() => setEditor(undefined)}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

/**
 * 表单式编辑弹窗（对齐 PI-Desktop 的 SubagentEditorSheet）。
 *
 * 工具授权放在提示词之前：它是唯一有安全后果的字段——声明了 write_file / edit_file /
 * apply_patch / exec_command 的子代理可以自行改动工作区，用勾选组显式表达，而不是埋在
 * frontmatter 里让用户自己记得写。
 */
function SubagentEditorSheet({
  draft,
  original,
  modelOptions,
  busy,
  saveError,
  onChange,
  onClose,
  onSave,
}: {
  draft: SubagentDraft;
  original?: SubagentEditorState["original"];
  modelOptions: readonly SubagentModelOption[];
  busy: boolean;
  saveError?: string;
  onChange(next: SubagentDraft): void;
  onClose(): void;
  onSave(): void;
}) {
  const { t } = useI18n();
  const backdropClose = useBackdropClose(() => {
    if (!busy) onClose();
  });
  const [nameTouched, setNameTouched] = useState(Boolean(original));
  const errorKey = subagentDraftError(draft);
  const pristine = !original && !draft.name.trim() && !draft.description.trim();
  const bytes = subagentBodyBytes(draft.body);
  const slug = normalizeSubagentName(draft.name);
  const hasCommandTool = draft.tools.some((tool) => SUBAGENT_COMMAND_TOOLS.includes(tool));
  const modelGroups = useMemo(() => groupByService(modelOptions), [modelOptions]);
  const unknownModel = Boolean(draft.model.trim()) && !modelOptions.some((item) => item.value === draft.model);
  const thinkingLevels = useMemo(
    () => subagentThinkingLevelsFor(draft.model, modelOptions),
    [draft.model, modelOptions],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const set = <K extends keyof SubagentDraft>(key: K, value: SubagentDraft[K]): void =>
    onChange({ ...draft, [key]: value });

  // 首次命名时种下正文模板：编辑框永远不是白纸，也不会覆盖已经写过的内容。
  const setName = (value: string): void => {
    const next: SubagentDraft = { ...draft, name: value };
    if (!nameTouched && !original && !draft.body.trim()) next.body = subagentBodyTemplate(value);
    onChange(next);
  };

  // 换模型时把当前档位收敛到该模型支持的范围内（“与会话一致”不动）。
  const changeModel = (value: string): void => {
    const levels = subagentThinkingLevelsFor(value, modelOptions);
    onChange({ ...draft, model: value, thinkingLevel: clampThinkingLevel(draft.thinkingLevel, levels) });
  };

  const toggleTool = (tool: SubagentToolName, on: boolean): void =>
    set(
      "tools",
      on
        // 保持声明顺序，文档读起来与勾选先后无关。
        ? SUBAGENT_ASSIGNABLE_TOOLS.filter((candidate) => candidate === tool || draft.tools.includes(candidate))
        : draft.tools.filter((candidate) => candidate !== tool),
    );

  return (
    <div className="modal" {...backdropClose}>
      <div
        className="panel subagent-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagent-sheet-title"
      >
        <header className="subagent-sheet-head">
          <div>
            <h2 id="subagent-sheet-title">
              {original ? t("subagents.editTitle", { name: original.name }) : t("subagents.newTitle")}
            </h2>
            <p className="settings-hint">{t("subagents.sheetHint")}</p>
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="subagent-sheet-body">
          <label className="subagent-field">
            <span>{t("subagents.name")}</span>
            <input
              value={draft.name}
              autoFocus={!original}
              placeholder={t("subagents.namePlaceholder")}
              spellCheck={false}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
            <small>{slug ? t("subagents.slugHint", { id: slug }) : t("subagents.nameHint")}</small>
          </label>

          <label className="subagent-field">
            <span>{t("subagents.description")}</span>
            <textarea
              className="subagent-field-area"
              rows={2}
              value={draft.description}
              placeholder={t("subagents.descriptionPlaceholder")}
              onChange={(event) => set("description", event.target.value)}
            />
            <small>{t("subagents.descriptionHint")}</small>
          </label>

          <div className="subagent-field">
            <span>{t("subagents.tools")}</span>
            <small>{t("subagents.toolsHint")}</small>
            <div className="subagent-tool-pick" role="group" aria-label={t("subagents.tools")}>
              {SUBAGENT_ASSIGNABLE_TOOLS.map((tool) => {
                const on = draft.tools.includes(tool);
                return (
                  <label
                    key={tool}
                    className={`subagent-tool-opt${on ? " is-on" : ""}${subagentCanMutate({ tools: [tool] }) ? " is-mutating" : ""}`}
                  >
                    <input type="checkbox" checked={on} onChange={(event) => toggleTool(tool, event.target.checked)} />
                    <code>{tool}</code>
                  </label>
                );
              })}
            </div>
            {draft.tools.some((tool) => (SUBAGENT_MUTATING_TOOLS as readonly string[]).includes(tool)) && (
              <small className="is-warn">{t("subagents.mutatingHint")}</small>
            )}
          </div>

          {hasCommandTool && (
            <label className="subagent-field">
              <span>{t("subagents.execPolicy")}</span>
              <select
                value={draft.execPolicy}
                onChange={(event) => set("execPolicy", event.target.value as SubagentExecPolicy | "")}
              >
                <option value="">{t("subagents.execInherit")}</option>
                <option value="readonly">{t("subagents.execReadonly")}</option>
              </select>
              <small>{t("subagents.execPolicyHint")}</small>
            </label>
          )}

          <div className="subagent-field-pair">
            <label className="subagent-field">
              <span>{t("subagents.model")}</span>
              <select value={draft.model} onChange={(event) => changeModel(event.target.value)}>
                <option value="">{t("subagents.modelInherit")}</option>
                {/* 旧定义里手写的、不在服务列表里的钉选仍要看得见，不能被静默清掉 */}
                {unknownModel && <option value={draft.model}>{draft.model}</option>}
                {modelGroups.map((group) => (
                  <optgroup key={group.serviceId} label={group.serviceName}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.modelId}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <small>{modelOptions.length ? t("subagents.modelHint") : t("subagents.modelEmpty")}</small>
            </label>
            <label className="subagent-field">
              <span>{t("subagents.thinking")}</span>
              <select
                value={draft.thinkingLevel}
                onChange={(event) => set("thinkingLevel", event.target.value as SubagentThinkingLevel | "")}
              >
                <option value="">{t("subagents.thinkingInherit")}</option>
                {thinkingLevels.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
              <small>{t("subagents.thinkingHint")}</small>
            </label>
          </div>

          <div className="subagent-field-pair">
            <label className="subagent-field">
              <span>{t("subagents.maxTurnsField")}</span>
              <input
                type="number"
                min={1}
                max={MAX_SUBAGENT_MAX_TURNS}
                placeholder={t("subagents.maxTurnsUnlimited")}
                value={draft.maxTurns > 0 ? String(draft.maxTurns) : ""}
                onChange={(event) => set("maxTurns", Number.parseInt(event.target.value, 10) || 0)}
              />
              <small>{t("subagents.maxTurnsFieldHint", { max: MAX_SUBAGENT_MAX_TURNS })}</small>
            </label>
            <label className="subagent-field">
              <span>{t("subagents.permission")}</span>
              <select
                value={draft.permission}
                onChange={(event) => set("permission", event.target.value as SubagentPermission | "")}
              >
                <option value="">{t("subagents.permissionInherit")}</option>
                <option value="plan">{t("perm.plan")}</option>
                <option value="ask">{t("perm.ask")}</option>
                <option value="auto">{t("perm.auto")}</option>
                <option value="full">{t("perm.full")}</option>
              </select>
              <small>{t("subagents.permissionHint")}</small>
            </label>
          </div>

          <div className="subagent-field">
            <div className="subagent-field-row">
              <span>{t("subagents.body")}</span>
              <span
                className={`subagent-byte-count${bytes > MAX_SUBAGENT_DOCUMENT_BYTES
                  ? " is-over"
                  : bytes > MAX_SUBAGENT_DOCUMENT_BYTES * 0.8 ? " is-near" : ""}`}
              >
                {t("subagents.bytes", {
                  used: Math.round(bytes / 1024),
                  max: Math.round(MAX_SUBAGENT_DOCUMENT_BYTES / 1024),
                })}
              </span>
            </div>
            <small>{t("subagents.bodyHint")}</small>
            <textarea
              className="subagent-body"
              rows={12}
              value={draft.body}
              spellCheck={false}
              placeholder={subagentBodyTemplate("")}
              aria-label={t("subagents.body")}
              onChange={(event) => set("body", event.target.value)}
            />
          </div>
        </div>

        {saveError && <p className="settings-hint settings-error subagent-sheet-error">{saveError}</p>}
        {!saveError && errorKey && !pristine && (
          <p className="settings-hint settings-error subagent-sheet-error">{t(errorKey)}</p>
        )}

        <footer className="subagent-sheet-actions">
          <span className="subagent-sheet-note">{t("subagents.sheetNote")}</span>
          <div className="row-actions">
            <button type="button" className="ghost" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || Boolean(errorKey)}
              title={errorKey ? t(errorKey) : undefined}
              onClick={onSave}
            >
              {busy ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
