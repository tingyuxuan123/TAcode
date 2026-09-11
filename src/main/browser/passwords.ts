import { safeStorage } from "electron";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { getTacodeHome } from "../../runtime/index";
import { join } from "node:path";

/**
 * 内置浏览器密码保险库（Password Vault）。
 *
 * 移植自 Snow App（MIT）browserPasswordManager.ts，落盘目录改为
 * ~/.tacode/browser-passwords/（对齐 TACode 本地数据约定）。
 *
 * 加密方案（两层结构）：
 * 1. 首次使用生成随机 32 字节 AES-256 主密钥，用 Electron `safeStorage`
 *    （macOS Keychain / Windows DPAPI / Linux 密钥环）加密后落盘
 *    `vault.key` —— 密钥本身由操作系统级凭据保护。
 * 2. 全部密码记录以 AES-256-GCM 加密（随机 12 字节 IV + 16 字节认证
 *    tag）写入 `vault.bin`，密文含完整性认证，防篡改。
 *
 * 安全设计：
 * - safeStorage 不可用时拒绝保存（绝不落明文）。
 * - 列表接口不返回明文密码；仅在按 id 查看或按 origin 自动填充时解密。
 * - IPC 的 find（自动填充）通道带 senderFrame origin 校验（见 ipc.ts），
 *   恶意 guest 页面无法跨源读取其他站点的凭据。
 * - 文件权限 0600；写入采用临时文件 + rename 原子替换。
 */

const VAULT_DIR = join(getTacodeHome(), "browser-passwords");
const KEY_FILE = join(VAULT_DIR, "vault.key");
const VAULT_FILE = join(VAULT_DIR, "vault.bin");
const VAULT_VERSION = 1;

export type StoredPasswordRecord = {
  id: string;
  origin: string;
  username: string;
  password: string;
  createdAt: number;
  updatedAt: number;
};

export type PasswordRecordSummary = Omit<StoredPasswordRecord, "password">;

export type PasswordSaveInput = {
  origin: string;
  username: string;
  password: string;
};

type VaultFile = {
  version: number;
  records: StoredPasswordRecord[];
};

let vaultPromise: Promise<StoredPasswordRecord[]> | null = null;
let writeChain: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// 加密原语
// ---------------------------------------------------------------------------

const encryptJson = (key: Buffer, data: unknown): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
};

const decryptJson = (key: Buffer, blob: Buffer): unknown => {
  if (blob.length < 28) throw new Error("Vault file too short");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const data = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
};

// ---------------------------------------------------------------------------
// 密钥管理
// ---------------------------------------------------------------------------

const getMasterKey = async (): Promise<Buffer> => {
  try {
    const wrapped = await fs.readFile(KEY_FILE);
    const key = Buffer.from(safeStorage.decryptString(wrapped), "base64");
    if (key.length === 32) return key;
  } catch {
    // 密钥文件缺失或无法解密（换机/重装系统）→ 重建新密钥。
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "System encryption is unavailable (safeStorage); refusing to persist passwords in plaintext. Enable the OS keyring and retry.",
    );
  }
  await fs.mkdir(VAULT_DIR, { recursive: true });
  const key = randomBytes(32);
  await fs.writeFile(KEY_FILE, safeStorage.encryptString(key.toString("base64")), { mode: 0o600 });
  return key;
};

// ---------------------------------------------------------------------------
// Vault 加载 / 持久化
// ---------------------------------------------------------------------------

const loadVault = async (): Promise<StoredPasswordRecord[]> => {
  if (vaultPromise) return vaultPromise;
  vaultPromise = (async () => {
    const key = await getMasterKey();
    try {
      const blob = await fs.readFile(VAULT_FILE);
      const parsed = decryptJson(key, blob) as Partial<VaultFile> | null;
      if (parsed && parsed.version === VAULT_VERSION && Array.isArray(parsed.records)) {
        return parsed.records as StoredPasswordRecord[];
      }
    } catch {
      // 损坏或密钥不匹配：返回空库，但保留原文件以便排查，不覆盖破坏。
    }
    return [];
  })();
  return vaultPromise;
};

const persistVault = (records: StoredPasswordRecord[]): Promise<void> => {
  const task = writeChain.then(async () => {
    const key = await getMasterKey();
    const blob = encryptJson(key, { version: VAULT_VERSION, records });
    const tmp = `${VAULT_FILE}.tmp`;
    await fs.writeFile(tmp, blob, { mode: 0o600 });
    await fs.rename(tmp, VAULT_FILE);
  });
  // 单次失败不阻塞后续写入，错误仍通过 task 抛给调用方。
  writeChain = task.catch(() => {});
  return task;
};

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export const isValidPasswordOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
};

/** 列出全部记录（不含明文密码）。 */
export const listPasswordRecords = async (): Promise<PasswordRecordSummary[]> => {
  const records = await loadVault();
  return records
    .map(({ password: _password, ...rest }) => rest)
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
};

/** 按 id 取单条明文（密码管理 UI 查看/复制用）。 */
export const getPasswordRecord = async (
  id: string,
): Promise<{ username: string; password: string } | null> => {
  const records = await loadVault();
  const record = records.find((item) => item.id === id);
  return record ? { username: record.username, password: record.password } : null;
};

/** 保存（同 origin + username 则更新密码）。 */
export const savePasswordRecord = async (
  input: PasswordSaveInput,
): Promise<{ id: string; updated: boolean }> => {
  const origin = input.origin.trim();
  const username = input.username.trim();
  const password = input.password;
  if (!isValidPasswordOrigin(origin)) throw new Error("Invalid password origin");
  if (!password) throw new Error("Password must not be empty");
  const records = await loadVault();
  const now = Date.now();
  const existing = records.find((item) => item.origin === origin && item.username === username);
  if (existing) {
    existing.password = password;
    existing.updatedAt = now;
    await persistVault(records);
    return { id: existing.id, updated: true };
  }
  const record: StoredPasswordRecord = {
    id: randomUUID(),
    origin,
    username,
    password,
    createdAt: now,
    updatedAt: now,
  };
  records.push(record);
  await persistVault(records);
  return { id: record.id, updated: false };
};

/** 删除一条记录。 */
export const deletePasswordRecord = async (id: string): Promise<boolean> => {
  const records = await loadVault();
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) return false;
  records.splice(index, 1);
  await persistVault(records);
  return true;
};

/** 批量删除记录（一次加载、一次持久化），返回实际删除数量。 */
export const deletePasswordRecords = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  const records = await loadVault();
  const kept = records.filter((item) => !idSet.has(item.id));
  const removed = records.length - kept.length;
  if (removed === 0) return 0;
  await persistVault(kept);
  return removed;
};

/** 按 origin 查找用于自动填充的记录（取最近更新的第一条）。 */
export const findPasswordForOrigin = async (
  origin: string,
): Promise<{ username: string; password: string } | null> => {
  if (!isValidPasswordOrigin(origin)) return null;
  const records = await loadVault();
  const matches = records
    .filter((item) => item.origin === origin)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const record = matches[0];
  return record ? { username: record.username, password: record.password } : null;
};
