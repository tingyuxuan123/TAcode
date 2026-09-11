import { describe, expect, it } from "vitest";
import { isTightTableCell, TIGHT_CELL_MAX_LENGTH } from "./markdown-table";

describe("isTightTableCell", () => {
  it("treats short labels as tight", () => {
    expect(isTightTableCell("completed")).toBe(true);
    expect(isTightTableCell("cancelled")).toBe(true);
    expect(isTightTableCell("已核实")).toBe(true);
  });

  it("keeps short line-number suffixes tight", () => {
    expect(isTightTableCell(":609")).toBe(true);
    expect(isTightTableCell(":1178-1225")).toBe(true);
  });

  it("allows sentences to wrap", () => {
    expect(isTightTableCell("ts delegation-coordinator.ts:609 （collectReport 收口，经 settle）")).toBe(false);
    expect(isTightTableCell("delegation-coordinator.ts:609")).toBe(false);
    expect(isTightTableCell("已 核实")).toBe(false);
    expect(isTightTableCell("收集报告\n经 settle")).toBe(false);
  });

  it("ignores surrounding whitespace but respects the length limit", () => {
    expect(isTightTableCell("  已核实  ")).toBe(true);
    expect(isTightTableCell("x".repeat(TIGHT_CELL_MAX_LENGTH))).toBe(true);
    expect(isTightTableCell("x".repeat(TIGHT_CELL_MAX_LENGTH + 1))).toBe(false);
  });

  it("treats empty and whitespace-only cells as wrappable", () => {
    expect(isTightTableCell("")).toBe(false);
    expect(isTightTableCell("   ")).toBe(false);
  });
});
