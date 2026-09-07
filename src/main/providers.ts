import { app, ipcMain } from "electron";
import { join } from "node:path";
import { createTetherCredentialStore } from "tether-agent-core";
import { ProviderRepository, serviceCredentialId } from "./provider-store";
import { listModels } from "../shared/openai-models";
import { serviceBaseUrl, serviceRuntimeConfig } from "../shared/provider-config";
import { testModelConnection } from "../shared/provider-connection";
import type { ProviderConnection, ProviderStatus } from "../shared/types";

let repository: ProviderRepository;
export function providerRepository(): ProviderRepository {
  return repository ??= new ProviderRepository(join(app.getPath("userData"), "providers.json"), {
    async read(id) {
      const stored = await (await createTetherCredentialStore()).read(id);
      return stored?.type === "api_key" ? stored.key ?? "" : "";
    },
    async write(id, key) { await (await createTetherCredentialStore()).modify(id, async () => ({ type: "api_key", key })); },
    async delete(id) { await (await createTetherCredentialStore()).delete(id); },
  });
}

async function connectionKey(input: ProviderConnection): Promise<string> {
  if (input.apiKey?.trim()) return input.apiKey.trim();
  if (!input.id) return "";
  const provider = (await providerRepository().load()).providers.find((p) => p.id === input.id);
  if (!provider) throw new Error("供应商不存在");
  if (serviceBaseUrl(input.baseUrl, input.apiStyle) !== provider.baseUrl || input.apiStyle !== provider.apiStyle) {
    throw new Error("接口地址或格式已更改，请重新填写 API 密钥后测试或发现模型");
  }
  return providerRepository().credentials.read(serviceCredentialId(input.id));
}

export async function desktopProviderStatus(): Promise<ProviderStatus | undefined> {
  const store = await providerRepository().load();
  const provider = store.providers.find((p) => p.id === store.defaultProviderId);
  if (!provider) return undefined;
  return { id: "openai", serviceId: provider.id, serviceVersion: provider.updatedAt, name: provider.name, configured: true, preferred: true,
    defaultModel: store.defaultModelId ?? provider.defaultModelId ?? provider.models[0].id,
    models: provider.models.map((m) => m.id), baseUrl: provider.baseUrl };
}

export async function resolveDesktopProvider(id: string, modelId?: string) {
  const store = await providerRepository().load();
  const provider = store.providers.find((p) => p.id === id && p.isEnabled);
  if (!provider) throw new Error("供应商已删除或禁用，请重新选择服务");
  const model = modelId || (store.defaultProviderId === id ? store.defaultModelId : provider.defaultModelId) || provider.models[0].id;
  if (!provider.models.some((m) => m.id === model)) throw new Error("模型不属于当前供应商，请重新选择模型");
  return { model, config: serviceRuntimeConfig(provider), apiKey: await providerRepository().credentials.read(serviceCredentialId(id)) };
}

export function registerProviderIpcHandlers(): void {
  const repo = providerRepository();
  ipcMain.handle("providers:list", async () => (await repo.load()).providers);
  ipcMain.handle("providers:defaults", async () => {
    const { defaultProviderId, defaultModelId } = await repo.load();
    return { defaultProviderId, defaultModelId };
  });
  ipcMain.handle("providers:create", (_e, input) => repo.create(input));
  ipcMain.handle("providers:update", (_e, input) => repo.update(input));
  ipcMain.handle("providers:delete", (_e, id) => repo.delete(id));
  ipcMain.handle("providers:set-default", (_e, id, model) => repo.setDefault(id, model));
  ipcMain.handle("providers:discover", async (_e, input: ProviderConnection) => {
    const key = await connectionKey(input);
    return listModels(serviceBaseUrl(input.baseUrl, input.apiStyle), key, input.apiStyle);
  });
  ipcMain.handle("providers:test-connection", async (_e, input: ProviderConnection & { modelId: string }) => {
    try { return await testModelConnection(input, await connectionKey(input)); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.handle("providers:test", async (_e, id: string) => {
    const provider = (await repo.load()).providers.find((p) => p.id === id);
    if (!provider) return { ok: false, message: "供应商不存在" };
    return testModelConnection({ ...provider, modelId: provider.defaultModelId ?? provider.models[0].id }, await connectionKey(provider));
  });
}
