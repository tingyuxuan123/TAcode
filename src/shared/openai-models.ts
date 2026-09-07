function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** OpenAI-compatible base：去掉末尾 `/` 和误粘贴的 `/chat/completions`。 */
export function apiBaseUrl(base: string): string {
  return base.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
}

/** `{base}/models`；base 若是 chat completions 地址则退回到同一前缀。 */
export function modelsUrl(base: string): string {
  const root = apiBaseUrl(base).replace(/\/responses$/i, "");
  if (!root) throw new Error("先填写 API URL");
  return root.endsWith("/models") ? root : `${root}/models`;
}

/** Build a model-list request using the service's declared wire format. */
export function modelListRequest(
  baseUrl: string,
  apiKey: string,
  apiStyle?: string,
): { url: string; headers: Record<string, string> } {
  if (apiStyle === "google_generative_ai") {
    return { url: `${modelsUrl(baseUrl)}?pageSize=1000`, headers: {
      Accept: "application/json", ...(apiKey.trim() ? { "x-goog-api-key": apiKey.trim() } : {}),
    } };
  }
  if (apiStyle === "anthropic_messages") {
    // Anthropic Messages bases conventionally omit /v1. Gateways commonly
    // follow that convention too, so add it once instead of asking users to.
    const root = apiBaseUrl(baseUrl)
      .replace(/\/(?:v1\/)?messages$/i, "")
      .replace(/\/models$/i, "");
    if (!root) throw new Error("先填写 API URL");
    const versioned = /\/v1$/i.test(root) ? root : `${root}/v1`;
    return {
      url: `${versioned}/models?limit=1000`,
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey.trim(),
        "anthropic-version": "2023-06-01",
      },
    };
  }

  return {
    url: modelsUrl(baseUrl),
    headers: {
      Accept: "application/json",
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
  };
}

export function parseOpenAiModels(payload: unknown): string[] {
  const rows = isRecord(payload) && Array.isArray(payload.data)
    ? payload.data
    : isRecord(payload) && Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const ids = rows.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item)) {
      const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
      if (id.trim()) return [id.trim().replace(/^models\//, "")];
    }
    return [];
  });
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
  apiStyle?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const { url, headers } = modelListRequest(baseUrl, apiKey, apiStyle);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("API URL 无效");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("只支持 http(s) 地址");
  }
  let response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  // Official Anthropic uses x-api-key. Some Messages-compatible gateways
  // instead reuse their OpenAI-compatible Bearer authentication for /models.
  // Retry only when authentication was rejected, keeping the standard path
  // first and avoiding a second request for normal endpoint failures.
  if (
    apiStyle === "anthropic_messages" &&
    (response.status === 401 || response.status === 403)
  ) {
    const { "x-api-key": _apiKey, ...fallbackHeaders } = headers;
    response = await fetchImpl(url, {
      method: "GET",
      headers: { ...fallbackHeaders, Authorization: `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = isRecord(payload)
      ? (isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : typeof payload.message === "string" ? payload.message : "")
      : "";
    throw new Error((detail || `获取模型失败（${response.status}）`).split(apiKey || "\u0000").join("[REDACTED]"));
  }
  if (!Array.isArray(payload) && !(isRecord(payload) && (Array.isArray(payload.data) || Array.isArray(payload.models)))) {
    throw new Error("模型列表响应格式无效，请检查 API URL");
  }
  return parseOpenAiModels(payload);
}

/** Backward-compatible OpenAI-compatible model discovery entry point. */
export async function listOpenAiModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return listModels(baseUrl, apiKey, "chat_completions", fetchImpl);
}
