import type { ProviderConnection } from "./types";
import { serviceBaseUrl, SUPPORTED_SERVICE_STYLES } from "./provider-config";

/** An explicit user-triggered, short generation validates auth + model + wire format. */
export function modelTestRequest(input: ProviderConnection & { modelId: string }, key: string) {
  if (!SUPPORTED_SERVICE_STYLES.includes(input.apiStyle)) throw new Error("不支持的接口格式");
  if (!input.modelId.trim()) throw new Error("请先添加或选择一个测试模型");
  const base = serviceBaseUrl(input.baseUrl, input.apiStyle);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const model = input.modelId.trim();
  if (input.apiStyle === "anthropic_messages") {
    delete headers.Authorization;
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    return { url: `${base}/v1/messages`, headers, body: { model, max_tokens: 16, messages: [{ role: "user", content: "Reply OK" }] } };
  }
  if (input.apiStyle === "google_generative_ai") {
    delete headers.Authorization;
    if (key) headers["x-goog-api-key"] = key;
    return { url: `${base}/models/${encodeURIComponent(model)}:generateContent`, headers,
      body: { contents: [{ role: "user", parts: [{ text: "Reply OK" }] }], generationConfig: { maxOutputTokens: 16 } } };
  }
  if (input.apiStyle === "responses") {
    return { url: `${base}/responses`, headers, body: { model, input: "Reply OK", max_output_tokens: 16, store: false } };
  }
  return { url: `${base}/chat/completions`, headers, body: { model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 16, stream: false } };
}

export async function testModelConnection(input: ProviderConnection & { modelId: string }, key: string, fetchImpl: typeof fetch = fetch) {
  try {
    const request = modelTestRequest(input, key);
    const start = Date.now();
    const response = await fetchImpl(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`模型连接失败（HTTP ${response.status}）`);
    const valid = input.apiStyle === "anthropic_messages" ? Array.isArray(payload?.content)
      : input.apiStyle === "google_generative_ai" ? Array.isArray(payload?.candidates)
      : input.apiStyle === "responses" ? Array.isArray(payload?.output)
      : Array.isArray(payload?.choices);
    if (!valid || payload?.error) throw new Error("响应不是所选格式的有效模型结果，请检查 API URL 和接口格式");
    return { ok: true, message: `模型连接成功 · ${Date.now() - start} ms` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: key ? message.split(key).join("[REDACTED]") : message };
  }
}
