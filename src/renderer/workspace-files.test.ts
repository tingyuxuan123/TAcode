import { expect, it, vi } from "vitest";
import { WorkspaceFilesClient } from "./workspace-files";
import { visibleWorkspaceFiles } from "./browser/files-panel";
import { filterMentionPaths } from "./conversation";

it("shares listing and workspace change subscriptions between two consumers", async () => {
  let changed!: (root: string) => void;
  const off = vi.fn();
  const api = { list: vi.fn(async () => ["src/App.tsx"]), onChanged: vi.fn((callback: (root: string) => void) => { changed = callback; return off; }) };
  const client = new WorkspaceFilesClient(api);
  const stopA = client.subscribe("/project", () => {});
  const stopB = client.subscribe("/project", () => {});
  await vi.waitFor(() => expect(client.snapshot("/project").loading).toBe(false));
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.onChanged).toHaveBeenCalledOnce();
  changed("/other");
  expect(api.list).toHaveBeenCalledOnce();
  changed("/project");
  await vi.waitFor(() => expect(client.snapshot("/project").loading).toBe(false));
  expect(api.list).toHaveBeenCalledTimes(2);
  api.list.mockRejectedValueOnce(new Error("disk unavailable"));
  await client.refresh("/project", true);
  expect(client.snapshot("/project").error).toBe("disk unavailable");
  await client.refresh("/project", true);
  expect(client.snapshot("/project").error).toBeUndefined();
  stopA(); stopB();
  expect(off).toHaveBeenCalledOnce();
});

it("searches full paths from root or a nested folder and keeps all siblings browseable/referenceable", () => {
  const paths = ["src/", "src/renderer/", "src/renderer/App.tsx", ...Array.from({ length: 8100 }, (_, i) => `bulk/file-${i}.ts`)];
  expect(visibleWorkspaceFiles(paths, "", "App.tsx")).toEqual([{ entry: "src/renderer/App.tsx", directory: false }]);
  expect(visibleWorkspaceFiles(paths, "bulk/", "App.tsx")).toEqual([{ entry: "src/renderer/App.tsx", directory: false }]);
  expect(visibleWorkspaceFiles(paths, "bulk/", "")).toHaveLength(8100);
  expect(filterMentionPaths(paths, "file-8099")).toContain("bulk/file-8099.ts");
  expect(filterMentionPaths(paths, "file-200")).toContain("bulk/file-200.ts");
});
