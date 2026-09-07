import { describe, expect, it } from "vitest";
import { apiBaseUrl, listModels, listOpenAiModels, modelListRequest, modelsUrl, parseOpenAiModels } from "./openai-models";

describe("modelsUrl", () => {
  it("appends /models to an OpenAI-compatible base", () => {
    expect(modelsUrl("https://www.codex5.net/v1")).toBe("https://www.codex5.net/v1/models");
    expect(modelsUrl("https://www.codex5.net/v1/")).toBe("https://www.codex5.net/v1/models");
  });

  it("does not double /models", () => {
    expect(modelsUrl("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("strips chat/completions so vision endpoints still hit /models", () => {
    expect(modelsUrl("https://open.bigmodel.cn/api/paas/v4/chat/completions"))
      .toBe("https://open.bigmodel.cn/api/paas/v4/models");
  });
});

describe("apiBaseUrl", () => {
  it("strips pasted /chat/completions for OpenAI-compatible bases", () => {
    expect(apiBaseUrl("http://192.168.0.229:8317/v1/chat/completions"))
      .toBe("http://192.168.0.229:8317/v1");
  });
});

describe("modelListRequest", () => {
  it("adds /v1 once for an Anthropic Messages endpoint", () => {
    expect(modelListRequest("https://hub.oaifree.com", "sk-test", "anthropic_messages"))
      .toEqual({
        url: "https://hub.oaifree.com/v1/models?limit=1000",
        headers: {
          Accept: "application/json",
          "x-api-key": "sk-test",
          "anthropic-version": "2023-06-01",
        },
      });
    expect(modelListRequest("https://hub.oaifree.com/v1/", "sk-test", "anthropic_messages").url)
      .toBe("https://hub.oaifree.com/v1/models?limit=1000");
    expect(modelListRequest("https://api.anthropic.com/v1/messages", "sk-test", "anthropic_messages").url)
      .toBe("https://api.anthropic.com/v1/models?limit=1000");
  });
});

describe("parseOpenAiModels", () => {
  it("reads OpenAI { data: [{ id }] }", () => {
    expect(parseOpenAiModels({
      object: "list",
      data: [{ id: "gpt-5.5" }, { id: "deepseek-v4-flash" }, { id: "gpt-5.5" }],
    })).toEqual(["deepseek-v4-flash", "gpt-5.5"]);
  });

  it("accepts string arrays and { models }", () => {
    expect(parseOpenAiModels(["b", "a"])).toEqual(["a", "b"]);
    expect(parseOpenAiModels({ models: [{ id: "glm-4v-flash" }] })).toEqual(["glm-4v-flash"]);
    expect(parseOpenAiModels({ models: [{ name: "models/gemini-2.5-pro" }] })).toEqual(["gemini-2.5-pro"]);
  });
});

describe("listOpenAiModels", () => {
  it("GETs /models with the bearer key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), { status: 200 });
    };
    await expect(listOpenAiModels("https://api.example.com/v1", "sk-test", fetchImpl))
      .resolves.toEqual(["gpt-5.5"]);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/models");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("surfaces API error text", async () => {
    const fetchImpl: typeof fetch = async () => new Response(
      JSON.stringify({ error: { message: "Incorrect API key" } }),
      { status: 401 },
    );
    await expect(listOpenAiModels("https://api.example.com/v1", "bad", fetchImpl))
      .rejects.toThrow("Incorrect API key");
  });
});

describe("listModels", () => {
  it("uses Google's key header without putting credentials in the URL", async () => {
    const request = modelListRequest("https://google.test/v1beta", "google-secret", "google_generative_ai");
    expect(request.url).toBe("https://google.test/v1beta/models?pageSize=1000");
    expect(request.headers["x-goog-api-key"]).toBe("google-secret");
    expect(request.headers.Authorization).toBeUndefined();
  });
  it("allows keyless local endpoints and rejects malformed success responses", async () => {
    await expect(listModels("http://127.0.0.1:1234/v1", "", "chat_completions", async () => new Response('{"data":[{"id":"local"}]}'))).resolves.toEqual(["local"]);
    await expect(listModels("https://example.test", "", "responses", async () => new Response('{}'))).rejects.toThrow("响应格式");
    expect(modelListRequest("https://example.test/v1/responses", "", "responses").url).toBe("https://example.test/v1/models");
  });
  it("uses Anthropic authentication and returns its model list", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), { status: 200 });
    };

    await expect(listModels("https://api.example.com", "sk-ant", "anthropic_messages", fetchImpl))
      .resolves.toEqual(["claude-sonnet-4-5"]);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/models?limit=1000");
    expect(calls[0]?.init?.headers).toEqual({
      Accept: "application/json",
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
    });
  });

  it("retries Messages-compatible gateways with bearer authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }] }), { status: 200 });
    };

    await expect(listModels("https://hub.oaifree.com", "sk-proxy", "anthropic_messages", fetchImpl))
      .resolves.toEqual(["glm-5.3-flash"]);
    expect(calls).toHaveLength(2);
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-proxy");
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-proxy");
    expect((calls[1]?.init?.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
  });
});
