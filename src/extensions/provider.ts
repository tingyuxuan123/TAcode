import type { serviceRuntimeConfig } from "../shared/provider-config";

interface ProviderExtensionApi {
  registerProvider(id: string, config: ReturnType<typeof serviceRuntimeConfig> & { apiKey: string }): void;
  on(event: "session_start", handler: (_event: unknown, ctx: {
    modelRegistry: {
      getProvider(id: string): { id: string; auth: Record<string, unknown>; [key: string]: unknown } | undefined;
      registerProvider(provider: Record<string, unknown>): void;
    };
  }) => void): void;
}

/** Loaded only for desktop-managed services; config and key never enter CLI args or files. */
export default function desktopProviderExtension(pi: ProviderExtensionApi) {
  const raw = process.env.TETHER_DESKTOP_PROVIDER_CONFIG;
  if (!raw) return;
  const config = JSON.parse(raw) as ReturnType<typeof serviceRuntimeConfig>;
  const key = process.env.TETHER_DESKTOP_PROVIDER_KEY || "local-no-key";
  pi.registerProvider("openai", { ...config, apiKey: "desktop-session-key" });
  // Native auth deliberately ignores any global OpenAI credential. A literal
  // user key must also never be interpreted as a !command or $ENV expression.
  pi.on("session_start", (_event, ctx) => {
    const provider = ctx.modelRegistry.getProvider("openai");
    if (!provider) throw new Error("桌面供应商注册失败");
    ctx.modelRegistry.registerProvider({ ...provider, auth: { apiKey: {
      name: config.name,
      check: async () => ({ type: "api_key", source: "desktop service" }),
      resolve: async () => ({ auth: { apiKey: key }, source: "desktop service" }),
    } } });
  });
  // Avoid leaking the credential through unrelated shell tools spawned by the agent.
  delete process.env.TETHER_DESKTOP_PROVIDER_KEY;
  delete process.env.TETHER_DESKTOP_PROVIDER_CONFIG;
}
