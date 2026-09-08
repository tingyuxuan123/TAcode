import { randomUUID } from "node:crypto";

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}
const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "listbox", "option", "switch", "slider", "spinbutton", "treeitem"]);
const CONTEXT = new Set(["heading", "dialog", "alert", "status", "StaticText", "main", "navigation", "form", "search", "article", "img", "Iframe"]);

/** One registry per guest. Fresh opaque refs cannot accidentally address another tab or document. */
export class BrowserRefs {
  private nodes = new Map<string, number>();
  revision = 0;
  clear() { this.nodes.clear(); this.revision++; }
  resolve(ref: string): number {
    const backend = this.nodes.get(ref);
    if (backend === undefined) throw new Error("元素 ref 已过期或属于其他标签。请在目标 tabId 重新 browser_observe/browser_find 后使用新 ref。");
    return backend;
  }
  snapshot(nodes: AXNode[], options: { maxElements?: number; role?: string; name?: string; exact?: boolean } = {}) {
    this.clear();
    const prefix = randomUUID().slice(0, 8);
    const limit = options.maxElements ?? (options.role || options.name ? 20 : 160);
    const query = options.name?.toLocaleLowerCase();
    const candidates = nodes.filter((node) => {
      if (node.ignored) return false;
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      if (options.role || query !== undefined) {
        return (!options.role || role.toLowerCase() === options.role.toLowerCase()) &&
          (query === undefined || (options.exact ? name.toLocaleLowerCase() === query : name.toLocaleLowerCase().includes(query)));
      }
      return INTERACTIVE.has(role) || (CONTEXT.has(role) && (name || role === "Iframe"));
    });
    // Reserve most of the budget for actions; long text before a form must not hide its controls.
    const ranked = options.role || options.name ? candidates : [
      ...candidates.filter((node) => INTERACTIVE.has(node.role?.value ?? "")),
      ...candidates.filter((node) => !INTERACTIVE.has(node.role?.value ?? "")),
    ];
    const elements = ranked.slice(0, limit).map((node, index) => {
      const ref = node.backendDOMNodeId ? `${prefix}-e${index + 1}` : undefined;
      if (ref) this.nodes.set(ref, node.backendDOMNodeId!);
      const state: Record<string, unknown> = {};
      for (const prop of node.properties ?? []) {
        if (["disabled", "checked", "selected", "expanded", "required", "level"].includes(prop.name)) state[prop.name] = prop.value.value;
      }
      return { ...(ref ? { ref } : {}), role: node.role?.value ?? "", name: (node.name?.value ?? "").slice(0, 500), ...state };
    });
    return { elements, total: ranked.length, truncated: ranked.length > limit, hint: "ref 仅适用于本标签的本次观察；正文用 browser_extract，未显示的控件用 browser_find。输入值不在快照中回显。" };
  }
}
