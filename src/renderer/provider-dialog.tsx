/**
 * 提供商设置对话框 —— 添加/编辑 AI 服务
 *
 * 包含：服务选择器（预设下拉）、API 配置表单、模型发现与选择面板。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";
import { useI18n } from "./i18n";
import { useBackdropClose } from "./use-backdrop-close";
import {
  NAMED_ENDPOINT_PRESETS,
  CUSTOM_SERVICE_ID,
  matchPreset,
  type CatalogApiStyle,
} from "../shared/provider-presets";
import type { ProviderRecord, ProviderModelBinding } from "../shared/types";
import { SERVICE_THINKING_LEVELS, serviceThinkingLevels, SUPPORTED_SERVICE_STYLES } from "../shared/provider-config";
import { effortLabelKey } from "../shared/thinking";
import { applyKnownDefaults, needsDefaultsFill } from "../shared/model-defaults";

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

// --- 模型发现结果缓存 ---

type ModelDiscoveryCache = {
  discovered?: string[];
  bindings?: ProviderModelBinding[];
};

function discoveryCacheKey(baseUrl: string, apiStyle: CatalogApiStyle, providerId?: string): string {
  const id = providerId ?? `new:${apiStyle}:${baseUrl.trim()}`;
  return `provider-model-discovery:v1:${id}`;
}

function readDiscoveryCache(key: string): ModelDiscoveryCache | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ModelDiscoveryCache) : null;
  } catch {
    return null;
  }
}

function writeDiscoveryCache(key: string, value: ModelDiscoveryCache): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略写入失败（如隐私模式）
  }
}

// --- 模型发现 Hook ---

function useModelDiscovery(
  baseUrl: string,
  apiKey: string,
  apiStyle: CatalogApiStyle,
  providerId?: string,
) {
  const [models, setModels] = useState<string[]>(() => readDiscoveryCache(discoveryCacheKey(baseUrl, apiStyle, providerId))?.discovered ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);

  // 模型发现改为手动触发：只在用户点击“发现模型”按钮时执行，不再随输入自动调起。
  const discover = useCallback(() => {
    const trimmedUrl = baseUrl.trim();
    const seq = ++requestSeq.current;
    setModels([]);
    setError("");
    if (!trimmedUrl) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    window.harness.providers
      .discover({ id: providerId, baseUrl: trimmedUrl, apiKey: apiKey.trim(), apiStyle })
      .then((ids) => {
        if (seq === requestSeq.current) setModels(ids);
      })
      .catch((err) => {
        if (seq === requestSeq.current) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [baseUrl, apiKey, apiStyle, providerId]);

  return { models, loading, error, discover };
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
  apiStyle,
  loading,
  error,
  onDiscover,
  discoverDisabled,
}: {
  availableModels: string[];
  selectedModels: ProviderModelBinding[];
  onModelsChange: (models: ProviderModelBinding[]) => void;
  apiStyle: CatalogApiStyle;
  loading: boolean;
  error: string;
  onDiscover: () => void;
  discoverDisabled: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [customModelId, setCustomModelId] = useState("");
  const [customModelError, setCustomModelError] = useState("");
  const [openModelId, setOpenModelId] = useState<string | null>(null);

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

  const openModel = openModelId ? selectedById.get(openModelId) : undefined;
  // 未启用的模型：只预览默认配置，不写入已选列表。
  const openPreview = openModelId && !openModel ? applyKnownDefaults({ id: openModelId }) : undefined;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return availableIds.filter((id) => !needle || id.toLowerCase().includes(needle));
  }, [availableIds, search]);

  const toggleModel = (modelId: string) => {
    if (selectedById.has(modelId)) {
      onModelsChange(selectedModels.filter((m) => m.id !== modelId));
      // 关掉开关时，正在查看该模型的设置就一并收起。
      setOpenModelId((current) => (current === modelId ? null : current));
    } else {
      // 开启即按内置「常用模型默认配置表」补全上下文/输出/能力，免逐个手配。
      onModelsChange([...selectedModels, applyKnownDefaults({ id: modelId })]);
    }
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
    onModelsChange([...selectedModels, applyKnownDefaults({ id })]);
    setCustomModelId("");
    setCustomModelError("");
    setOpenModelId(id);
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
        <div className="provider-model-search">
          <Icon path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.35-4.35" size={14} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.filterModels")}
          />
          <button
            type="button"
            className="provider-model-discover"
            onClick={onDiscover}
            disabled={loading || discoverDisabled}
          >
            {loading ? t("settings.discoveringModels") : t("settings.discoverModels")}
          </button>
          <span className="provider-model-count">{t("settings.selectedModels", { n: selectedModels.length })}</span>
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
              <div
                key={modelId}
                className={`provider-model-row${isSelected ? " selected" : ""}`}
                role="button"
                tabIndex={0}
                title={t("settings.editModel")}
                onClick={() => setOpenModelId(modelId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenModelId(modelId);
                  }
                }}
              >
                <code>{modelId}</code>
                <label
                  className="provider-toggle"
                  title={isSelected ? t("settings.removeModel") : t("settings.addModelTitle")}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleModel(modelId)}
                  />
                  <span className="provider-toggle-track" />
                </label>
              </div>
            );
          })}
          {filtered.length === 0 && !loading && (
            <div className="provider-model-empty">{t("settings.noModels")}</div>
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

      <div className="provider-model-config">
        {openModel ? (
          <div className="provider-model-detail">
            <div className="provider-model-detail-head">
              <code>{openModel.id}</code>
              <span className="provider-model-badge">{limitsLabel(openModel)}</span>
              <div className="provider-model-detail-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={!needsDefaultsFill(openModel)}
                  title={t("settings.applyDefaultsTitle")}
                  onClick={() => updateModel(openModel.id, applyKnownDefaults(openModel))}
                >
                  <Icon path="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" size={13} />
                  <span>{t("settings.applyDefaults")}</span>
                </button>
                <button
                  type="button"
                  className="provider-model-icon-button"
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  onClick={() => setOpenModelId(null)}
                >
                  <Icon path="M6 6l12 12M18 6L6 18" size={13} />
                </button>
              </div>
            </div>

                <div className="provider-model-limits">
                  <label>
                    <span>{t("settings.contextWindow")}</span>
                    <input
                      type="number"
                      min="1"
                      value={openModel.contextWindow ?? ""}
                      onChange={(event) => updateModel(openModel.id, { contextWindow: readPositiveNumber(event.target.value) })}
                    />
                  </label>
                  <label>
                    <span>{t("settings.maxOutput")}</span>
                    <input
                      type="number"
                      min="1"
                      value={openModel.maxTokens ?? ""}
                      onChange={(event) => updateModel(openModel.id, { maxTokens: readPositiveNumber(event.target.value) })}
                    />
                  </label>
                </div>

                <div className="provider-model-flags">
                  <label className="provider-capability">
                    <input type="checkbox" checked={openModel.reasoning ?? false} onChange={(e) => updateModel(openModel.id, { reasoning: e.target.checked })} />
                    <span>{t("settings.supportsReasoning")}</span>
                  </label>
                  {openModel.reasoning && (
                    <div className="provider-thinking-levels" role="group" aria-label={t("settings.serviceThinkingLevels")}>
                      {SERVICE_THINKING_LEVELS.map((level) => (
                        <label className="provider-capability" key={level}>
                          <input type="checkbox" checked={serviceThinkingLevels(openModel, apiStyle).includes(level)}
                            onChange={(e) => updateModel(openModel.id, { thinkingLevels: e.target.checked
                              ? [...serviceThinkingLevels(openModel, apiStyle), level]
                              : serviceThinkingLevels(openModel, apiStyle).filter((value) => value !== level) })} />
                          <span>{t(effortLabelKey(level))}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="provider-capability" title={t("settings.serviceCapabilityHint")}>
                    <input type="checkbox" checked={openModel.supportsImages ?? false} onChange={(e) => updateModel(openModel.id, { supportsImages: e.target.checked })} />
                    <span>{t("settings.supportsImages")}</span>
                  </label>
                </div>
          </div>
        ) : openPreview ? (
          <div className="provider-model-detail">
            <div className="provider-model-detail-head">
              <code>{openPreview.id}</code>
              <span className="provider-model-badge">{limitsLabel(openPreview)}</span>
              <div className="provider-model-detail-actions">
                <button
                  type="button"
                  className="provider-model-icon-button"
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  onClick={() => setOpenModelId(null)}
                >
                  <Icon path="M6 6l12 12M18 6L6 18" size={13} />
                </button>
              </div>
            </div>
            <div className="provider-model-limits">
                    <label>
                      <span>{t("settings.contextWindow")}</span>
                      <input type="number" value={openPreview.contextWindow ?? ""} disabled />
                    </label>
                    <label>
                      <span>{t("settings.maxOutput")}</span>
                      <input type="number" value={openPreview.maxTokens ?? ""} disabled />
                    </label>
                  </div>
                  <div className="provider-model-flags">
                    <label className="provider-capability">
                      <input type="checkbox" checked={openPreview.reasoning ?? false} disabled />
                      <span>{t("settings.supportsReasoning")}</span>
                    </label>
                    {openPreview.reasoning && (
                      <div className="provider-thinking-levels" role="group" aria-label={t("settings.serviceThinkingLevels")}>
                        {SERVICE_THINKING_LEVELS.map((level) => (
                          <label className="provider-capability" key={level}>
                            <input type="checkbox" checked={serviceThinkingLevels(openPreview, apiStyle).includes(level)} disabled />
                            <span>{t(effortLabelKey(level))}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    <label className="provider-capability" title={t("settings.serviceCapabilityHint")}>
                      <input type="checkbox" checked={openPreview.supportsImages ?? false} disabled />
                      <span>{t("settings.supportsImages")}</span>
                    </label>
                  </div>
          </div>
        ) : (
          <div className="provider-model-detail provider-model-detail-empty">
            <Icon path="M4 4l7.07 17 2.51-7.39L21 11.07z" size={20} />
            <p>{t("settings.modelDetailEmpty")}</p>
          </div>
        )}
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
  const [showKey, setShowKey] = useState(false);
  const [apiStyle, setApiStyle] = useState<CatalogApiStyle>(
    (provider?.apiStyle as CatalogApiStyle) ?? "chat_completions",
  );
  const [models, setModels] = useState<ProviderModelBinding[]>(() => {
    if (provider?.models?.length) return provider.models;
    return readDiscoveryCache(discoveryCacheKey(baseUrl, apiStyle, provider?.id))?.bindings ?? [];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [defaultModelId, setDefaultModelId] = useState(
    provider?.defaultModelId ?? provider?.models[0]?.id ?? readDiscoveryCache(discoveryCacheKey(baseUrl, apiStyle, provider?.id))?.bindings?.[0]?.id ?? "",
  );
  const [testing, setTesting] = useState(false);
  const backdropClose = useBackdropClose(() => { if (!saving && !testing) onClose(); });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const namedPreset = NAMED_ENDPOINT_PRESETS.find((p) => p.id === service);
  const resolvedName = namedPreset ? name.trim() || namedPreset.name : name;
  const resolvedBaseUrl = baseUrl;
  const resolvedApiStyle = apiStyle;
  const selectedDefault = models.some((m) => m.id === defaultModelId) ? defaultModelId : models[0]?.id ?? "";

  const { models: discoveredModels, loading: discovering, error: discoveryError, discover } = useModelDiscovery(
    resolvedBaseUrl,
    apiKey,
    resolvedApiStyle,
    provider?.id,
  );

  // 保留上次发现结果与选中配置：打开弹窗时从缓存恢复，避免每次重新手动发现。
  useEffect(() => {
    if (!resolvedBaseUrl.trim()) return;
    const key = discoveryCacheKey(resolvedBaseUrl, resolvedApiStyle, provider?.id);
    const existing = readDiscoveryCache(key) ?? {};
    writeDiscoveryCache(key, { ...existing, discovered: discoveredModels, bindings: models });
  }, [discoveredModels, models, resolvedBaseUrl, resolvedApiStyle, provider?.id]);

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
    }} {...backdropClose}>
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
            <label className="provider-field">
              <span>{t("settings.apiKey")}</span>
              <span className="provider-key-field">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editing ? t("settings.apiKeyEditHint") : t("settings.apiKeyPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="provider-key-toggle"
                  title={showKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
                  aria-label={showKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
                  onClick={() => setShowKey((value) => !value)}
                >
                  <Icon
                    path={showKey
                      ? "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"
                      : "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"}
                    size={14}
                  />
                </button>
              </span>
            </label>
            {models.length > 0 && <label className="provider-field">
              <span>{t("settings.serviceModel")}</span>
              <select value={selectedDefault} onChange={(e) => setDefaultModelId(e.target.value)}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
            </label>}
          </div>

          <div className="provider-section">
            <h3>{t("settings.models")}</h3>
            <ModelSelectionPanes
              availableModels={discoveredModels}
              selectedModels={models}
              onModelsChange={setModels}
              apiStyle={resolvedApiStyle}
              loading={discovering}
              error={discoveryError}
              onDiscover={discover}
              discoverDisabled={!resolvedBaseUrl.trim()}
            />
          </div>
        </div>

        {error && (
          <div className="provider-error">
            <Icon path="M12 8v4m0 4h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 22 0z" size={14} />
            <span>{error}</span>
          </div>
        )}
        {testResult && <p role="status" className={testResult.ok ? "provider-test-success" : "provider-error"}>{testResult.message}</p>}
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
  const [busy, setBusy] = useState(false);  const action = async (run: () => Promise<void>) => {
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
            // 默认服务用全局默认模型，其他服务用自己文档里的默认模型（都能在服务编辑里改）。
            const serviceModel = ((isDefault ? defaultModelId : provider.defaultModelId) ?? provider.models[0]?.id) || "";
            return (
              <div
                key={provider.id}
                className={`provider-row${isDefault ? " default" : ""}${!provider.isEnabled ? " disabled" : ""}`}
              >
                <div className="provider-row-main">
                  <div className="provider-row-info">
                    <div className="provider-row-title">
                      <strong>{provider.name}</strong>
                      {isDefault && <span className="provider-row-default">{t("settings.default")}</span>}
                    </div>
                    <span className="provider-row-url">{provider.baseUrl}</span>
                    <span className="provider-row-meta">
                      <span>{provider.models.length} {t("settings.modelsCount")}</span>
                      {serviceModel && (
                        <span className="provider-row-model" title={t("settings.serviceModel")}>
                          <span className="provider-row-model-label">{t("settings.rowDefaultModelLabel")}</span>
                          <span className="provider-row-model-value">{serviceModel}</span>
                        </span>
                      )}
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
              </div>
            );
          })}
        </div>
      )}
      <p className="provider-hint">{t("settings.serviceTestHint")}</p>
    </div>
  );
}
