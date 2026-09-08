import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_HOMEPAGE, normalizeBrowserHomepage, normalizeUrl, sameUrlLoose } from "./url";

describe("normalizeBrowserHomepage", () => {
  it("trims and falls back to the default for non-strings", () => {
    expect(normalizeBrowserHomepage("  https://a.com  ")).toBe("https://a.com");
    expect(normalizeBrowserHomepage(undefined)).toBe(DEFAULT_BROWSER_HOMEPAGE);
  });

  it("allows an empty homepage (blank page)", () => {
    expect(normalizeBrowserHomepage("   ")).toBe("");
  });
});

describe("normalizeUrl", () => {
  it("keeps existing protocols", () => {
    expect(normalizeUrl("https://a.com", "")).toBe("https://a.com");
    expect(normalizeUrl("file:///tmp/x", "")).toBe("file:///tmp/x");
    expect(normalizeUrl("http://a.com", "")).toBe("http://a.com");
  });

  it("prefixes https for domain-like input", () => {
    expect(normalizeUrl("example.com", "")).toBe("https://example.com");
  });

  it("keeps blank pages and recognizes local development servers", () => {
    expect(normalizeUrl("about:blank", "")).toBe("about:blank");
    expect(normalizeUrl("localhost:5177/demo", "")).toBe("http://localhost:5177/demo");
    expect(normalizeUrl("127.0.0.1:8080", "")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("[::1]:3000", "")).toBe("http://[::1]:3000");
    expect(normalizeUrl("site:example.com 搜索词", "")).toContain("google.com/search?q=");
  });

  it("searches for free-form text", () => {
    expect(normalizeUrl("electron webview", "")).toBe(
      "https://www.google.com/search?q=electron%20webview",
    );
  });

  it("falls back to the homepage for empty input", () => {
    expect(normalizeUrl("  ", "https://home.dev")).toBe("https://home.dev");
    expect(normalizeUrl("", "")).toBe(DEFAULT_BROWSER_HOMEPAGE);
  });
});

describe("sameUrlLoose", () => {
  it("ignores trailing slashes", () => {
    expect(sameUrlLoose("https://a.com/x/", "https://a.com/x")).toBe(true);
    expect(sameUrlLoose("https://a.com/x", "https://a.com/y")).toBe(false);
  });
});
