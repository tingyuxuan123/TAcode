import { useI18n } from "../i18n";
import type { WorkbenchDiffFile } from "./types";

export function DiffSummary({ file }: { file: WorkbenchDiffFile }) {
  const { t } = useI18n();
  const data = file.metadata;
  if (!data) return null;
  const states = [data.old.state, data.new.state];
  const kind = file.change === "conflict" ? "conflict" : states.includes("tooLarge") ? "tooLarge" : states.includes("binary") ? "binary"
    : states.includes("submodule") ? "submodule" : states.includes("symlink") ? "symlink"
      : file.change === "renamed" && file.oldContent === file.newContent ? "renamed" : !file.oldContent && !file.newContent ? "empty" : "mode";
  return <div className="workbench-diff-summary" data-diff-summary={kind}>
    <p>{t(`workbench.diffState.${kind}`)}</p>
    <dl>{(["old", "new"] as const).map((side) => <div key={side}>
      <dt>{t(`workbench.${side}Version`)}</dt>
      <dd>{data[side].state === "missing" ? t("workbench.missing") : <>
        <span>{data[side].size.toLocaleString()} B</span>
        <span>{t("workbench.fileMode", { mode: data[side].mode })}</span>
        {data[side].oid && <code title={data[side].oid}>{data[side].oid.slice(0, 12)}</code>}
      </>}</dd>
    </div>)}</dl>
    {data.conflictStages?.length ? <p className="workbench-conflict-stages">{t("workbench.conflictStages")}: {data.conflictStages.map((stage) => `${stage.stage}: ${stage.oid.slice(0, 12)}`).join(" · ")}</p> : null}
  </div>;
}
