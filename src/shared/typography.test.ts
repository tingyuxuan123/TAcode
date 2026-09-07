import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTypography, DEFAULT_TYPOGRAPHY, FONT_STACKS, normalizeFontName,
  parseTypography, readStoredTypography, resolveFontFamily, TYPOGRAPHY_STORAGE_KEY,
} from "./typography";

afterEach(() => vi.unstubAllGlobals());

describe("parseTypography", () => {
  it.each([null, undefined, "bad", [], 12])("uses defaults for invalid config %j", (value) => {
    expect(parseTypography(value)).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("preserves valid settings and fills missing fields", () => {
    expect(parseTypography({ uiFont: "system", codeFont: "menlo", chatFontSize: 18 })).toEqual({
      ...DEFAULT_TYPOGRAPHY, uiFont: "system", codeFont: "menlo", chatFontSize: 18,
    });
  });

  it("clamps and rounds each independent size", () => {
    expect(parseTypography({ uiFontSize: 99, chatFontSize: 11, codeFontSize: 15.6 })).toMatchObject({
      uiFontSize: 18, chatFontSize: 12, codeFontSize: 16,
    });
    expect(parseTypography({ uiFontSize: 1, chatFontSize: 99, codeFontSize: 1 })).toMatchObject({
      uiFontSize: 12, chatFontSize: 24, codeFontSize: 10,
    });
    expect(parseTypography({ codeFontSize: 99 }).codeFontSize).toBe(22);
  });

  it("rejects unknown fonts and non-finite or non-numeric sizes", () => {
    expect(parseTypography({ uiFont: "url(x)", codeFont: "serif", uiFontSize: NaN, chatFontSize: Infinity, codeFontSize: "20" })).toEqual(DEFAULT_TYPOGRAPHY);
  });
});

describe("font families", () => {
  it("accepts a single family name and rejects CSS syntax", () => {
    expect(normalizeFontName("  JetBrains Mono  ")).toBe("JetBrains Mono");
    expect(normalizeFontName("a, serif")).toBe("");
    expect(normalizeFontName('a"; color:red')).toBe("");
    expect(normalizeFontName("a".repeat(101))).toBe("");
  });

  it("keeps default stacks and supports system and serif presets", () => {
    expect(resolveFontFamily(DEFAULT_TYPOGRAPHY, "ui")).toBe(FONT_STACKS.defaultUi);
    expect(resolveFontFamily(DEFAULT_TYPOGRAPHY, "code")).toBe(FONT_STACKS.defaultCode);
    expect(resolveFontFamily({ ...DEFAULT_TYPOGRAPHY, uiFont: "system" }, "ui")).toBe(FONT_STACKS.system);
    expect(resolveFontFamily({ ...DEFAULT_TYPOGRAPHY, uiFont: "serif" }, "ui")).toBe(FONT_STACKS.serif);
  });

  it("appends the default fallback only for available custom fonts", () => {
    const settings = { ...DEFAULT_TYPOGRAPHY, uiFont: "custom" as const, customUiFont: "Example Font" };
    expect(resolveFontFamily(settings, "ui", () => undefined)).toBe(`"Example Font", ${FONT_STACKS.defaultUi}`);
    expect(resolveFontFamily(settings, "ui", () => "missing")).toBe(FONT_STACKS.defaultUi);
  });

  it("falls back for missing presets and proportional code fonts", () => {
    expect(resolveFontFamily({ ...DEFAULT_TYPOGRAPHY, codeFont: "menlo" }, "code", () => "missing")).toBe(FONT_STACKS.defaultCode);
    expect(resolveFontFamily({ ...DEFAULT_TYPOGRAPHY, codeFont: "custom", customCodeFont: "Arial" }, "code", () => "proportional")).toBe(FONT_STACKS.defaultCode);
  });
});

describe("typography storage and application", () => {
  it("loads and validates saved preferences", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ chatFontSize: 99 }) });
    expect(readStoredTypography().chatFontSize).toBe(24);
  });

  it("recovers from malformed or inaccessible storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => "{" });
    expect(readStoredTypography()).toEqual(DEFAULT_TYPOGRAPHY);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
    expect(readStoredTypography()).toEqual(DEFAULT_TYPOGRAPHY);
  });

  it("sets independent scales without touching theme and restores defaults", () => {
    const setProperty = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("document", { documentElement: { style: { setProperty }, dataset: { theme: "dark" } } });
    vi.stubGlobal("localStorage", { setItem });
    const settings = applyTypography({ ...DEFAULT_TYPOGRAPHY, uiFontSize: 18, chatFontSize: 21, codeFontSize: 18 });
    expect(setProperty).toHaveBeenCalledWith("--ui-font-scale", String(18 / 14));
    expect(setProperty).toHaveBeenCalledWith("--chat-font-scale", "1.5");
    expect(setProperty).toHaveBeenCalledWith("--code-font-scale", "1.5");
    expect(setItem).toHaveBeenCalledWith(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(settings));
    applyTypography(DEFAULT_TYPOGRAPHY);
    expect(setProperty).toHaveBeenCalledWith("--chat-font-scale", "1");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("still applies styles when persistence is unavailable", () => {
    const setProperty = vi.fn();
    vi.stubGlobal("document", { documentElement: { style: { setProperty } } });
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("denied"); } });
    expect(() => applyTypography(DEFAULT_TYPOGRAPHY)).not.toThrow();
    expect(setProperty).toHaveBeenCalledWith("--sans", FONT_STACKS.defaultUi);
  });
});
