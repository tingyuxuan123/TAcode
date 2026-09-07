import { describe, expect, it, vi } from "vitest";
import { modelTestRequest, testModelConnection } from "./provider-connection";
import type { ProviderConnection } from "./types";

const input: ProviderConnection & { modelId: string } = { baseUrl: "https://gateway.test/v1", apiStyle: "chat_completions", modelId: "model-a" };
describe("model connection testing", () => {
  it.each([
    ["chat_completions", "/v1/chat/completions", "Authorization", "Bearer secret"],
    ["responses", "/v1/responses", "Authorization", "Bearer secret"],
    ["anthropic_messages", "/v1/messages", "x-api-key", "secret"],
    ["google_generative_ai", "/v1/models/model-a:generateContent", "x-goog-api-key", "secret"],
  ] as const)("tests the actual %s model endpoint", (apiStyle, path, header, value) => {
    const request = modelTestRequest({ ...input, apiStyle }, "secret");
    expect(request.url).toBe(`https://gateway.test${path}`);
    expect(request.headers[header]).toBe(value);
    expect(JSON.stringify(request.body)).toContain("Reply OK");
  });
  it("does not mistake a successful website page for an API connection", async () => {
    const fetcher = vi.fn(async () => new Response("<html>OK</html>", { status: 200 }));
    expect(await testModelConnection(input, "secret", fetcher)).toMatchObject({ ok: false });
  });
  it("reports auth failure and always bounds the request", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await testModelConnection(input, "secret", fetcher)).toMatchObject({ ok: false, message: expect.stringContaining("401") });
    expect(fetcher.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) })]);
  });
  it("redacts the key in network errors", async () => {
    const fetcher = vi.fn(async () => { throw new Error("failure: secret"); });
    const result = await testModelConnection(input, "secret", fetcher);
    expect(result.message).not.toContain("secret");
  });
  it("validates the configured response shape", async () => {
    expect(await testModelConnection(input, "", async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })))).toMatchObject({ ok: true });
  });
});
