import type { ThemeRegistration } from "@pierre/diffs";

/** The reference's measured ink palette, applied to the existing Shiki grammar. */
export async function loadWorkbenchLightTheme(): Promise<ThemeRegistration> {
  const { default: base } = await import("shiki/themes/one-light.mjs");
  const colors: Record<string, string> = {
    "#A626A4": "#751ed9", "#C18401": "#751ed9", "#0184BC": "#751ed9",
    "#50A14F": "#00880a", "#E45649": "#bd5800", "#4078F2": "#bd5800", "#986801": "#0071ea",
  };
  return {
    ...base,
    name: "tacode-workbench-light",
    colors: { ...base.colors, "editor.background": "#ffffff", "editor.foreground": "#686868" },
    tokenColors: [
      ...(base.tokenColors ?? []).map((token) => ({ ...token, settings: { ...token.settings, foreground: colors[token.settings.foreground?.toUpperCase() ?? ""] ?? token.settings.foreground } })),
      { scope: ["keyword.control.import", "keyword.control.from", "keyword.control.export", "keyword.control.as", "keyword.control.flow"], settings: { foreground: "#d53638" } },
      { scope: ["variable.other", "variable.parameter", "entity.name.function"], settings: { foreground: "#bd5800" } },
      { scope: ["entity.name.type", "support.type", "constant.language"], settings: { foreground: "#751ed9" } },
    ],
  };
}

export const workbenchDiffCSS = `
:host {
  --diffs-font-family: var(--workbench-mono);
  --diffs-font-size: 13px;
  --diffs-line-height: 22px;
  --diffs-fg-number-override: var(--workbench-muted);
  --diffs-bg-context-override: var(--workbench-bg);
  --diffs-bg-context-gutter-override: var(--workbench-bg);
  --diffs-fg-number-addition-override: var(--workbench-green);
  --diffs-fg-number-deletion-override: var(--workbench-red);
  --diffs-addition-color-override: var(--workbench-green);
  --diffs-deletion-color-override: var(--workbench-red);
  --diffs-gap-block: 0px;
}
pre { --diffs-bg: var(--workbench-bg); --diffs-fg: var(--workbench-ink); }
[data-background] [data-line-type="change-addition"] { --diffs-computed-diff-line-bg: var(--workbench-added-bg); }
[data-background] [data-line-type="change-deletion"] { --diffs-computed-diff-line-bg: var(--workbench-deleted-bg); }
`;
