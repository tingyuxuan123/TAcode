export const DEFAULT_BROWSER_HOMEPAGE = "https://www.google.com";

/** 空串合法（表示空白页）；其余 trim 后返回。 */
export const normalizeBrowserHomepage = (value: unknown): string => {
  if (typeof value !== "string") return DEFAULT_BROWSER_HOMEPAGE;
  return value.trim();
};

/**
 * 地址栏输入 → 可导航 URL：
 * 已带协议直接用；像域名（含点、无空白）补 https；否则走 Google 搜索。
 */
export const normalizeUrl = (input: string, homepage: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return homepage || DEFAULT_BROWSER_HOMEPAGE;
  if (trimmed === "about:blank") return trimmed;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[^\s/?#]+\.[^\s/?#]+(?::\d+)?(?:[/?#]\S*)?$/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
};

/** 宽松比较两个 URL（忽略结尾斜杠差异）。 */
export const sameUrlLoose = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
