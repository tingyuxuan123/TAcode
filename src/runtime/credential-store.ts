/**
 * TACode Runtime 凭据存储。
 *
 * 与 Pi 的关系：Pi 的 `ModelRuntime` 通过注入的 `CredentialStore` 读取 API Key。
 * 本模块提供三种模式：
 * - `file`：只读 `<home>/auth.json`（与 Pi 原有 auth.json 同构）；
 * - `keyring`：系统钥匙串（macOS Keychain / Windows Credential Manager / Secret Service）；
 * - `auto`：优先钥匙串，不可用时回退文件。
 *
 * 注意：`auto` 模式**不会**把文件凭据搬到钥匙串并删除文件条目。桌面壳用
 * `TACODE_CREDENTIALS_STORE=file` 固定走文件存储（避免钥匙串弹窗），一旦自动迁移
 * 清空 `auth.json`，应用侧就会读到空密钥并报 401。
 *
 * 钥匙串服务名已随产品改名；早期版本写入旧服务名的凭据读不到，需要重新输入。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { tacodeEnv } from "./env.js";
import { getTacodeHome } from "./home.js";
import { getTacodeStorageSettings, type CredentialStoreMode } from "./settings.js";

/** 钥匙串服务名。 */
const KEYRING_SERVICE = "tacode-agent-core";
const STORE_PATCH = Symbol.for("tacode.runtime.credential-store-installed");
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;

function defaultAuthPath(): string {
  return path.join(getTacodeHome(), "auth.json");
}

/** 与 Pi 现有 auth.json 结构兼容的明文回退实现。 */
export class FileCredentialStore implements CredentialStore {
  readonly authPath: string;

  constructor(authPath: string = defaultAuthPath()) {
    this.authPath = authPath;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await readCredentialData(this.authPath))[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const data = await readCredentialData(this.authPath);
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withDirectoryLock(`${this.authPath}.lock`, async () => {
      const data = await readCredentialData(this.authPath);
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      await writePrivateJson(this.authPath, data);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await withDirectoryLock(`${this.authPath}.lock`, async () => {
      const data = await readCredentialData(this.authPath);
      if (!(providerId in data)) return;
      delete data[providerId];
      await writePrivateJson(this.authPath, data);
    });
  }
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface TacodeKeyringFactory {
  create(service: string, account: string): KeyringEntry;
}

/** 系统钥匙串后端。 */
export class KeyringCredentialStore implements CredentialStore {
  private readonly factory: TacodeKeyringFactory;
  readonly metadataPath: string;

  constructor(
    factory: TacodeKeyringFactory,
    metadataPath: string = path.join(getTacodeHome(), "credential-metadata.json"),
  ) {
    this.factory = factory;
    this.metadataPath = metadataPath;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const serialized = this.factory.create(KEYRING_SERVICE, providerId).getPassword();
    return serialized ? parseCredential(serialized, `system keyring entry for ${providerId}`) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const metadata = await readMetadata(this.metadataPath);
    return Object.entries(metadata.providers).map(([providerId, entry]) => ({
      providerId,
      type: entry.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withDirectoryLock(this.lockPath(providerId), async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      this.factory.create(KEYRING_SERVICE, providerId).setPassword(JSON.stringify(next));
      await this.remember(providerId, next.type);
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await withDirectoryLock(this.lockPath(providerId), async () => {
      this.factory.create(KEYRING_SERVICE, providerId).deletePassword();
      const metadata = await readMetadata(this.metadataPath);
      if (!(providerId in metadata.providers)) return;
      delete metadata.providers[providerId];
      await writePrivateJson(this.metadataPath, metadata);
    });
  }

  private lockPath(providerId: string): string {
    const safeProvider = providerId.replace(/[^a-zA-Z0-9_.-]/gu, "_");
    return path.join(getTacodeHome(), ".credential-locks", `${safeProvider}.lock`);
  }

  private async remember(providerId: string, type: Credential["type"]): Promise<void> {
    const metadata = await readMetadata(this.metadataPath);
    metadata.providers[providerId] = { type };
    await writePrivateJson(this.metadataPath, metadata);
  }
}

/** auto 模式：钥匙串优先，文件兜底。 */
class AutoCredentialStore implements CredentialStore {
  private readonly keyring: KeyringCredentialStore;
  private readonly file: FileCredentialStore;

  constructor(keyring: KeyringCredentialStore, file: FileCredentialStore) {
    this.keyring = keyring;
    this.file = file;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    try {
      const keyringCredential = await this.keyring.read(providerId);
      if (keyringCredential) return keyringCredential;
    } catch {
      // 回退到仅属主可读的 auth.json。
    }
    return this.file.read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const merged = new Map<string, CredentialInfo>();
    for (const entry of await this.file.list()) merged.set(entry.providerId, entry);
    try {
      for (const entry of await this.keyring.list()) merged.set(entry.providerId, entry);
    } catch {
      // 系统服务不可用时，文件列表仍是权威来源。
    }
    return [...merged.values()];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    try {
      const stored = await this.keyring.modify(providerId, async () => next);
      await this.file.delete(providerId);
      return stored;
    } catch {
      return this.file.modify(providerId, async () => next);
    }
  }

  async delete(providerId: string): Promise<void> {
    try {
      await this.keyring.delete(providerId);
    } catch {
      // 登出仍必须清除回退凭据。
    }
    await this.file.delete(providerId);
  }
}

export interface CreateCredentialStoreOptions {
  mode?: CredentialStoreMode;
  authPath?: string;
  metadataPath?: string;
  keyringFactory?: TacodeKeyringFactory;
}

export async function createTacodeCredentialStore(
  options: CreateCredentialStoreOptions = {},
): Promise<CredentialStore> {
  const configured = getTacodeStorageSettings();
  const mode = options.mode ?? configured.credentialStore;
  const file = new FileCredentialStore(options.authPath ?? defaultAuthPath());
  if (mode === "file") return file;
  if (mode === "auto" && !options.keyringFactory && !canUseInteractiveKeyring()) return file;
  let factory = options.keyringFactory;
  if (!factory) {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      factory = { create: (service, account) => new Entry(service, account) as KeyringEntry };
    } catch (error) {
      if (mode === "auto") return file;
      throw new Error(`System keyring is unavailable: ${errorMessage(error)}`);
    }
  }
  const keyring = new KeyringCredentialStore(
    factory,
    options.metadataPath ?? path.join(getTacodeHome(), "credential-metadata.json"),
  );
  if (mode === "keyring") return keyring;
  const automatic = new AutoCredentialStore(keyring, file);
  return automatic;
}

/**
 * Pi 的 CLI / RPC 入口内部会自行创建 `ModelRuntime`。这里给它打一次补丁，
 * 让 TUI / JSON / RPC 三种模式共用 TACode 的凭据存储。
 */
export async function installTacodeCredentialStore(): Promise<void> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = ModelRuntime as typeof ModelRuntime & { [STORE_PATCH]?: boolean };
  if (runtime[STORE_PATCH]) return;
  const credentials = await createTacodeCredentialStore();
  const create = ModelRuntime.create.bind(ModelRuntime);
  ModelRuntime.create = (options: Parameters<typeof create>[0] = {}) =>
    create({ ...options, credentials: options.credentials ?? credentials });
  runtime[STORE_PATCH] = true;
}

async function readCredentialData(authPath: string): Promise<Record<string, Credential>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(authPath, "utf8"));
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Credential] => isCredential(entry[1])),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime auth file: ${authPath}`);
    }
    throw error;
  }
}

interface CredentialMetadata {
  version: 1;
  providers: Record<string, { type: Credential["type"] }>;
}

async function readMetadata(metadataPath: string): Promise<CredentialMetadata> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return emptyMetadata();
    const providers: Record<string, { type: Credential["type"] }> = {};
    for (const [providerId, value] of Object.entries(parsed.providers)) {
      if (isRecord(value) && (value.type === "api_key" || value.type === "oauth")) {
        providers[providerId] = { type: value.type };
      }
    }
    return { version: 1, providers };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyMetadata();
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime credential metadata: ${metadataPath}`);
    }
    throw error;
  }
}

function emptyMetadata(): CredentialMetadata {
  return { version: 1, providers: {} };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function withDirectoryLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const stale = await fs
        .stat(lockPath)
        .then((stat) => Date.now() - stat.mtimeMs > LOCK_STALE_MS, () => false);
      if (stale) {
        await fs.rmdir(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for credential lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
  try {
    return await task();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
}

function parseCredential(serialized: string, source: string): Credential {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isCredential(parsed)) return parsed;
  } catch {
    // 无效 JSON 与形状不合法统一报同一条消息。
  }
  throw new Error(`Cannot parse ${source}`);
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    return value.key === undefined || typeof value.key === "string";
  }
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canUseInteractiveKeyring(): boolean {
  return Boolean(
    process.versions.electron ||
      (process.stdin.isTTY && process.stdout.isTTY) ||
      tacodeEnv("ALLOW_HEADLESS_KEYRING") === "1",
  );
}
