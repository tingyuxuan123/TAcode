import { createContext, memo, useContext } from "react";
import { FileIcon } from "@react-symbols/icons/utils";
import { useI18n } from "./i18n";
import { getFileName, stripLineCol } from "./file-path";

/**
 * 由 App 注入统一文件入口；Markdown 路径与过程区/文件树共享工作台文档。
 */
export const PreviewContext = createContext<((filePath: string) => void) | undefined>(undefined);

function useOpenPreview(): ((filePath: string) => void) | undefined {
  return useContext(PreviewContext);
}

const ICON_SIZE = 12;

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带 :12 行号后缀）。 */
  filePath: string;
}

/**
 * 文件路径芯片 — 在 markdown 里出现文件路径时，渲染为带文件图标的可点击 chip。
 * 点击通过 PreviewContext 打开工作台文件标签。
 */
export const FilePathChip = memo(function FilePathChip({ filePath }: FilePathChipProps) {
  const { t } = useI18n();
  const openPreview = useOpenPreview();

  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(filePath.trim());
  const filename = getFileName(cleanPath);

  const handleClick = () => {
    openPreview?.(filePath.trim());
  };

  return (
    <button
      type="button"
      className="file-chip"
      title={t("preview.open")}
      onClick={handleClick}
      disabled={!openPreview}
    >
      <span className="file-chip-icon" aria-hidden="true">
        <FileIcon fileName={filename} autoAssign width={ICON_SIZE} height={ICON_SIZE} />
      </span>
      <span className="file-chip-name">{filename}{lineColSuffix}</span>
    </button>
  );
});
