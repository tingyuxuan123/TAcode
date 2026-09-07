import type { ProviderRecord, ProviderStatus } from "./types";
import { serviceRuntimeConfig } from "./provider-config";

export interface ModelOption {
  value: string;
  label: string;
  modelId: string;
  serviceId?: string;
  providerName: string;
}

export function modelOptionKey(serviceId: string | undefined, modelId: string): string {
  return JSON.stringify([serviceId ?? "", modelId]);
}

export function desktopProviderStatuses(
  providers: ProviderRecord[],
  defaultProviderId: string | null,
  defaultModelId: string | null,
): ProviderStatus[] {
  return providers.filter((provider) => provider.isEnabled && provider.models.length > 0).map((provider) => ({
    id: "openai",
    serviceId: provider.id,
    serviceVersion: provider.updatedAt,
    name: provider.name,
    configured: true,
    preferred: provider.id === defaultProviderId,
    defaultModel: (provider.id === defaultProviderId ? defaultModelId : undefined)
      ?? provider.defaultModelId ?? provider.models[0].id,
    models: provider.models.map((model) => model.id),
    modelCapabilities: serviceRuntimeConfig(provider).models,
    baseUrl: provider.baseUrl,
  }));
}

export function composerModelOptions(accounts: ProviderStatus[], currentModel: string, legacyModels: string[]): ModelOption[] {
  const services = accounts.filter((provider) => provider.serviceId && provider.configured);
  if (services.length) {
    return services.flatMap((provider) => [...new Set(provider.models ?? [])].map((modelId) => ({
      value: modelOptionKey(provider.serviceId, modelId),
      label: modelId,
      modelId,
      serviceId: provider.serviceId,
      providerName: provider.name,
    })));
  }
  const providerName = accounts.find((provider) => provider.id === "deepseek")?.name ?? "";
  return [...new Set([currentModel, ...legacyModels].filter(Boolean))].map((modelId) => ({
    value: modelOptionKey(undefined, modelId), label: modelId, modelId, providerName,
  }));
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) => terms.every((term) => `${option.providerName} ${option.label}`.toLowerCase().includes(term)));
}
