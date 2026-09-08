import type { BrowserParams } from "../../shared/browser-tools";

/** Serialized into the guest by CDP. Keep self-contained and pass all input as data. */
export function pageOperation(this: Element | undefined, args: BrowserParams): unknown {
  const find = (selector: string): Element => {
    if (selector.includes(">>>")) {
      const parts = selector.split(">>>").map((part) => part.trim());
      let root: Document | ShadowRoot = document;
      let target: Element | undefined;
      for (let index = 0; index < parts.length; index++) {
        const matches: NodeListOf<Element> = root.querySelectorAll(parts[index]);
        if (matches.length !== 1) throw new Error("Shadow DOM 选择器必须在每层唯一匹配");
        target = matches[0];
        if (index < parts.length - 1) {
          if (!target!.shadowRoot) throw new Error("目标没有开放 Shadow DOM");
          root = target!.shadowRoot!;
        }
      }
      return target!;
    }
    const matches: Element[] = [];
    const visit = (root: Document | ShadowRoot) => {
      matches.push(...root.querySelectorAll(selector));
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
    };
    visit(document);
    if (matches.length !== 1) throw new Error(matches.length ? "选择器匹配多个元素，请缩小范围" : "未找到元素，请重新观察页面");
    return matches[0];
  };
  const visible = (element: Element) => {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const action = args.action as string;
  if (action === "resolve") return find(args.selector as string);
  if (action === "ready") return document.readyState !== "loading";
  if (action === "wait") {
    if (args.kind === "url") return location.href.includes(args.value as string);
    if (args.kind === "text") return (document.body?.innerText ?? "").includes(args.value as string);
    try { return visible(find(args.value as string)); } catch (error) {
      if (error instanceof DOMException && error.name === "SyntaxError") throw error;
      return false;
    }
  }
  if (action === "extract") {
    const root = args.selector ? find(args.selector as string) : document.body;
    if (!root) return { text: "", totalChars: 0, truncated: false };
    const text = (root as HTMLElement).innerText ?? root.textContent ?? "";
    const offset = (args.offset as number | undefined) ?? 0;
    const max = (args.maxChars as number | undefined) ?? 16000;
    return { text: text.slice(offset, offset + max), totalChars: text.length, offset, truncated: offset + max < text.length, nextOffset: offset + max < text.length ? offset + max : null };
  }
  if (action === "scroll") {
    const root = args.selector ? find(args.selector as string) : document.scrollingElement;
    if (!root) throw new Error("页面没有可滚动区域");
    if (args.position) root.scrollTo({ top: args.position === "top" ? 0 : root.scrollHeight, behavior: "instant" });
    else root.scrollBy({ top: args.deltaY as number, behavior: "instant" });
    return { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
  }
  const element = this;
  if (!element?.isConnected) throw new Error("元素已被替换或移除，请重新观察获取 ref");
  if (action === "inspect") {
    return { tag: element.tagName.toLowerCase(), visible: visible(element), text: (element.textContent ?? "").slice(0, 2000), disabled: element.matches(":disabled") };
  }
  if (!visible(element)) throw new Error("元素不可见，请展开对应区域或重新观察");
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") throw new Error("元素已禁用");
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (action === "point") {
    const box = element.getBoundingClientRect();
    const x = Math.max(0, box.left) + (Math.min(element.ownerDocument.defaultView!.innerWidth, box.right) - Math.max(0, box.left)) / 2;
    const y = Math.max(0, box.top) + (Math.min(element.ownerDocument.defaultView!.innerHeight, box.bottom) - Math.max(0, box.top)) / 2;
    const root = element.getRootNode() as Document | ShadowRoot;
    const hit = root.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error("目标被其他元素遮挡，请关闭遮罩或重新观察");
    let globalX = x;
    let globalY = y;
    let frame: Window = element.ownerDocument.defaultView!;
    while (frame !== frame.top) {
      const host = frame.frameElement;
      if (!host) throw new Error("此跨域 iframe 无法安全换算点击位置，请操作主页面或打开目标页面标签");
      const bounds = host.getBoundingClientRect();
      globalX += bounds.left + host.clientLeft;
      globalY += bounds.top + host.clientTop;
      frame = frame.parent;
    }
    return { x: globalX, y: globalY };
  }
  const view = element.ownerDocument.defaultView!;
  (element as HTMLElement).focus();
  if (action === "focus") return { focused: true };
  if (action === "fill") {
    const text = args.text as string;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const input = element as HTMLInputElement;
      if (input.readOnly || ["file", "checkbox", "radio", "button", "submit", "reset", "hidden"].includes(input.type)) throw new Error("该字段不能用 fill 填写");
      const prototype = element.tagName === "INPUT" ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, text);
      element.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new view.Event("change", { bubbles: true }));
      return { filled: true, characters: text.length, valueMatches: input.value === text };
    }
    if ((element as HTMLElement).isContentEditable) {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = view.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { insertText: true };
    }
    throw new Error("目标不是可编辑字段，请重新查找 textbox");
  }
  if (action === "select") {
    if (element.tagName !== "SELECT") throw new Error("目标不是原生 select；自定义下拉框请观察后点击");
    const select = element as HTMLSelectElement;
    const option = [...select.options].find((item) => args.value !== undefined ? item.value === args.value : item.label === args.label);
    if (!option || option.disabled || option.parentElement?.matches("optgroup:disabled")) throw new Error("没有匹配的可用选项");
    Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
    select.dispatchEvent(new view.Event("input", { bubbles: true }));
    select.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { selected: true, value: select.value, label: option.label };
  }
  throw new Error("不支持的页面操作");
}
