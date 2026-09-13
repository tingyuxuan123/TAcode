import { describe, expect, it } from "vitest";
import { createImeGuard, isImeKey } from "./ime";

describe("IME keyboard ownership", () => {
  it.each(["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"])("leaves %s to composition for both Chromium event forms", (key) => {
    expect(isImeKey({ key, isComposing: true })).toBe(true);
    expect(isImeKey({ key, isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ key, keyCode: 13 })).toBe(false);
  });

  it("tracks composition even when the keyboard event omits the platform flag", () => {
    let clock = 0;
    const ime = createImeGuard(() => clock);
    ime.start();
    expect(ime.handles({ key: "Enter" })).toBe(true);
    expect(ime.handles({ key: "Escape" })).toBe(true);
    ime.end();
    expect(ime.handles({ key: "Enter" })).toBe(true);
    clock = 31;
    expect(ime.handles({ key: "Enter" })).toBe(false);
    expect(ime.active()).toBe(false);
  });
});
