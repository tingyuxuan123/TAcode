import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileService } from "./file-service";
import { editorCandidates, launchEditor } from "./file-external";
let root: string; let service: FileService; const launch = vi.fn(async () => {}); const openPath = vi.fn(async () => ""); const reveal = vi.fn();
const filename = process.platform === "win32" ? "a $(echo bad) 中文.txt" : "a $(echo bad):2 中文.txt";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-external-")); await fs.writeFile(path.join(root, filename), "text");
  await fs.writeFile(path.join(root, "code"), "#!/bin/sh\nexit 0\n"); await fs.chmod(path.join(root, "code"), 0o755);
  launch.mockClear(); openPath.mockClear(); reveal.mockClear();
  service = new FileService({ resolveProject: async (value) => { if (value !== root) throw new Error("Unopened project"); return root; },
    editorCandidates: (editor) => [path.join(root, editor === "vscode" ? "code" : "missing")], launch, openPath, reveal });
});
afterEach(async () => { service.close(); await service.idle(); await fs.rm(root, { recursive: true, force: true }); });
describe("installed external editors", () => {
  it("discovers actual executables and passes the absolute file, line and column as a single argument", async () => {
    expect(await service.editors()).toEqual(["system", "vscode"]);
    await service.open({ projectRoot: root, path: filename, editor: "vscode", line: 14, column: 8 });
    expect(launch).toHaveBeenCalledWith(path.join(root, "code"), ["--goto", `${path.join(root, filename)}:14:8`]);
    await service.open({ projectRoot: root, path: "", editor: "vscode" }); expect(launch).toHaveBeenLastCalledWith(path.join(root, "code"), [root]);
    await expect(service.open({ projectRoot: root, path: "code", editor: "cursor" })).rejects.toMatchObject({ code: "unavailable" });
  });
  it("uses explicit-project system open/reveal and returns actual paths including missing entries", async () => {
    const request = { projectRoot: root, path: "code" }; await service.open({ ...request, editor: "system" }); await service.reveal(request);
    expect(openPath).toHaveBeenCalledWith(path.join(root, "code")); expect(reveal).toHaveBeenCalledWith(path.join(root, "code"));
    expect(await service.location({ ...request, path: "missing" })).toMatchObject({ absolutePath: path.join(root, "missing") });
    openPath.mockResolvedValueOnce("No application"); await expect(service.open({ ...request, editor: "system" })).rejects.toThrow("No application");
    await expect(service.reveal({ ...request, path: "missing" })).rejects.toMatchObject({ code: "missing" });
  });
  it("rejects invalid locations, outside symlink targets, unopened projects and a cancelled owner", async () => {
    const request = { projectRoot: root, path: "code", editor: "vscode" as const };
    await expect(service.open({ ...request, line: 0 })).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(service.open({ ...request, column: 1.5 })).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(service.open({ ...request, projectRoot: os.tmpdir() })).rejects.toMatchObject({ code: "outsideProject" });
    await expect(service.open(request, () => { throw new Error("Owner changed"); })).rejects.toThrow("Owner changed"); expect(launch).not.toHaveBeenCalled();
    if (process.platform !== "win32") { await fs.symlink(os.tmpdir(), path.join(root, "outside")); await expect(service.open({ ...request, path: "outside", editor: "system" })).rejects.toMatchObject({ code: "outsideProject" }); }
  });
  it("knows macOS, Windows and Linux installation paths without executing a shell search", () => {
    expect(editorCandidates("vscode", "darwin", {}, "/user")).toContain("/user/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    expect(editorCandidates("cursor", "win32", { LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local" })).toContain("C:\\Users\\User\\AppData\\Local\\Programs\\cursor\\Cursor.exe");
    expect(editorCandidates("vscode", "linux", { PATH: "/custom/bin" })).toContain("/custom/bin/code");
  });
  it("runs a real executable with shell metacharacters preserved and reports immediate launch failures", async () => {
    if (process.platform === "win32") return;
    const output = path.join(root, "args.txt"); const script = path.join(root, "fake-editor");
    const quoted = `'${output.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quoted}\n`); await fs.chmod(script, 0o755);
    await launchEditor(script, ["--goto", "$(touch should-not-exist):3:4"]); expect((await fs.readFile(output, "utf8")).trimEnd().split("\n")).toEqual(["--goto", "$(touch should-not-exist):3:4"]);
    await fs.writeFile(script, "#!/bin/sh\nexit 3\n"); await expect(launchEditor(script, [])).rejects.toThrow("Editor launch failed (3)");
    await expect(launchEditor(path.join(root, "absent"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
