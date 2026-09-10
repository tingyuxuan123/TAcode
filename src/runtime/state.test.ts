import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { TacodeStateStore } from "./state";

const require = createRequire(import.meta.url);

describe("TacodeStateStore delegation metadata", () => {
  it("creates and updates a child session placeholder before its JSONL exists", async () => {
    const store = new TacodeStateStore(":memory:");
    try {
      const child = store.createDelegatedThread({
        id: "child-1",
        sessionPath: "/tmp/child-1.jsonl",
        cwd: "/tmp/workspace",
        title: "Explore workspace",
        provider: "deepseek",
        model: "deepseek-chat",
        parentSessionPath: "/tmp/parent.jsonl",
        sourceDelegationId: "delegation-1",
        delegationRole: "explorer",
        delegationStatus: "running",
        delegationDepth: 1,
        delegationGoal: "Inspect the workspace",
      });
      expect(child).toMatchObject({
        id: "child-1",
        parentSessionPath: "/tmp/parent.jsonl",
        sourceDelegationId: "delegation-1",
        delegationStatus: "running",
        delegationDepth: 1,
      });

      await store.refresh();
      expect(store.list({ parentSessionPath: "/tmp/parent.jsonl" })).toHaveLength(1);

      const updated = store.updateDelegation("delegation-1", {
        delegationStatus: "completed",
        preview: "Found the entry point",
      });
      expect(updated).toMatchObject({
        delegationStatus: "completed",
        preview: "Found the entry point",
      });

      await store.refresh();
      expect(store.list({ sourceDelegationId: "delegation-1" })[0]?.delegationStatus).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("migrates an existing v1 threads table before creating delegation indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "tacode-state-migration-"));
    const file = join(root, "state.sqlite");
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        session_path TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms REAL NOT NULL DEFAULT 0
      );
    `);
    legacy.close();
    const store = new TacodeStateStore(file);
    try {
      const child = store.createDelegatedThread({
        id: "child-migrated",
        sessionPath: "/tmp/child-migrated.jsonl",
        cwd: "/tmp/workspace",
        title: "Migrated child",
        parentSessionPath: "/tmp/parent.jsonl",
        sourceDelegationId: "delegation-migrated",
        delegationRole: "explorer",
        delegationStatus: "running",
        delegationDepth: 1,
        delegationGoal: "Inspect",
      });
      expect(child.sourceDelegationId).toBe("delegation-migrated");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
