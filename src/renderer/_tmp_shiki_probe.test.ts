import { describe, it } from "vitest";
import { onHighlighterReady, highlightToTokens } from "./shiki";

describe("probe", () => {
  it("prints", async () => {
    await new Promise<void>((res) => {
      onHighlighterReady(() => res());
      setTimeout(res, 5000);
    });
    for (const code of ["", "\n", "\n\n", "  \n", "\n\n\n"]) {
      const r = highlightToTokens(code, "shell", "dark");
      console.log("CODE", JSON.stringify(code), "=>", JSON.stringify(r?.lines), "bg", r?.bgColor, "fg", r?.fgColor);
    }
  }, 20000);
});
