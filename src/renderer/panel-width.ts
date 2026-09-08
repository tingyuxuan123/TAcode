const INSPECT_WIDTH_KEY = "tether.inspectWidth";
const INSPECT_MIN = 220;
const INSPECT_DEFAULT = 268;
const CHAT_MIN = 320;

function preferredWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.max(INSPECT_MIN, Math.round(width)) : INSPECT_DEFAULT;
}

/** 根据实际聊天容器分配空间；极窄窗口下两侧仍保留可见区域。 */
export function clampInspectWidth(width: number, availableWidth?: number): number {
  const preferred = preferredWidth(width);
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
