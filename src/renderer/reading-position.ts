export interface ReadingPosition {
  top: number;
  left: number;
  selection?: { start: number; end: number; text: string };
}

export function rememberPosition(root: HTMLElement): ReadingPosition {
  const position: ReadingPosition = { top: root.scrollTop, left: root.scrollLeft };
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (root.contains(range.startContainer) && root.contains(range.endContainer)) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      const text = range.toString();
      position.selection = { start, end: start + text.length, text };
    }
  }
  return position;
}

export function restorePosition(root: HTMLElement, position: ReadingPosition): void {
  if (position.selection) {
    let { start, end } = position.selection;
    const { text } = position.selection;
    const content = root.textContent ?? "";
    // 内容插入导致偏移变化时只恢复唯一匹配，不能把用户选区移到另一处相似代码。
    if (content.slice(start, end) !== text) {
      start = content.indexOf(text);
      if (start >= 0 && content.indexOf(text, start + 1) >= 0) start = -1;
      end = start + text.length;
    }
    if (start >= 0) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let began = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!began && offset + length >= start) { range.setStart(node, start - offset); began = true; }
        if (began && offset + length >= end) {
          range.setEnd(node, end - offset);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          break;
        }
        offset += length;
      }
    }
  }
  root.scrollTop = position.top;
  root.scrollLeft = position.left;
}

