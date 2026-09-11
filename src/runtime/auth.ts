/**
 * TACode Runtime 凭据读写（桌面端所需子集）。
 *
 * Pi 的登录/登出 CLI 流程由终端负责，桌面壳只需要保存与移除 API Key，
 * 因此这里不移植旧运行时的交互式登录实现。
 */

import path from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { createTacodeCredentialStore } from "./credential-store.js";
import { getTacodeHome } from "./home.js";
import {
  providerDisplayName,
  providerEnvironmentKey,
  type SupportedProviderId,
} from "./providers.js";

export type ApiKeyProviderId = Exclude<SupportedProviderId, "openai-codex">;

const DEEPSEEK_PROVIDER_ID = "deepseek" as const;

export function getTacodeAgentDir(): string {
  return getTacodeHome();
}

export function getTacodeAuthPath(): string {
  return path.join(getTacodeAgentDir(), "auth.json");
}

export async function hasStoredDeepSeekKey(authPath?: string): Promise<boolean> {
  const credential = await (await credentialStore(authPath)).read(DEEPSEEK_PROVIDER_ID);
  return isApiKeyCredential(credential) && credential.key.trim().length > 0;
}

export async function hasStoredProviderCredential(
  providerId: SupportedProviderId,
  authPath?: string,
): Promise<boolean> {
  return isStoredCredential(await (await credentialStore(authPath)).read(providerId));
}

export function hasDeepSeekEnvironmentKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function saveDeepSeekKey(key: string, authPath?: string): Promise<void> {
  await saveProviderApiKey(DEEPSEEK_PROVIDER_ID, key, authPath);
}

export async function saveProviderApiKey(
  providerId: ApiKeyProviderId,
  key: string,
  authPath?: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error(`${providerDisplayName(providerId)} API key cannot be empty`);
  await (
    await credentialStore(authPath)
  ).modify(providerId, async () => ({ type: "api_key", key: trimmed }));
}

export async function removeStoredDeepSeekKey(authPath?: string): Promise<boolean> {
  return removeStoredProviderCredential(DEEPSEEK_PROVIDER_ID, authPath);
}

export async function removeStoredProviderCredential(
  providerId: SupportedProviderId,
  authPath?: string,
): Promise<boolean> {
  const store = await credentialStore(authPath);
  if (!(await store.read(providerId))) return false;
  await store.delete(providerId);
  return true;
}

/**
 * 启动前校验模型凭据。
 *
 * Pi 在真正发请求时才会报认证错误；桌面壳希望启动阶段就给出明确提示，
 * 因此这里在 worker 起来前检查：桌面托管服务、环境变量或本地凭据三者之一存在即可。
 */
export async function ensureProviderConfigured(providerId: SupportedProviderId): Promise<void> {
  // OAuth 登录（ChatGPT plan）由 Pi 自己维护凭据。
  if (providerId === "openai-codex") return;
  if (desktopProviderConfigured()) return;
  const environmentKey = providerEnvironmentKey(providerId);
  if (environmentKey && process.env[environmentKey]?.trim()) return;
  if (await hasStoredProviderCredential(providerId)) return;
  throw new Error(`${providerDisplayName(providerId)} is not configured`);
}

function desktopProviderConfigured(): boolean {
  return Boolean(
    process.env.TACODE_DESKTOP_PROVIDER_CONFIG?.trim() ??
      process.env.TACODE_DESKTOP_PROVIDER_CONFIG?.trim(),
  );
}

async function credentialStore(authPath?: string) {
  return createTacodeCredentialStore(authPath ? { authPath, mode: "file" } : undefined);
}

function isApiKeyCredential(value: Credential | undefined): value is Credential & { type: "api_key"; key: string } {
  const record = asRecord(value);
  return record !== undefined && record.type === "api_key" && typeof record.key === "string";
}

function isStoredCredential(value: Credential | undefined): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.type === "api_key") {
    return typeof record.key === "string" && record.key.trim().length > 0;
  }
  return (
    record.type === "oauth" &&
    typeof record.access === "string" &&
    typeof record.refresh === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
