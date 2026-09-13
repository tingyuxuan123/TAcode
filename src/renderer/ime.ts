interface ImeKey {
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
}

/** Chromium 在不同平台/输入法下分别报告 isComposing 或 VK_PROCESSKEY。 */
export function isImeKey(event: ImeKey): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.which === 229 || event.key === "Process";
}

export function createImeGuard(now = () => performance.now()) {
  let active = false;
  let endedAt = -Infinity;
  return {
    start() { active = true; },
    end() { active = false; endedAt = now(); },
    active: () => active,
    // 部分 macOS 输入法先发 compositionend，再发同一次确认的 Enter。
    recent: () => now() - endedAt < 30,
    handles(event: ImeKey) { return active || isImeKey(event) || (event.key === "Enter" && now() - endedAt < 30); },
  };
}
