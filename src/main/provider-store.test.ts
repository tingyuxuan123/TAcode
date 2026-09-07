import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRepository, serviceCredentialId } from "./provider-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

describe("desktop provider repository", () => {
  let dir: string;
  let file: string;
  let keys: Map<string, string>;
  let repo: ProviderRepository;
  const input = { name: "Gateway", vendorKey: "custom", baseUrl: "https://example.test/v1", apiStyle: "chat_completions" as const,
    models: [{ id: "model-A" }, { id: "model-B" }], apiKey: "secret-one" };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tether-provider-store-"));
    file = join(dir, "providers.json");
    keys = new Map();
    repo = new ProviderRepository(file, {
      async read(id) { return keys.get(id) ?? ""; },
      async write(id, key) { keys.set(id, key); },
      async delete(id) { keys.delete(id); },
    });
  });
  afterEach(async () => { vi.mocked(fs.rename).mockReset(); await rm(dir, { recursive: true, force: true }); });

  it("isolates credentials for two services of the same vendor and never writes keys to metadata", async () => {
    const first = await repo.create(input);
    const second = await repo.create({ ...input, apiKey: "secret-two" });
    expect(keys.get(serviceCredentialId(first.id))).toBe("secret-one");
    expect(keys.get(serviceCredentialId(second.id))).toBe("secret-two");
    expect(await readFile(file, "utf8")).not.toContain("secret-");
    expect(await repo.load()).toMatchObject({ defaultProviderId: first.id, defaultModelId: "model-A" });
  });
  it("retains keys on blank edits, replaces on explicit edits, and deletes only the selected key", async () => {
    const a = await repo.create(input);
    const b = await repo.create(input);
    await repo.update({ id: a.id, name: "Renamed", apiKey: "" });
    expect(keys.get(serviceCredentialId(a.id))).toBe("secret-one");
    await repo.update({ id: a.id, apiKey: "replacement" });
    expect(keys.get(serviceCredentialId(a.id))).toBe("replacement");
    await repo.delete(a.id);
    expect(keys.has(serviceCredentialId(a.id))).toBe(false);
    expect(keys.has(serviceCredentialId(b.id))).toBe(true);
    expect(await repo.load()).toMatchObject({ defaultProviderId: b.id });
  });
  it("repairs defaults after model removal, disabling and deletion", async () => {
    const a = await repo.create(input);
    const b = await repo.create(input);
    await repo.setDefault(a.id, "model-B");
    await repo.update({ id: a.id, models: [{ id: "model-A" }] });
    expect((await repo.load()).defaultModelId).toBe("model-A");
    await repo.update({ id: a.id, isEnabled: false });
    expect((await repo.load()).defaultProviderId).toBe(b.id);
    await expect(repo.setDefault(a.id)).rejects.toThrow("启用");
    await expect(repo.setDefault(b.id, "foreign-model")).rejects.toThrow("不属于");
    await repo.update({ id: b.id, isEnabled: false });
    expect(await repo.load()).toMatchObject({ defaultProviderId: null, defaultModelId: null });
  });
  it("serializes concurrent creates and updates without losing records", async () => {
    const providers = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.create({ ...input, name: `Service ${i}` })));
    await Promise.all(providers.map((p) => repo.update({ id: p.id, name: `${p.name} edited` })));
    expect((await repo.load()).providers).toHaveLength(8);
    expect((await repo.load()).providers.every((p) => p.name.endsWith("edited"))).toBe(true);
  });
  it("validates models and URLs before storing credentials", async () => {
    await expect(repo.create({ ...input, baseUrl: "file:///etc/passwd" })).rejects.toThrow("http(s)");
    await expect(repo.create({ ...input, models: [] })).rejects.toThrow("至少");
    await expect(repo.create({ ...input, models: [{ id: "a", contextWindow: 10, maxTokens: 11 }] })).rejects.toThrow("不能超过");
    expect(keys.size).toBe(0);
  });
  it("requires an explicit replacement key before moving an authenticated service", async () => {
    const a = await repo.create(input);
    await expect(repo.update({ id: a.id, baseUrl: "https://other.test/v1" })).rejects.toThrow("重新填写");
    expect((await repo.load()).providers[0].baseUrl).toBe(input.baseUrl);
  });
  it("surfaces a corrupt store instead of overwriting it", async () => {
    await writeFile(file, "broken-json");
    await expect(repo.create(input)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken-json");
  });
  it("persists per-model capability settings", async () => {
    await repo.create({ ...input, models: [{ id: "a", reasoning: true, supportsImages: true, thinkingLevels: ["low", "high"], contextWindow: 32000, maxTokens: 4096 }] });
    expect((await repo.load()).providers[0].models[0]).toMatchObject({ reasoning: true, supportsImages: true, thinkingLevels: ["low", "high"], contextWindow: 32000, maxTokens: 4096 });
  });
  it("does not persist unknown IPC update fields or allow metadata identity changes", async () => {
    const provider = await repo.create(input);
    await repo.update({ id: provider.id, name: "Safe", createdAt: "forged", apiKeyHint: "raw-secret", injected: true } as Parameters<ProviderRepository["update"]>[0]);
    const loaded = (await repo.load()).providers[0];
    expect(loaded.createdAt).toBe(provider.createdAt);
    expect(loaded.apiKeyHint).toBe("••••••••");
    expect(await readFile(file, "utf8")).not.toContain("injected");
  });
  it("restores credentials when metadata cannot be replaced", async () => {
    const provider = await repo.create(input);
    const failRename = vi.mocked(fs.rename).mockRejectedValue(new Error("disk unavailable"));
    await expect(repo.update({ id: provider.id, apiKey: "replacement" })).rejects.toThrow("disk unavailable");
    expect(keys.get(serviceCredentialId(provider.id))).toBe("secret-one");
    await expect(repo.delete(provider.id)).rejects.toThrow("disk unavailable");
    expect(keys.get(serviceCredentialId(provider.id))).toBe("secret-one");
    await expect(repo.create(input)).rejects.toThrow("disk unavailable");
    expect(keys.size).toBe(1);
    failRename.mockReset();
    expect((await repo.load()).providers).toHaveLength(1);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
