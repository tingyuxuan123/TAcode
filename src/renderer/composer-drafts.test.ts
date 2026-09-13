import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerDraftStore, DRAFT_TTL_MS, MAX_DRAFT_IMAGE_SIZE, MAX_DRAFTS, draftScope, type ComposerDraft, type DraftImage, type DraftPersistence } from "./composer-drafts";

const image = (id: string): DraftImage => ({ id, name: `${id}.png`, dataUri: `data:image/png;base64,${id}` });
function persistence(initial: Array<[string, ComposerDraft]> = []) {
  let rows = initial;
  return {
    load: async () => structuredClone(rows),
    save: vi.fn(async (next) => { rows = structuredClone(next); }),
  } satisfies DraftPersistence;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("conversation drafts", () => {
  it("keeps project/session text, file references and images independent", async () => {
    const store = new ComposerDraftStore(persistence());
    await store.loaded;
    const a = draftScope("/project", "/a"), b = draftScope("/project", "/b");
    store.update(a, { text: "检查 @src/App.tsx ", images: [image("1"), image("2")] });
    store.update(b, { text: "B 的草稿" });
    expect(store.get(a).text).toBe("检查 @src/App.tsx ");
    expect(store.get(a).images).toHaveLength(2);
    expect(store.get(b).text).toBe("B 的草稿");
    expect(store.get(draftScope("/other"))).toMatchObject({ text: "", images: [] });
  });

  it("restores every rejected attachment without replacing later typing", async () => {
    const store = new ComposerDraftStore(persistence());
    await store.loaded;
    store.update("a", { text: "原文", images: [image("1"), image("2")] });
    const receipt = store.begin("a");
    expect(store.get("a")).toMatchObject({ text: "", images: [] });
    store.update("a", { text: "等待时输入的新文字", images: [image("3")] });
    store.finish(receipt.id, false);
    expect(store.get("a")).toMatchObject({ text: "原文\n\n等待时输入的新文字", images: [image("1"), image("2"), image("3")], restored: true });
    store.finish(receipt.id, false);
    expect(store.get("a").images).toHaveLength(3);
  });

  it("moves pending sends and newer drafts to a newly created session, never to B", async () => {
    const store = new ComposerDraftStore(persistence());
    await store.loaded;
    store.update("new", { text: "新会话", images: [image("1"), image("2")] });
    const receipt = store.begin("new");
    store.update("new", { text: "补充" });
    store.move("new", "a");
    store.update("b", { text: "另一个会话" });
    store.finish(receipt.id, false);
    expect(store.get("a").text).toBe("新会话\n\n补充");
    expect(store.get("a").images).toHaveLength(2);
    expect(store.get("b").text).toBe("另一个会话");
    expect(store.get("new").text).toBe("");
  });

  it("clears only acknowledged content and persists newer edits across reload", async () => {
    const disk = persistence();
    const store = new ComposerDraftStore(disk);
    await store.loaded;
    store.update("a", { text: "已发送", images: [image("1"), image("2")] });
    const receipt = store.begin("a");
    store.update("a", { text: "下一条", images: [image("3")] });
    store.finish(receipt.id, true);
    await store.flush();
    const restored = new ComposerDraftStore(disk);
    await restored.loaded;
    expect(restored.get("a")).toMatchObject({ text: "下一条", images: [image("3")] });
  });

  it("restores an unconfirmed send with a warning instead of silently resending", async () => {
    const disk = persistence();
    const store = new ComposerDraftStore(disk);
    await store.loaded;
    store.update("a", { text: "可能已发送", images: [image("1")] });
    store.begin("a");
    store.update("a", { text: "后续草稿" });
    await store.flush();
    const restored = new ComposerDraftStore(disk);
    await restored.loaded;
    expect(restored.get("a")).toMatchObject({ text: "可能已发送\n\n后续草稿", unconfirmed: true, images: [image("1")] });
  });

  it("counts pending images against the cache budget and rejects new uploads without losing existing ones", async () => {
    const store = new ComposerDraftStore(persistence());
    await store.loaded;
    const images = Array.from({ length: 4 }, (_, i) => ({ ...image(String(i)), dataUri: "x".repeat(MAX_DRAFT_IMAGE_SIZE) }));
    store.update("a", { images });
    const pending = store.begin("a");
    expect(() => store.update("b", { images: [image("b")] })).toThrow("draftImageBudget");
    store.finish(pending.id, false);
    expect(store.get("a").images).toHaveLength(4);
    expect(store.get("b").images).toEqual([]);
  });

  it("cleans expired drafts and persists only the bounded recent set", async () => {
    const now = Date.now();
    const disk = persistence([
      ["old", { text: "old", images: [image("old")], updatedAt: now - DRAFT_TTL_MS - 1 }],
      ...Array.from({ length: MAX_DRAFTS + 3 }, (_, i): [string, ComposerDraft] => [`${i}`, { text: `${i}`, images: [], updatedAt: now - i }]),
    ]);
    const store = new ComposerDraftStore(disk, () => now);
    await store.loaded;
    await store.flush();
    expect(store.get("old").images).toEqual([]);
    expect((await disk.load())).toHaveLength(MAX_DRAFTS);
  });

  it("keeps the draft and reports a disk failure without rejecting user edits", async () => {
    const disk = persistence();
    disk.save.mockRejectedValue(new Error("disk full"));
    const store = new ComposerDraftStore(disk);
    await store.loaded;
    store.update("a", { text: "保留内容", images: [image("1")] });
    await store.flush();
    expect(store.storageError).toBe(true);
    expect(store.get("a").text).toBe("保留内容");
    expect(store.get("a").images).toEqual([image("1")]);
  });

  it("routes an image read across session creation and discards late work for a removed conversation", async () => {
    const store = new ComposerDraftStore(persistence());
    await store.loaded;
    const target = store.follow("new");
    store.update("new", { text: "待发送" });
    const pending = store.begin("new");
    store.move("new", "a");
    expect(target.key).toBe("a");
    store.remove("a");
    expect(target.discarded).toBe(true);
    store.finish(pending.id, false);
    expect(store.get("a").text).toBe("");
    store.release(target);
  });
});
