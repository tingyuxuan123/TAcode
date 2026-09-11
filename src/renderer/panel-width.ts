const INSPECT_WIDTH_KEY = "tacode.inspectWidth";
const INSPECT_MIN = 220;
const INSPECT_DEFAULT = 268;
const CHAT_MIN = 320;
const CHAT_AUTO_COLLAPSE_THRESHOLD = 420;

/** 仅向左拖大面板时让出侧栏空间；缩小或普通窗口布局变化不会改变侧栏状态。 */
export function shouldAutoCollapseSidebar(startWidth: number, requestedWidth: number, availableWidth: number): boolean {
  return requestedWidth > startWidth && availableWidth - requestedWidth < CHAT_AUTO_COLLAPSE_THRESHOLD;
}

function preferredWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.max(INSPECT_MIN, Math.round(width)) : INSPECT_DEFAULT;
}

/** 根据实际聊天容器分配空间；极窄窗口下两侧仍保留可见区域。 */
export function clampInspectWidth(width: number, availableWidth?: number): number {
  const preferred = Number.isFinite(width) ? Math.max(INSPECT_MIN, Math.round(width)) : INSPECT_DEFAULT;
  if (availableWidth === undefined || !Number.isFinite(availableWidth)) return preferred;
  const available = Math.max(0, Math.floor(availableWidth));
  const maximum = Math.max(Math.min(INSPECT_MIN, Math.floor(available / 2)), available - CHAT_MIN);
  return Math.min(maximum, preferred);
}

export function readInspectWidth(): number {
  try {
    return preferredWidth(Number(localStorage.getItem(INSPECT_WIDTH_KEY)));
  } catch {
    return INSPECT_DEFAULT;
  }
}

/** 仅保存用户拖动后的偏好；窗口临时变窄时不覆盖它。 */
export function writeInspectWidth(width: number): void {
  try {
    localStorage.setItem(INSPECT_WIDTH_KEY, String(preferredWidth(width)));
  } catch {
    // Ignore private mode / quota failures.
  }
}
