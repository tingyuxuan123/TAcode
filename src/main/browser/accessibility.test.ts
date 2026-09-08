import { describe, expect, it } from "vitest";
import { BrowserRefs, type AXNode } from "./accessibility";

const node = (id: number, role = "button", name = "继续"): AXNode => ({ nodeId: String(id), role: { value: role }, name: { value: name }, backendDOMNodeId: id });

describe("browser accessibility references", () => {
  it("rejects a ref from a different tab even with identical backend IDs", () => {
    const first = new BrowserRefs();
    const second = new BrowserRefs();
    const ref = first.snapshot([node(12)]).elements[0].ref!;
    second.snapshot([node(12)]);
    expect(first.resolve(ref)).toBe(12);
    expect(() => second.resolve(ref)).toThrow("其他标签");
  });
  it("invalidates refs after both a new observation and navigation", () => {
    const refs = new BrowserRefs();
    const old = refs.snapshot([node(12)]).elements[0].ref!;
    const fresh = refs.snapshot([node(12)]).elements[0].ref!;
    expect(() => refs.resolve(old)).toThrow("过期");
    expect(refs.resolve(fresh)).toBe(12);
    refs.clear();
    expect(() => refs.resolve(fresh)).toThrow("过期");
  });
  it("preserves controls hidden behind long article text within the output budget", () => {
    const refs = new BrowserRefs();
    const tree = [...Array.from({ length: 300 }, (_, i) => node(i + 1, "StaticText", "段落")), node(500, "textbox", "搜索")];
    const result = refs.snapshot(tree, { maxElements: 20 });
    expect(result.truncated).toBe(true);
    expect(result.elements[0]).toMatchObject({ role: "textbox", name: "搜索" });
    expect(result.elements).toHaveLength(20);
  });
  it("finds beyond snapshot truncation, preserves states and never emits input values", () => {
    const refs = new BrowserRefs();
    const target = { ...node(2, "textbox", "邮箱"), value: { value: "private@example.com" }, properties: [{ name: "required", value: { value: true } }] };
    const result = refs.snapshot([node(1), target], { role: "textbox", name: "邮箱", exact: true });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({ name: "邮箱", required: true });
    expect(JSON.stringify(result)).not.toContain("private@example.com");
  });
});
