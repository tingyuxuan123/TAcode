import { expect, it } from "vitest";
import { previewChanged } from "./file-preview";
import { initialPanelState, panelReducer } from "./browser/panel-state";

it("refreshes only the relevant project/file or ancestor; HTML also follows relative resource changes", () => {
  expect(previewChanged("src/a.ts", "/a", "/b", ["src/a.ts"])).toBe(false);
  expect(previewChanged("src/a.ts", "/a", "/a", ["src/b.ts"])).toBe(false);
  expect(previewChanged("src/a.ts", "/a", "/a", ["src"])).toBe(true);
  expect(previewChanged("C:\\a\\src\\a.ts", "C:\\a", "C:\\a", ["src\\a.ts"])).toBe(true);
  expect(previewChanged("index.html", "/a", "/a", ["style.css"])).toBe(true);
});

it("keeps same-named file tabs bound to their original project and reuses them only within that project", () => {
  let state = panelReducer(initialPanelState, { type: "open-file", path: "src/a.ts", workspace: "/a" });
  state = panelReducer(state, { type: "open-file", path: "src/a.ts", workspace: "/b" });
  state = panelReducer(state, { type: "open-file", path: "src/a.ts", workspace: "/a" });
  const files = state.tabs.filter((tab) => tab.type === "file");
  expect(files.map((tab) => tab.workspace)).toEqual(["/a", "/b"]);
  expect(state.active).toBe(files[0].id);
});
