import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createCommandTools } from "./commands";
import type { Checkpoint } from "./checkpoint";
import { ManagedProcessRegistry } from "./managed-process";
import { SessionAccessController } from "./policy";

it("captures actual command writes and publishes preparation/checking phases; yielded writes stay explicit", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "tacode-command-checkpoint-"));
  const registry = new ManagedProcessRegistry();
  const checkpoints: Checkpoint[] = [];
  const tools = createCommandTools({ registry, getPermission: () => "full", access: new SessionAccessController("danger-full-access", true), sandboxFor: (mode, network) => ({ mode, network }), onAccessChanged: () => {}, onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
  const phases: unknown[] = [];
  try {
    const result = await tools[0]!.execute("write", { cmd: 'node -e "require(\'fs\').writeFileSync(\'made.txt\',\'made\')"' } as never, undefined, (update) => phases.push(update.details?.checkpointPhase), { cwd: root } as never);
    expect(result.details).toMatchObject({ running: false, exitCode: 0 });
    expect(phases.filter(Boolean)).toEqual(["before", "after"]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.before).toContainEqual(expect.objectContaining({ path: "made.txt", content: null }));
    expect(checkpoints[0]!.after).toContainEqual(expect.objectContaining({ path: "made.txt", content: "made" }));
    const background = await tools[0]!.execute("later", { cmd: 'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'later.txt\',\'later\'),150)"', yield_time_ms: 0 } as never, undefined, undefined, { cwd: root } as never);
    expect(background.details.running).toBe(true);
    expect(background.details.warnings.join("\n")).toContain("后台运行");
    await registry.interact(background.details.processId, { yieldTimeMs: 5000, terminate: false });
    expect(await fs.readFile(path.join(root, "later.txt"), "utf8")).toBe("later");
    expect(checkpoints).toHaveLength(1);
  } finally { registry.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
