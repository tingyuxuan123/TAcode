import { FileIcon } from "@react-symbols/icons/utils";

export function WorkbenchFileSymbol({ path }: { path: string }) {
  const extension = path.split(".").pop()?.toLowerCase();
  const label = extension === "ts" ? "TS" : extension === "js" || extension === "mjs" || extension === "cjs" ? "JS" : extension === "css" ? "CSS" : undefined;
  if (label) return <span className={`workbench-file-symbol workbench-language-icon is-${label.toLowerCase()}`} aria-hidden="true">{label}</span>;
  return <span className="workbench-file-symbol" aria-hidden="true"><FileIcon fileName={path.split("/").pop() ?? path} autoAssign width={16} height={16} /></span>;
}
