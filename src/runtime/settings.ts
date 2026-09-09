/**
 * TACode Runtime 本地设置（baseUrl / maxTokens / 凭据存储模式 / 历史持久化）。
 *
 * 设置文件与 Tether 时代同构（`<home>/config.json`），因此可以直接沿用
 * 已有 `~/.tether` 数据；读写走原子替换并保持 0600 权限。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tacodeEnv } from "./env.js";
import { getTacodeHome } from "./home.js";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MAX_TOKENS = 384_000;
export const DEEPSEEK_CONTEXT_WINDOW = 512_000;

export function parseMaxTokens(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.floor(n), 2_000_000);
}

export function isOfficialDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(normalizeDeepSeekBaseUrl(baseUrl)).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

export function resolveMaxTokens(baseUrl: string, configured?: number): number {
  if (isOfficialDeepSeekBaseUrl(baseUrl)) return DEEPSEEK_MAX_TOKENS;
  return parseMaxTokens(configured) ?? DEEPSEEK_MAX_TOKENS;
}

export type CredentialStoreMode = "file" | "keyring" | "auto";
export type HistoryPersistence = "save-all" | "none";

export interface TacodeStorageSettings {
  credentialStore: CredentialStoreMode;
  historyPersistence: HistoryPersistence;
  sqliteHome?: string;
}

export function getTacodeSettingsPath(): string {
  return tacodeEnv("CONFIG_PATH") ?? path.join(getTacodeHome(), "config.json");
}

export function getStoredDeepSeekBaseUrl(settingsPath: string = getTacodeSettingsPath()): string | undefined {
  try {
    return baseUrlFromSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime settings file: ${settingsPath}`);
    }
    throw error;
  }
}

export function getStoredDeepSeekMaxTokens(
  settingsPath: string = getTacodeSettingsPath(),
): number | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || !isRecord(settings.deepseek)) return undefined;
    return parseMaxTokens(settings.deepseek.maxTokens);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime settings file: ${settingsPath}`);
    }
    throw error;
  }
}

export function getTacodeStorageSettings(
  settingsPath: string = getTacodeSettingsPath(),
): TacodeStorageSettings {
  const settings = readSettingsSync(settingsPath);
  const configuredStore = settings.cli_auth_credentials_store;
  const environmentStore = tacodeEnv("CREDENTIALS_STORE");
  const credentialStore = parseCredentialStoreMode(environmentStore ?? configuredStore ?? "auto");
  const historyPersistence = parseHistoryPersistence(
    (isRecord(settings.history) ? settings.history.persistence : undefined) ?? "save-all",
  );
  const sqliteHome = tacodeEnv("SQLITE_HOME") ?? settings.sqlite_home;
  return {
    credentialStore,
    historyPersistence,
    ...(typeof sqliteHome === "string" && sqliteHome.trim()
      ? { sqliteHome: resolveConfiguredPath(sqliteHome) }
      : {}),
  };
}

export function parseCredentialStoreMode(value: unknown): CredentialStoreMode {
  if (value === "file" || value === "keyring" || value === "auto") return value;
  throw new Error("cli_auth_credentials_store must be file, keyring, or auto");
}

export function parseHistoryPersistence(value: unknown): HistoryPersistence {
  if (value === "save-all" || value === "none") return value;
  throw new Error("history.persistence must be save-all or none");
}

export async function saveDeepSeekBaseUrl(
  baseUrl: string,
  settingsPath: string = getTacodeSettingsPath(),
): Promise<string> {
  const normalized = normalizeDeepSeekBaseUrl(baseUrl);
  const settings = await readSettings(settingsPath);
  settings.deepseek = { ...(asRecord(settings.deepseek) ?? {}), baseUrl: normalized };
  await persistSettings(settings, settingsPath);
  return normalized;
}

export async function saveDeepSeekMaxTokens(
  maxTokens: number | undefined,
  settingsPath: string = getTacodeSettingsPath(),
): Promise<void> {
  const settings = await readSettings(settingsPath);
  const next = { ...(asRecord(settings.deepseek) ?? {}) };
  const parsed = parseMaxTokens(maxTokens);
  if (parsed === undefined) delete next.maxTokens;
  else next.maxTokens = parsed;
  settings.deepseek = next;
  await persistSettings(settings, settingsPath);
}

export function normalizeDeepSeekBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("API base URL cannot be empty");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("API base URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("API base URL cannot contain credentials, query parameters, or a fragment");
  }
  return trimmed;
}

async function persistSettings(settings: Record<string, unknown>, settingsPath: string): Promise<void> {
  const directory = path.dirname(settingsPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime settings file: ${settingsPath}`);
    }
    throw error;
  }
}

function readSettingsSync(settingsPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse TACode Runtime settings file: ${settingsPath}`);
    }
    throw error;
  }
}

function resolveConfiguredPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return process.env.HOME ?? getTacodeHome();
  if (trimmed.startsWith("~/")) {
    return path.resolve(process.env.HOME ?? path.dirname(getTacodeHome()), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function baseUrlFromSettings(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.deepseek)) return undefined;
  const baseUrl = value.deepseek.baseUrl;
  return typeof baseUrl === "string" ? normalizeDeepSeekBaseUrl(baseUrl) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
