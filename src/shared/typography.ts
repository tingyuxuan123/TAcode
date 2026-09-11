export const TYPOGRAPHY_STORAGE_KEY = "tacode.typography";
export const UI_FONTS = ["default", "system", "serif", "custom"] as const;
export const CODE_FONTS = ["default", "menlo", "monaco", "courier", "consolas", "jetbrains", "custom"] as const;
export type FontKind = "ui" | "code";
export type FontProblem = "missing" | "proportional";
export type TypographySettings = {
  uiFont: (typeof UI_FONTS)[number];
  codeFont: (typeof CODE_FONTS)[number];
  customUiFont: string;
  customCodeFont: string;
  uiFontSize: number;
  chatFontSize: number;
  codeFontSize: number;
};
export type FontSizeKey = "uiFontSize" | "chatFontSize" | "codeFontSize";
export const FONT_SIZE_LIMITS: Record<FontSizeKey, { min: number; max: number }> = {
  uiFontSize: { min: 12, max: 18 },
  chatFontSize: { min: 12, max: 24 },
  codeFontSize: { min: 10, max: 22 },
};
export const DEFAULT_TYPOGRAPHY: Readonly<TypographySettings> = Object.freeze({
  uiFont: "default", codeFont: "default", customUiFont: "", customCodeFont: "",
  uiFontSize: 14, chatFontSize: 14, codeFontSize: 12,
});
export const FONT_STACKS = {
  defaultUi: '"Inter Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  defaultCode: 'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", "Noto Serif CJK SC", SimSun, Georgia, serif',
};
export const CODE_FONT_NAMES = { menlo: "Menlo", monaco: "Monaco", courier: "Courier New", consolas: "Consolas", jetbrains: "JetBrains Mono" } as const;

export function normalizeFontName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim();
  return name.length <= 100 && !/[\x00-\x1f\x7f"'\\,;{}<>]/.test(name) ? name : "";
}

export function parseTypography(value: unknown): TypographySettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const size = (key: FontSizeKey) => {
    const n = input[key];
    const { min, max } = FONT_SIZE_LIMITS[key];
    return typeof n === "number" && Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_TYPOGRAPHY[key];
  };
  return {
    uiFont: UI_FONTS.includes(input.uiFont as TypographySettings["uiFont"]) ? input.uiFont as TypographySettings["uiFont"] : "default",
    codeFont: CODE_FONTS.includes(input.codeFont as TypographySettings["codeFont"]) ? input.codeFont as TypographySettings["codeFont"] : "default",
    customUiFont: normalizeFontName(input.customUiFont),
    customCodeFont: normalizeFontName(input.customCodeFont),
    uiFontSize: size("uiFontSize"), chatFontSize: size("chatFontSize"), codeFontSize: size("codeFontSize"),
  };
}

export function readStoredTypography(): TypographySettings {
  try {
    return parseTypography(JSON.parse(localStorage.getItem(TYPOGRAPHY_STORAGE_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_TYPOGRAPHY };
  }
}

export function selectedFontName(settings: TypographySettings, kind: FontKind): string {
  if (kind === "ui") return settings.uiFont === "custom" ? settings.customUiFont : "";
  if (settings.codeFont === "custom") return settings.customCodeFont;
  return settings.codeFont === "default" ? "" : CODE_FONT_NAMES[settings.codeFont];
}

export function fontProblem(name: string, monospace = false): FontProblem | undefined {
  if (!name || name !== normalizeFontName(name)) return "missing";
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return "missing";
  const family = JSON.stringify(name);
  // FontFaceSet.check accepts missing local families because fallback can render them.
  // Compare against multiple fallback metrics, including a CJK sample, instead.
  const samples = ["mmmmmmWWWWiiii0123456789", "\u4e2d\u6587\u5b57\u4f53\u9884\u89c8\uff0c\u3002"];
  const available = ["monospace", "serif", "sans-serif"].some((fallback) => samples.some((sample) => {
    context.font = `48px ${fallback}`;
    const baseline = context.measureText(sample).width;
    context.font = `48px ${family}, ${fallback}`;
    return Math.abs(context.measureText(sample).width - baseline) > 0.01;
  }));
  if (!available) return "missing";
  if (monospace) {
    context.font = `48px ${family}, monospace`;
    const width = context.measureText("i").width;
    if (["W", "0", " "].some((letter) => Math.abs(context.measureText(letter).width - width) > 0.01)) return "proportional";
  }
  return undefined;
}

export function resolveFontFamily(
  settings: TypographySettings,
  kind: FontKind,
  check: typeof fontProblem = fontProblem,
): string {
  const fallback = kind === "ui" ? FONT_STACKS.defaultUi : FONT_STACKS.defaultCode;
  if (kind === "ui" && settings.uiFont === "system") return FONT_STACKS.system;
  if (kind === "ui" && settings.uiFont === "serif") return FONT_STACKS.serif;
  const name = selectedFontName(settings, kind);
  return name && !check(name, kind === "code") ? `${JSON.stringify(name)}, ${fallback}` : fallback;
}

export function applyTypography(value: TypographySettings): TypographySettings {
  const settings = parseTypography(value);
  const style = document.documentElement.style;
  style.setProperty("--sans", resolveFontFamily(settings, "ui"));
  style.setProperty("--mono", resolveFontFamily(settings, "code"));
  style.setProperty("--ui-font-scale", String(settings.uiFontSize / 14));
  style.setProperty("--chat-font-scale", String(settings.chatFontSize / 14));
  style.setProperty("--code-font-scale", String(settings.codeFontSize / 12));
  try {
    localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* The current window can still use the selected typography. */
  }
  return settings;
}
