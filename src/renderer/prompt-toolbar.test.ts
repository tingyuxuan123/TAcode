import { describe, expect, it } from "vitest";
import { toolbarModeForWidth } from "./prompt-toolbar";

describe("输入栏分级收缩", () => {
  it("优先完整文字，然后图标，最后更多入口", () => {
    expect(toolbarModeForWidth(500, 480, 190)).toBe("full");
    expect(toolbarModeForWidth(300, 480, 190)).toBe("icons");
    expect(toolbarModeForWidth(180, 480, 190)).toBe("overflow");
  });
  it("按实际测量容纳边界，兼容文字变长及按钮数量变化", () => {
    expect(toolbarModeForWidth(480, 480.2, 190)).toBe("icons");
    expect(toolbarModeForWidth(190, 480.2, 190)).toBe("icons");
    expect(toolbarModeForWidth(189, 480.2, 190)).toBe("overflow");
    expect(toolbarModeForWidth(189, 330, 158)).toBe("icons");
    expect(toolbarModeForWidth(500, 640, 190)).toBe("icons");
  });
});
