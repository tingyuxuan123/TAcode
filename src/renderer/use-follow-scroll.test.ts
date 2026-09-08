import { describe, expect, it } from "vitest";
import { nextScrollTop } from "./use-follow-scroll";

describe("scroll following", () => {
  it("moves toward the current dynamic bottom without jumping", () => {
    const first = nextScrollTop(100, 1_000, 16, 600);
    const second = nextScrollTop(first, 1_200, 16, 600);

    expect(first).toBeGreaterThan(100);
    expect(first).toBeLessThan(1_000);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(1_200);
  });

  it("uses the latest target when content grows during following", () => {
    const next = nextScrollTop(780, 1_200, 16, 600);

    expect(next).toBeGreaterThan(780);
    expect(next).toBeLessThan(1_200);
  });

  it("snaps immediately when reduced motion is enabled", () => {
    expect(nextScrollTop(100, 1_000, 16, 600, true)).toBe(1_000);
  });

  it("snaps when the remaining distance is negligible", () => {
    expect(nextScrollTop(999.5, 1_000, 16, 600)).toBe(1_000);
  });
});
