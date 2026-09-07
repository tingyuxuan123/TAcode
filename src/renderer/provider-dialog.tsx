/**
 * 提供商设置对话框 —— 添加/编辑 AI 服务
 *
 * 包含：服务选择器（预设下拉）、API 配置表单、模型发现与选择面板。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";
import { useI18n } from "./i18n";
import {
  NAMED_ENDPOINT_PRESETS,
  CUSTOM_SERVICE_ID,
  matchPreset,
  type CatalogApiStyle,
} from "../shared/provider-presets";
import type { ProviderRecord, ProviderModelBinding } from "../shared/types";
import { SERVICE_THINKING_LEVELS, SUPPORTED_SERVICE_STYLES } from "../shared/provider-config";

// --- 常量 ---

const API_STYLE_LABELS: Record<CatalogApiStyle, string> = {
  chat_completions: "Chat Completions (OpenAI 兼容)",
  responses: "Responses API (OpenAI)",
  anthropic_messages: "Messages API (Anthropic)",
  google_generative_ai: "Google Generative AI",
  openai_codex_responses: "Codex Responses (OpenAI)",
  pi_messages: "Pi Messages",
  opencode_go: "OpenCode Go",
};

// --- 模型发现 Hook ---

function useModelDiscovery(
  baseUrl: string,
  apiKey: string,
  apiStyle: CatalogApiStyle,
  providerId?: string,
) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const trimmedUrl = baseUrl.trim();
    setModels([]);
    setError("");
    setLoading(false);
    if (!trimmedUrl) return;
    setLoading(true);
    setError("");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const ids = await window.harness.providers.discover({ id: providerId, baseUrl: trimmedUrl, apiKey: apiKey.trim(), apiStyle });
        if (!cancelled) setModels(ids);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [baseUrl, apiKey, apiStyle, providerId]);

  return { models, loading, error };
}

// --- 服务选择器 ---

export function ServicePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const custom = { id: CUSTOM_SERVICE_ID, label: t("settings.presetCustomEndpoint"), keywords: "custom" };
    const named = NAMED_ENDPOINT_PRESETS.map((p) => ({
      id: p.id,
      label: p.name,
      keywords: `${p.name} ${p.id} ${p.vendorKey} ${p.baseUrl} ${(p.aliases ?? []).join(" ")}`.toLowerCase(),
    }));
    return [custom, ...named];
  }, [t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.keywords.includes(needle));
  }, [options, query]);

  const selected = options.find((o) => o.id === value);
  const triggerLabel = selected?.label ?? t("settings.chooseService");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="provider-service-picker" ref={menuRef}>
      <button
        type="button"
        className="provider-service-trigger"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <span>{triggerLabel}</span>
        <Icon path="M9 6l6 6-6 6" size={14} />
      </button>
      {open && (
        <div
          className="provider-service-menu"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="provider-service-search">
            <Icon path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.35-4.35" size={14} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.filterService")}
            />
          </div>
          <div className="provider-service-list">
            {visible.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`provider-service-option${option.id === value ? " active" : ""}`}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.id === value && <Icon path="M20 6L9 17l-5-5" size={14} />}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="provider-service-empty">{t("settings.noServices")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- 模型选择面板 ---

export function ModelSelectionPanes({
  availableModels,
  selectedModels,
  onModelsChange,
  loading,
  error,
}: {
  availableModels: string[];
  selectedModels: ProviderModelBinding[];
  onModelsChange: (models: ProviderModelBinding[]) => void;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [focusModelId, setFocusModelId] = useState<string | null>(null);
  const panelRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (!focusModelId) return;
    const node = panelRefs.current[focusModelId];
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const timer = setTimeout(() => setFocusModelId(null), 1600);
    return () => clearTimeout(timer);
  }, [focusModelId]);

  const availableIds = useMemo(() => {
    const byId = new Map<string, string>();
    availableModels.forEach((id) => {
      const trimmed = id.trim();
      if (trimmed && !byId.has(trimmed)) byId.set(trimmed, trimmed);
    });
    return [...byId.values()].sort((a, b) => a.localeCompare(b));
  }, [availableModels]);

  const selectedById = useMemo(
    () => new Map(selectedModels.map((model) => [model.id, model])),
    [selectedModels],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return availableIds.filter((id) => !needle || id.toLowerCase().includes(needle));
  }, [availableIds, search]);

  const toggleModel = (modelId: string) => {
    const key = modelId;
    if (selectedById.has(key)) {
      onModelsChange(selectedModels.filter((m) => m.id !== key));
    } else {
      onModelsChange([...selectedModels, { id: modelId }]);
    }
  };

  const editModel = (modelId: string, isSelected: boolean) => {
    if (!isSelected) toggleModel(modelId);
    setFocusModelId(modelId);
  };

  const updateModel = (modelId: string, fields: Partial<ProviderModelBinding>) => {
    onModelsChange(selectedModels.map((model) => (
      model.id === modelId ? { ...model, ...fields } : model
    )));
  };

  const addCustomModel = () => {
    const id = customModelId.trim();
    if (!id) {
      setCustomModelError(t("settings.modelIdRequired"));
      return;
    }
    if (selectedById.has(id)) {
      setCustomModelError(t("settings.modelAlreadyAdded"));
      return;
    }
    onModelsChange([...selectedModels, { id }]);
    setCustomModelId("");
    setCustomModelError("");
  };

  const readPositiveNumber = (value: string): number | undefined => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
  };

  const limitsLabel = (model: ProviderModelBinding): string => {
    const ctx = model.contextWindow;
    const max = model.maxTokens;
    const fmt = (n: number) => (n >= 1000 ? `${Math.floor(n / 1000)}K` : String(n));
    if (ctx && max) return `${fmt(ctx)} · ${fmt(max)}`;
    if (ctx) return fmt(ctx);
    if (max) return fmt(max);
    return t("settings.defaultLimits");
  };

  return (
    <div className="provider-model-selection">
      <div className="provider-model-picker">
        <div className="provider-model-pane-head">
          <h4>{t("settings.serviceModels")}</h4>
          {loading && <span className="shimmer">{t("settings.discoveringModels")}</span>}
        </div>
        <div className="provider-model-search">
          <Icon path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.35-4.35" size={14} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.filterModels")}
          />
        </div>
        {error && (
          <div className="provider-model-error">
            <Icon path="M12 8v4m0 4h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0z" size={14} />
            <span>{error}</span>
          </div>
        )}
        <div className="provider-model-list">
          {filtered.map((modelId) => {
            const isSelected = selectedById.has(modelId);
            return (
              <label key={modelId} className="provider-model-row">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleModel(modelId)}
                />
                <code>{modelId}</code>
                <button
                  type="button"
                  className="provider-model-edit-button"
                  title={t("settings.editModel")}
                  aria-label={t("settings.editModel")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    editModel(modelId, isSelected);
                  }}
                >
                  <Icon path="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" size={13} />
                </button>
              </label>
            );
          })}
          {filtered.length === 0 && !loading && (
            <div className="provider-model-empty">{t("settings.noModels")}</div>
          )}
        </div>
      </div>

      <div className="provider-model-config">
        <div className="provider-model-pane-head">
          <h4>{t("settings.modelConfigurations")}</h4>
          <span>{t("settings.selectedModels", { n: selectedModels.length })}</span>
        </div>
        <div className="provider-model-panels">
          {selectedModels.map((model) => (
            <div
              key={model.id}
              ref={(el) => { panelRefs.current[model.id] = el; }}
              className={`provider-model-panel${focusModelId === model.id ? " focus" : ""}`}
            >
              <div className="provider-model-panel-head">
                <code>{model.id}</code>
                <span className="provider-model-badge">{limitsLabel(model)}</span>
                <button
                  type="button"
                  className="provider-model-icon-button danger"
                  title={t("settings.removeModel")}
                  aria-label={t("settings.removeModel")}
                  onClick={() => onModelsChange(selectedModels.filter((entry) => entry.id !== model.id))}
                >
                  <Icon path="M6 6l12 12M18 6L6 18" size={13} />
                </button>
              </div>

              <div className="provider-model-limits">
                <label>
                  <span>{t("settings.contextWindow")}</span>
                  <input
                    type="number"
                    min="1"
                    value={model.contextWindow ?? ""}
                    onChange={(event) => updateModel(model.id, { contextWindow: readPositiveNumber(event.target.value) })}
                  />
                </label>
                <label>
                  <span>{t("settings.maxOutput")}</span>
                  <input
                    type="number"
                    min="1"
                    value={model.maxTokens ?? ""}
                    onChange={(event) => updateModel(model.id, { maxTokens: readPositiveNumber(event.target.value) })}
                  />
                </label>
              </div>

              <div className="provider-model-subsection">
                <div className="provider-model-subhead">{t("settings.serviceThinkingLevels")}</div>
                <label className="provider-capability">
                  <input type="checkbox" checked={model.reasoning ?? false} onChange={(e) => updateModel(model.id, { reasoning: e.target.checked })} />
                  <span>{t("settings.supportsReasoning")}</span>
                </label>
                {model.reasoning && (
                  <fieldset className="provider-thinking-levels">
                    <legend>{t("settings.serviceThinkingLevels")}</legend>
                    {SERVICE_THINKING_LEVELS.map((level) => (
                      <label className="provider-capability" key={level}>
                        <input type="checkbox" checked={model.thinkingLevels?.includes(level) ?? true}
                          onChange={(e) => updateModel(model.id, { thinkingLevels: e.target.checked
                            ? [...(model.thinkingLevels ?? SERVICE_THINKING_LEVELS), level]
                            : (model.thinkingLevels ?? SERVICE_THINKING_LEVELS).filter((value) => value !== level) })} />
                        <span>{level}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>

              <div className="provider-model-subsection">
                <div className="provider-model-subhead">{t("settings.capability")}</div>
                <label className="provider-capability">
                  <input type="checkbox" checked={model.supportsImages ?? false} onChange={(e) => updateModel(model.id, { supportsImages: e.target.checked })} />
                  <span>{t("settings.supportsImages")}</span>
                </label>
                <p className="provider-hint">{t("settings.serviceCapabilityHint")}</p>
              </div>
            </div>
          ))}
          {selectedModels.length === 0 && (
            <div className="provider-model-empty">{t("settings.noModelsChosen")}</div>
          )}
        </div>
        <div className="provider-custom-model">
          <input
            value={customModelId}
            onChange={(event) => {
              setCustomModelId(event.target.value);
              if (customModelError) setCustomModelError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomModel();
              }
            }}
            placeholder={t("settings.customModelPlaceholder")}
          />
          <button type="button" className="ghost" onClick={addCustomModel}>
            <Icon path="M12 5v14M5 12h14" size={13} />
            <span>{t("settings.addCustomModel")}</span>
          </button>
        </div>
        {customModelError && <p className="provider-custom-model-error">{customModelError}</p>}
      </div>
    </div>
  );
}

// --- 提供商设置对话框 ---

export function ProviderSetupDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider?: ProviderRecord | null;
  onClose: () => void;
  onSaved: (record: ProviderRecord) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const editing = !!provider;
  const [service, setService] = useState(() => {
    if (!provider) return CUSTOM_SERVICE_ID;
    const matched = matchPreset({
      vendorKey: provider.vendorKey,
      baseUrl: provider.baseUrl,
      apiStyle: provider.apiStyle,
    });
    return matched?.id ?? CUSTOM_SERVICE_ID;
  });
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    (provider?.apiStyle as CatalogApiStyle) ?? "chat_completions",
  );
  const [models, setModels] = useState<ProviderModelBinding[]>(provider?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [defaultModelId, setDefaultModelId] = useState(provider?.defaultModelId ?? provider?.models[0]?.id ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const namedPreset = NAMED_ENDPOINT_PRESETS.find((p) => p.id === service);
  const resolvedName = namedPreset ? name.trim() || namedPreset.name : name;
  const resolvedBaseUrl = baseUrl;
  const resolvedApiStyle = apiStyle;
  const selectedDefault = models.some((m) => m.id === defaultModelId) ? defaultModelId : models[0]?.id ?? "";

  const { models: discoveredModels, loading: discovering, error: discoveryError } = useModelDiscovery(
    resolvedBaseUrl,
    apiKey,
    resolvedApiStyle,
    provider?.id,
  );

  useEffect(() => {
    setTestResult(null);
  }, [baseUrl, apiKey, apiStyle, selectedDefault]);

  const save = async () => {
    const providerName = resolvedName.trim();
    const providerBaseUrl = resolvedBaseUrl.trim();
    if (!providerName || !providerBaseUrl) {
      setError(t("settings.fillRequired"));
      return;
    }
    if (models.length === 0) {
      setError(t("settings.selectAtLeastOneModel"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const vendorKey = namedPreset?.vendorKey ?? "custom";
      const defaultModelId = selectedDefault;
      if (provider) {
        const result = await window.harness.providers.update({
          id: provider.id,
          name: providerName,
          vendorKey,
          baseUrl: providerBaseUrl,
          apiStyle: resolvedApiStyle,
          models,
          defaultModelId,
          isEnabled: provider.isEnabled,
          apiKey: apiKey.trim() || undefined,
        });
        if (!result) throw new Error(t("settings.providerMissing"));
        await onSaved(result);
      } else {
        const result = await window.harness.providers.create({
          name: providerName,
          vendorKey,
          baseUrl: providerBaseUrl,
          apiStyle: resolvedApiStyle,
          models,
          defaultModelId,
          apiKey: apiKey.trim() || undefined,
        });
        await onSaved(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="provider-dialog-overlay" onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !saving && !testing) onClose();
      if (e.key === "Enter" && e.target instanceof HTMLInputElement) e.preventDefault();
    }} onClick={(e) => { if (e.target === e.currentTarget && !saving && !testing) onClose(); }}>
      <div className="provider-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
        <div className="provider-dialog-head">
          <h2 id="provider-dialog-title">{editing ? t("settings.editProviderTitle") : t("settings.addProviderTitle")}</h2>
          <div className="provider-dialog-head-actions">
            <button type="button" className="ghost" disabled={saving || testing || !selectedDefault} onClick={async () => {
              setTesting(true); setTestResult(null);
              try { setTestResult(await window.harness.providers.testConnection({ id: provider?.id, baseUrl, apiKey, apiStyle, modelId: selectedDefault })); }
              catch (err) { setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) }); }
              finally { setTesting(false); }
            }}>{testing ? t("settings.testingConnection") : t("settings.testConnection")}</button>
            <button type="button" className="ghost" onClick={onClose} disabled={saving || testing}>
              {t("common.cancel")}
            </button>
            <button type="button" className="primary" onClick={save} disabled={saving || testing}>
              {saving ? t("settings.saving") : (editing ? t("settings.saveProvider") : t("settings.addProvider"))}
            </button>
            <button type="button" className="provider-dialog-close" disabled={saving || testing} onClick={onClose} aria-label={t("common.close")}>
              <Icon path="M6 6l12 12M18 6L6 18" />
            </button>
          </div>
        </div>

        <div className="provider-dialog-body" inert={saving || testing}>
          <div className="provider-form-grid">
            <div className="provider-form-col">
              <label className="provider-field">
                <span>{t("settings.serviceProvider")}</span>
                <ServicePicker value={service} onChange={(id) => {
                  setService(id);
                  const preset = NAMED_ENDPOINT_PRESETS.find((p) => p.id === id);
                  if (preset) { setName(preset.name); setBaseUrl(preset.baseUrl); setApiStyle(preset.apiStyle); }
                  setApiKey(""); setModels([]); setDefaultModelId("");
                }} />
              </label>
              <label className="provider-field">
                <span>{t("settings.profileName")}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={namedPreset?.name ?? t("settings.profileNamePlaceholder")}
                />
              </label>
              <label className="provider-field">
                <span>{t("settings.apiKey")}</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editing ? t("settings.apiKeyEditHint") : t("settings.apiKeyPlaceholder")}
                />
              </label>
            </div>
            <div className="provider-form-col">
              <label className="provider-field">
                <span>{t("settings.baseUrl")}</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="provider-field">
                <span>{t("settings.apiStyle")}</span>
                <select
                  value={apiStyle}
                  onChange={(e) => setApiStyle(e.target.value as CatalogApiStyle)}
                >
                  {Object.entries(API_STYLE_LABELS).filter(([value]) => SUPPORTED_SERVICE_STYLES.includes(value as CatalogApiStyle)).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <p className="provider-hint">{t("settings.styleHint")}</p>
            </div>
          </div>

          <div className="provider-section">
            <h3>{t("settings.models")}</h3>
            <p className="provider-hint">{t("settings.modelsHint")}</p>
            <ModelSelectionPanes
              availableModels={discoveredModels}
              selectedModels={models}
              onModelsChange={setModels}
              loading={discovering}
              error={discoveryError}
            />
            {models.length > 0 && <label className="provider-field">
              <span>{t("settings.serviceModel")}</span>
              <select value={selectedDefault} onChange={(e) => setDefaultModelId(e.target.value)}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
            </label>}
          </div>
        </div>

        {error && (
          <div className="provider-error">
            <Icon path="M12 8v4m0 4h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 22 0z" size={14} />
            <span>{error}</span>
          </div>
        )}
        {testResult && <p role="status" className={testResult.ok ? "provider-test-success" : "provider-error"}>{testResult.message}</p>}
        <p className="provider-hint provider-test-hint">{t("settings.serviceTestHint")}</p>
      </div>
    </div>
  );
}

// --- 提供商列表页面组件（嵌入设置对话框）---

export function ProviderListPage({
  providers,
  defaultProviderId,
  defaultModelId,
  onAdd,
  onEdit,
  onDelete,
  onSetDefault,
  onToggle,
  onTest,
}: {
  providers: ProviderRecord[];
  defaultProviderId: string | null;
  defaultModelId: string | null;
  onAdd: () => void;
  onEdit: (provider: ProviderRecord) => void;
  onDelete: (id: string) => Promise<void>;
  onSetDefault: (id: string, modelId?: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onTest: (id: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const { t } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setResult(null);
    try { await run(); }
    catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  return (
    <div className="provider-list-page">
      {result && <p role="status" className={result.ok ? "provider-test-success" : "provider-error"}>{result.message}</p>}
      <div className="provider-list-head">
        <p className="settings-hint">{t("settings.providersHint")}</p>
        <button type="button" className="primary" onClick={onAdd}>
          <Icon path="M12 5v14M5 12h14" size={14} />
          <span>{t("settings.addProvider")}</span>
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="provider-list-empty">
          <Icon path="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" size={32} />
          <p>{t("settings.noProviders")}</p>
          <p className="settings-hint">{t("settings.noProvidersDesc")}</p>
        </div>
      ) : (
        <div className="provider-list">
          {providers.map((provider) => {
            const isDefault = provider.id === defaultProviderId;
            return (
              <div
                key={provider.id}
                className={`provider-row${isDefault ? " default" : ""}${!provider.isEnabled ? " disabled" : ""}`}
              >
                <div className="provider-row-main">
                  <div className="provider-row-info">
                    <strong>{provider.name}</strong>
                    <span className="provider-row-url">{provider.baseUrl}</span>
                    <span className="provider-row-meta">
                      {provider.models.length} {t("settings.modelsCount")}
                      {isDefault && <span className="provider-row-default">{t("settings.default")}</span>}
                    </span>
                  </div>
                  <div className="provider-row-actions">
                    <button
                      type="button"
                      className="provider-action"
                      onClick={() => void action(() => onSetDefault(provider.id))}
                      title={t("settings.setDefault")}
                      disabled={isDefault || !provider.isEnabled || busy}
                    >
                      <Icon path="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" size={15} />
                    </button>
                    <button
                      type="button"
                      className="provider-action"
                      onClick={() => onEdit(provider)}
                      title={t("settings.editProvider")}
                    >
                      <Icon path="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5zM15 5l4 4" size={15} />
                    </button>
                    <button
                      type="button"
                      className="provider-action"
                      onClick={async () => {
                        setTestingId(provider.id);
                        try { setResult(await onTest(provider.id)); }
                        catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : String(error) }); }
                        finally { setTestingId(null); }
                      }}
                      title={t("settings.testConnection")}
                      disabled={testingId !== null || busy}
                    >
                      <Icon path={testingId === provider.id ? "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" : "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 8v4m0 4h.01"} size={15} />
                    </button>
                    <label className="provider-toggle">
                      <input
                        type="checkbox"
                        checked={provider.isEnabled}
                        disabled={busy}
                        onChange={(e) => void action(() => onToggle(provider.id, e.target.checked))}
                      />
                      <span className="provider-toggle-track" />
                    </label>
                    <button
                      type="button"
                      className={`provider-action danger${confirmDelete === provider.id ? " confirming" : ""}`}
                      onClick={() => {
                        if (confirmDelete === provider.id) {
                          void action(() => onDelete(provider.id));
                          setConfirmDelete(null);
                        } else {
                          setConfirmDelete(provider.id);
                        }
                      }}
                      title={t("settings.deleteProvider")}
                      disabled={busy}
                    >
                      <Icon path="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" size={15} />
                    </button>
                  </div>
                </div>
                <label className="provider-field provider-row-model">
                  <span>{t("settings.defaultServiceModel")}</span>
                  <select disabled={!provider.isEnabled || busy}
                    value={(isDefault ? defaultModelId : provider.defaultModelId) ?? provider.models[0]?.id ?? ""}
                    onChange={(e) => void action(() => onSetDefault(provider.id, e.target.value))}>
                    {provider.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
      )}
      <p className="provider-hint">{t("settings.serviceTestHint")}</p>
    </div>
  );
}
