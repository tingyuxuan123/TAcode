import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLogger } from "./local-logger";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tether-log-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const readLines = async (file: string): Promise<string[]> =>
  (await fsp.readFile(file, "utf8")).split("\n").filter(Boolean);

describe("LocalLogger", () => {
  it("appends one JSON line per entry", async () => {
    const logger = new LocalLogger({ dir, now: () => new Date("2026-09-09T05:00:00Z") });
    logger.info("startup", "ready", { cwd: "/tmp/work" });
    await logger.flush();
    const lines = await readLines(logger.filePath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "2026-09-09T05:00:00.000Z",
      level: "info",
      scope: "startup",
      message: "ready",
      details: '{"cwd":"/tmp/work"}',
    });
  });

  it("redacts known secrets from message and details", async () => {
    const key = "sk-1234567890abcdef";
    const logger = new LocalLogger({ dir, secrets: () => [key] });
    logger.error("worker", `exit with ${key}`, { key });
    await logger.flush();
    const line = (await readLines(logger.filePath))[0]!;
    expect(line).not.toContain(key);
    expect(line).toContain("[REDACTED]");
  });

  it("truncates oversized messages and details", async () => {
    const logger = new LocalLogger({ dir });
    logger.warn("rpc", "x".repeat(5_000), { body: "y".repeat(10_000) });
    await logger.flush();
    const entry = JSON.parse((await readLines(logger.filePath))[0]!);
    expect(entry.message.length).toBe(500);
    expect(entry.details.length).toBe(2_000);
  });

  it("rotates when the file exceeds the size cap", async () => {
    const logger = new LocalLogger({ dir, maxBytes: 1_024, maxFiles: 2 });
    for (let index = 0; index < 60; index += 1)
      logger.info("rotate", `entry ${index} ${"z".repeat(100)}`);
    await logger.flush();
    const files = await fsp.readdir(dir);
    expect(files).toContain("tether.log");
    expect(files).toContain("tether.log.1");
    expect(files).toContain("tether.log.2");
    expect(files).not.toContain("tether.log.3");
    // 轮转后当前文件必须仍然远小于累计写入量，避免无界增长。
    expect((await fsp.stat(logger.filePath)).size).toBeLessThanOrEqual(1_024);
  });

  it("never throws when the log target is unwritable", async () => {
    const blocked = path.join(dir, "blocked");
    await fsp.writeFile(blocked, "not a directory");
    const logger = new LocalLogger({ dir: blocked });
    expect(() => logger.error("startup", "boom")).not.toThrow();
    await logger.flush();
    expect(logger.recent()).toHaveLength(1);
    expect(await logger.tail()).toHaveLength(1);
  });

  it("keeps only the most recent in-memory entries", async () => {
    const logger = new LocalLogger({ dir });
    for (let index = 0; index < 250; index += 1) logger.info("recent", `entry ${index}`);
    const recent = logger.recent(500);
    expect(recent).toHaveLength(200);
    expect(recent.at(-1)).toContain("entry 249");
  });
});
