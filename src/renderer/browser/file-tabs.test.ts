import { describe, expect, it } from "vitest";
import { filePanelId, initialPanelState, panelReducer, visiblePanelTabs, type FilePanelTab, type PanelState } from "./panel-state";
import { fileScope } from "../workbench/file-view-state";
const enter = (state: PanelState, root: string, session: string, restored: FilePanelTab[] = [], activePath?: string) => panelReducer(panelReducer(state, { type: "session-changed", sourceSession: session }), { type: "file-scope-changed", scope: fileScope(root, session), restored, activePath });
const open = (state: PanelState, path: string, preview = true, root = "/a") => panelReducer(state, { type: "open-file", path, workspace: root, preview });
const files = (state: PanelState) => visiblePanelTabs(state).filter((tab): tab is FilePanelTab => tab.type === "file");
describe("scoped file tabs", () => {
  it("replaces only the preview, pins on double-open, and reuses existing fixed tabs", () => {
    let state = enter(initialPanelState, "/a", "s1"); state = open(state, "first.txt"); state = open(state, "second.txt");
    expect(files(state).map((tab) => tab.path)).toEqual(["second.txt"]);
    state = panelReducer(state, { type: "pin-file", id: state.active }); state = open(state, "third.txt"); state = open(state, "second.txt");
    expect(files(state)).toHaveLength(2); expect(files(state).find((tab) => tab.path === "second.txt")?.preview).toBe(false);
    state = open(state, "third.txt", false); state = open(state, "fourth.txt"); expect(files(state)).toHaveLength(3);
  });
  it("keeps projects and sessions separate and restores a remembered file without duplicate tabs", () => {
    let state = open(enter(initialPanelState, "/a", "s1"), "same.txt", false); const a1 = state.active;
    state = open(enter(state, "/b", "s1"), "same.txt", false, "/b"); const b1 = state.active; expect(b1).not.toBe(a1); expect(files(state)[0]?.workspace).toBe("/b");
    state = open(enter(state, "/a", "s2"), "same.txt", false); expect(state.active).not.toBe(a1);
    state = enter(state, "/a", "s1", [], "same.txt"); expect(state.active).toBe(a1); expect(files(state)).toHaveLength(1);
    expect(panelReducer(state, { type: "select", id: b1 })).toBe(state);
  });
  it("reorders in both directions and closes other files only in the current scope", () => {
    let state = open(enter(initialPanelState, "/b", "s1"), "same.txt", false, "/b"); const hidden = state.active;
    state = enter(state, "/a", "s1"); state = panelReducer(state, { type: "open-terminal" }); state = panelReducer(state, { type: "open-skills" });
    for (const path of ["a", "b", "c"]) state = open(state, path, false);
    const [a, b, c] = files(state); state = panelReducer(state, { type: "reorder", id: c!.id, before: a!.id }); expect(files(state).map((tab) => tab.path)).toEqual(["c", "a", "b"]);
    state = panelReducer(state, { type: "reorder", id: c!.id, before: b!.id, after: true }); expect(files(state).map((tab) => tab.path)).toEqual(["a", "b", "c"]);
    expect(panelReducer(state, { type: "reorder", id: hidden, before: a!.id })).toBe(state);
    state = panelReducer(state, { type: "close-other-files", id: b!.id }); expect(files(state).map((tab) => tab.path)).toEqual(["b"]);
    expect(state.tabs.map((tab) => tab.id)).toContain(hidden); expect(state.tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining(["review", "terminal", "skills"]));
  });
  it("restores stored order/preview and advances location tokens even for repeated identical links", () => {
    const scope = fileScope("/a", "s1"); const restored: FilePanelTab[] = ["b", "a"].map((path) => ({ type: "file", id: filePanelId(path, "/a", scope), path, workspace: "/a", scope, preview: path === "a" }));
    let state = enter(initialPanelState, "/a", "s1", restored, "a"); expect(files(state).map((tab) => tab.path)).toEqual(["b", "a"]);
    for (let n = 0; n < 2; n++) state = panelReducer(state, { type: "open-file", path: "a", workspace: "/a", preview: true, location: { line: 12 } });
    expect(files(state)[1]).toMatchObject({ reveal: 2, location: { line: 12 } }); expect(state.tabs).toHaveLength(3);
  });
});
