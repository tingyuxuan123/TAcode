import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DesktopApi, ProviderRecord } from "../shared/types";
import { validateService } from "../shared/provider-config";

export interface ProviderStoreData {
  providers: ProviderRecord[];
  defaultProviderId: string | null;
  defaultModelId: string | null;
}
type CreateInput = Parameters<DesktopApi["providers"]["create"]>[0];
type UpdateInput = Parameters<DesktopApi["providers"]["update"]>[0];
export const serviceCredentialId = (id: string) => `desktop-service:${id}`;
export interface ServiceCredentials {
  read(id: string): Promise<string>;
  write(id: string, key: string): Promise<void>;
  delete(id: string): Promise<void>;
}

function normalizeDefaults(store: ProviderStoreData): ProviderStoreData {
  const provider = store.providers.find((p) => p.id === store.defaultProviderId && p.isEnabled)
    ?? store.providers.find((p) => p.isEnabled);
  if (!provider) return { ...store, defaultProviderId: null, defaultModelId: null };
  const model = provider.id === store.defaultProviderId && provider.models.some((m) => m.id === store.defaultModelId)
    ? store.defaultModelId : provider.defaultModelId ?? provider.models[0]?.id ?? null;
  return { ...store, defaultProviderId: provider.id, defaultModelId: model };
}

/** Serialize main-process read/modify/write so simultaneous IPC updates cannot be lost. */
export class ProviderRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private filePath: string, readonly credentials: ServiceCredentials) {}

  private async read(): Promise<ProviderStoreData> {
    let raw: string;
    try { raw = await readFile(this.filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [], defaultProviderId: null, defaultModelId: null };
      throw error;
    }
    const data = JSON.parse(raw) as ProviderStoreData;
    if (!data || !Array.isArray(data.providers)) throw new Error("供应商配置文件损坏，请先备份并修复 providers.json");
    return normalizeDefaults({ ...data, providers: data.providers.map(validateService) });
  }

  async load(): Promise<ProviderStoreData> {
    await this.queue;
    return this.read();
  }

  private mutate<T>(change: (store: ProviderStoreData, setKey: (id: string, key?: string) => Promise<void>) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const store = await this.read();
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      const previousKeys = new Map<string, string>();
      const setKey = async (id: string, key?: string) => {
        if (!previousKeys.has(id)) previousKeys.set(id, await this.credentials.read(id));
        if (key) await this.credentials.write(id, key);
        else await this.credentials.delete(id);
      };
      try {
        const result = await change(store, setKey);
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(temp, JSON.stringify(normalizeDefaults(store), null, 2), { mode: 0o600 });
        await rename(temp, this.filePath);
        return result;
      } catch (error) {
        // Compensate credential changes when metadata persistence fails.
        // This is not crash-atomic across the filesystem and OS credential store.
        try {
          for (const [id, key] of previousKeys) {
            if (key) await this.credentials.write(id, key);
            else await this.credentials.delete(id);
          }
        } catch {
          throw new Error("供应商保存失败，且无法恢复原凭据。请检查凭据存储并重新填写该服务密钥");
        }
        throw error;
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  create(input: CreateInput): Promise<ProviderRecord> {
    return this.mutate(async (store, setKey) => {
      const now = new Date().toISOString();
      const record = validateService({
        id: randomUUID(), name: input.name, vendorKey: input.vendorKey?.trim() || "custom",
        baseUrl: input.baseUrl, apiStyle: input.apiStyle, models: input.models,
        defaultModelId: input.defaultModelId, isEnabled: true, createdAt: now, updatedAt: now,
      });
      if (input.apiKey?.trim()) {
        await setKey(serviceCredentialId(record.id), input.apiKey.trim());
        record.apiKeyHint = "••••••••";
      }
      store.providers.push(record);
      return record;
    });
  }

  update(input: UpdateInput): Promise<ProviderRecord | null> {
    return this.mutate(async (store, setKey) => {
      const index = store.providers.findIndex((p) => p.id === input.id);
      if (index < 0) return null;
      const { apiKey, name, vendorKey, baseUrl, apiStyle, models, defaultModelId, isEnabled } = input;
      const fields = { name, vendorKey, baseUrl, apiStyle, models, defaultModelId, isEnabled };
      const definedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      const record = validateService({ ...store.providers[index], ...definedFields, updatedAt: new Date().toISOString() });
      if ((record.baseUrl !== store.providers[index].baseUrl || record.apiStyle !== store.providers[index].apiStyle)
        && store.providers[index].apiKeyHint && !apiKey?.trim()) throw new Error("接口地址或格式已更改，请重新填写 API 密钥");
      if (apiKey?.trim()) {
        await setKey(serviceCredentialId(record.id), apiKey.trim());
        record.apiKeyHint = "••••••••";
      }
      store.providers[index] = record;
      if (store.defaultProviderId === record.id && input.defaultModelId !== undefined) store.defaultModelId = record.defaultModelId ?? null;
      return record;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.mutate(async (store, setKey) => {
      const index = store.providers.findIndex((p) => p.id === id);
      if (index < 0) return false;
      await setKey(serviceCredentialId(id));
      store.providers.splice(index, 1);
      return true;
    });
  }

  setDefault(id: string, modelId?: string): Promise<boolean> {
    return this.mutate(async (store) => {
      const provider = store.providers.find((p) => p.id === id && p.isEnabled);
      if (!provider) throw new Error("请先启用该供应商");
      const model = modelId ?? provider.defaultModelId ?? provider.models[0]?.id;
      if (!provider.models.some((m) => m.id === model)) throw new Error("默认模型不属于该供应商");
      provider.defaultModelId = model;
      store.defaultProviderId = id;
      store.defaultModelId = model ?? null;
      return true;
    });
  }
}
