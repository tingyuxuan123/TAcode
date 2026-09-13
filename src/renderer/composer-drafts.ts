export interface DraftImage {
  id: string;
  name: string;
  dataUri: string;
}

export interface ComposerDraft {
  text: string;
  images: DraftImage[];
  updatedAt: number;
  /** 重载发生在发送确认之前，不能自动重发。 */
  unconfirmed?: boolean;
  restored?: boolean;
}

export interface DraftPersistence {
  load(): Promise<Array<[string, ComposerDraft]>>;
  checkpoint?(rows: Array<[string, ComposerDraft]>): void;
  save(rows: Array<[string, ComposerDraft]>): Promise<void>;
}
interface DraftTarget { key: string; discarded?: boolean }

const EMPTY: ComposerDraft = { text: "", images: [], updatedAt: 0 };
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DRAFTS = 100;
export const MAX_DRAFT_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_DRAFT_IMAGE_SIZE = 8 * 1024 * 1024;
export const draftScope = (cwd?: string, session?: string) => JSON.stringify([cwd ?? "", session ?? "new"]);

function mergeDrafts(earlier: ComposerDraft, later: ComposerDraft): ComposerDraft {
  const seen = new Set(earlier.images.map((image) => image.id));
  return {
    ...later,
    text: [earlier.text, later.text].filter(Boolean).join("\n\n"),
    images: [...earlier.images, ...later.images.filter((image) => !seen.has(image.id))],
  };
}

/** 草稿与发送收据分开：等待时可以继续输入，失败只恢复到原会话。 */
export class ComposerDraftStore {
  private rows = new Map<string, ComposerDraft>();
  private pending = new Map<number, { key: string; draft: ComposerDraft }>();
  private targets = new Set<DraftTarget>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private receipt = 0;
  private timestamp = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  ready = false;
  storageError = false;
  readonly loaded: Promise<void>;

  constructor(private persistence: DraftPersistence, private now = Date.now) {
    this.loaded = this.restore();
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  get(key: string): ComposerDraft { return this.rows.get(key) ?? EMPTY; }
  follow(key: string): DraftTarget { const target = { key }; this.targets.add(target); return target; }
  release(target: DraftTarget): void { this.targets.delete(target); }

  update(key: string, patch: Partial<Pick<ComposerDraft, "text" | "images">>): void {
    const next = { ...this.get(key), ...patch, restored: false, updatedAt: this.time() };
    if (patch.images?.some((image) => image.dataUri.length > MAX_DRAFT_IMAGE_SIZE)) throw new Error("draftImageSize");
    if (patch.images && this.imageBytes(key, next.images) > MAX_DRAFT_IMAGE_BYTES) throw new Error("draftImageBudget");
    this.rows.set(key, next);
    this.changed();
  }

  move(from: string, to: string): void {
    if (from === to) return;
    const current = this.get(from);
    if (current !== EMPTY) this.rows.set(to, { ...mergeDrafts(current, this.get(to)), updatedAt: this.time() });
    this.rows.delete(from);
    for (const item of this.pending.values()) if (item.key === from) item.key = to;
    for (const target of this.targets) if (target.key === from) target.key = to;
    this.changed();
  }

  begin(key: string): { id: number; draft: ComposerDraft } {
    const draft = this.get(key);
    const id = ++this.receipt;
    this.pending.set(id, { key, draft });
    this.rows.set(key, { ...EMPTY, updatedAt: this.time() });
    this.changed();
    return { id, draft };
  }

  finish(id: number, accepted: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const current = this.get(pending.key);
    this.rows.set(pending.key, {
      ...(accepted ? current : mergeDrafts(pending.draft, current)),
      restored: !accepted, updatedAt: this.time(),
    });
    this.changed();
    void this.flush();
  }

  remove(key: string): void {
    this.rows.delete(key);
    for (const [id, item] of this.pending) if (item.key === key) this.pending.delete(id);
    for (const target of this.targets) if (target.key === key) target.discarded = true;
    this.changed();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.ready) return;
    const rows = this.persistedRows();
    try { this.persistence.checkpoint?.(rows); } catch { /* The async store can still save. */ }
    this.writes = this.writes.catch(() => {}).then(() => this.persistence.save(rows)).then(() => {
      if (this.storageError) { this.storageError = false; this.publish(); }
    }, () => { this.storageError = true; this.publish(); });
    await this.writes;
  }

  private async restore(): Promise<void> {
    try {
      const cutoff = this.now() - DRAFT_TTL_MS;
      const rows = (await this.persistence.load()).filter(([, draft]) => draft.updatedAt >= cutoff)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_DRAFTS);
      let bytes = 0;
      for (const [key, draft] of rows) {
        const images = draft.images.filter((image) => {
          if (bytes + image.dataUri.length > MAX_DRAFT_IMAGE_BYTES) return false;
          bytes += image.dataUri.length;
          return true;
        });
        if (!this.rows.has(key)) this.rows.set(key, { ...draft, images });
        this.timestamp = Math.max(this.timestamp, draft.updatedAt);
      }
    } catch { this.storageError = true; }
    this.ready = true;
    this.changed();
  }

  private time(): number { return this.timestamp = Math.max(this.now(), this.timestamp + 1); }
  private imageBytes(key: string, images: DraftImage[]): number {
    const unique = new Map(images.map((image) => [image.id, image.dataUri.length]));
    for (const [other, draft] of this.rows) if (other !== key) for (const image of draft.images) unique.set(image.id, image.dataUri.length);
    for (const { draft } of this.pending.values()) for (const image of draft.images) unique.set(image.id, image.dataUri.length);
    return [...unique.values()].reduce((total, bytes) => total + bytes, 0);
  }

  private persistedRows(): Array<[string, ComposerDraft]> {
    const rows = new Map(this.rows);
    for (const { key, draft } of [...this.pending.values()].reverse()) {
      rows.set(key, { ...mergeDrafts(draft, rows.get(key) ?? EMPTY), unconfirmed: true });
    }
    const cutoff = this.now() - DRAFT_TTL_MS;
    const kept = [...rows].filter(([, draft]) => draft.updatedAt >= cutoff)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_DRAFTS);
    const keys = new Set(kept.map(([key]) => key));
    for (const key of this.rows.keys()) if (!keys.has(key) && ![...this.pending.values()].some((item) => item.key === key)) this.rows.delete(key);
    return kept;
  }

  private changed(): void {
    this.publish();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
  }
  private publish(): void { this.revision++; for (const listener of this.listeners) listener(); }
}

const TEXT_KEY = "tacode.composer-drafts.v1";
type StoredDraft = Omit<ComposerDraft, "images"> & { images: Array<Omit<DraftImage, "dataUri">> };

function validRows(value: unknown): Array<[string, ComposerDraft]> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is [string, ComposerDraft] => Array.isArray(row) && typeof row[0] === "string"
    && row[1] && typeof row[1].text === "string" && Number.isFinite(row[1].updatedAt) && Array.isArray(row[1].images));
}

/** 图片单独存放，仅新增图片写入二进制缓存；打字只更新很小的草稿元数据。 */
export function browserDraftPersistence(): DraftPersistence {
  let opened: Promise<IDBDatabase> | undefined;
  let savedImages = new Set<string>();
  const db = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tacode-composer-drafts", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts");
      request.result.createObjectStore("images", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const metadataOf = (rows: Array<[string, ComposerDraft]>) => rows.map(([key, draft]) => [key, {
    ...draft, images: draft.images.map(({ id, name }) => ({ id, name })),
  }]);
  return {
    checkpoint(rows) { localStorage.setItem(TEXT_KEY, JSON.stringify(metadataOf(rows))); },
    async load() {
      let fallback: Array<[string, ComposerDraft]> = [];
      try { fallback = validRows(JSON.parse(localStorage.getItem(TEXT_KEY) ?? "[]")); } catch { /* IDB can still recover. */ }
      try {
        const database = await db();
        const tx = database.transaction(["drafts", "images"], "readonly");
        const [metadata, images] = await Promise.all([
          read(tx.objectStore("drafts").get("rows")) as Promise<Array<[string, StoredDraft]> | undefined>,
          read(tx.objectStore("images").getAll()) as Promise<DraftImage[]>,
        ]);
        const imageMap = new Map(images.map((image) => [image.id, image]));
        savedImages = new Set(imageMap.keys());
        const rows = new Map<string, ComposerDraft>((metadata ?? []).map(([key, draft]) => [key, {
          ...draft, images: draft.images.flatMap((image) => imageMap.get(image.id) ?? []),
        }]));
        for (const [key, draft] of fallback) {
          const previous = rows.get(key);
          if (!previous || draft.updatedAt > previous.updatedAt) rows.set(key, {
            ...draft, images: draft.images.flatMap((image) => imageMap.get(image.id) ?? []),
          });
        }
        return [...rows];
      } catch { return fallback.map(([key, draft]) => [key, { ...draft, images: [] }]); }
    },
    async save(rows) {
      const metadata = metadataOf(rows);
      const database = await db();
      const tx = database.transaction(["drafts", "images"], "readwrite");
      tx.objectStore("drafts").put(metadata, "rows");
      const nextIds = new Set<string>();
      for (const [, draft] of rows) for (const image of draft.images) {
        nextIds.add(image.id);
        if (!savedImages.has(image.id)) tx.objectStore("images").put(image);
      }
      for (const id of savedImages) if (!nextIds.has(id)) tx.objectStore("images").delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      savedImages = nextIds;
    },
  };
}

let shared: ComposerDraftStore | undefined;
export function composerDrafts(): ComposerDraftStore {
  if (!shared) {
    shared = new ComposerDraftStore(browserDraftPersistence());
    window.addEventListener("pagehide", () => { void shared?.flush(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) void shared?.flush(); });
  }
  return shared;
}
