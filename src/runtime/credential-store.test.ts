import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTacodeCredentialStore, type TacodeKeyringFactory } from "./credential-store";

const roots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tacode-credentials-"));
  roots.push(root);
  return root;
}

function memoryKeyring(): { factory: TacodeKeyringFactory; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    factory: {
      create: (_service, account) => ({
        getPassword: () => entries.get(account) ?? null,
        setPassword: (password: string) => void entries.set(account, password),
        deletePassword: () => entries.delete(account),
      }),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createTacodeCredentialStore", () => {
  it("reads file credentials in file mode", async () => {
    const home = await tempHome();
    const authPath = join(home, "auth.json");
    await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "file-key" } }));

    const store = await createTacodeCredentialStore({ mode: "file", authPath });
    await expect(store.read("deepseek")).resolves.toEqual({ type: "api_key", key: "file-key" });
  });

  it("auto mode never deletes file credentials when copying to the keyring", async () => {
    const home = await tempHome();
    const authPath = join(home, "auth.json");
    const metadataPath = join(home, "credential-metadata.json");
    await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "file-key" } }));
    const { factory } = memoryKeyring();

    const store = await createTacodeCredentialStore({
      mode: "auto",
      authPath,
      metadataPath,
      keyringFactory: factory,
    });

    await expect(store.read("deepseek")).resolves.toEqual({ type: "api_key", key: "file-key" });
    // 桌面壳固定 file 模式读 auth.json；auto 模式绝不能把它清空（否则应用读到空密钥报 401）。
    await expect(readFile(authPath, "utf8")).resolves.toContain("file-key");
  });

  it("auto mode prefers an existing keyring credential", async () => {
    const home = await tempHome();
    const authPath = join(home, "auth.json");
    const { factory, entries } = memoryKeyring();
    entries.set("deepseek", JSON.stringify({ type: "api_key", key: "keyring-key" }));

    const store = await createTacodeCredentialStore({
      mode: "auto",
      authPath,
      metadataPath: join(home, "credential-metadata.json"),
      keyringFactory: factory,
    });

    await expect(store.read("deepseek")).resolves.toEqual({ type: "api_key", key: "keyring-key" });
  });
});
