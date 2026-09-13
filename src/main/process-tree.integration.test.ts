import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { terminateProcessTree } from "./process-tree";

it.skipIf(process.platform === "win32")("reaps a detached grandchild that ignores TERM while leaving a peer running", async () => {
  const peer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const grandchild = "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)";
  const parent = spawn(process.execPath, ["-e", `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.on('data', data => process.stdout.write(data)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let pid: number | undefined;
  const stop = (child: ChildProcess) => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
  try {
    const [output] = await once(parent.stdout!, "data");
    pid = Number(String(output).trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    const exited = once(parent, "exit").then(() => undefined);
    await terminateProcessTree(parent.pid!, { exited, graceMs: 1000 });
    expect(() => process.kill(peer.pid!, 0)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    stop(parent); stop(peer);
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 10_000);
