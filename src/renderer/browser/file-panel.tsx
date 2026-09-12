import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useI18n } from "../i18n";
import { HighlightedFileCode } from "../codeblock";
import { workspacePreviewUrl } from "../../shared/preview";

/**
 * 右侧面板的文件查看标签（对齐 ZCode 的 code viewer）：
 * 过程区的读取/写入/编辑行点击时打开，同一文件复用同一个标签。
 * 文本文件用 Shiki 高亮 + 行号渲染；HTML 走内嵌预览；二进制给提示。
 */
export function FilePanel({ path, workspace }: { path: string; workspace?: string }) {
  const { t } = useI18n();
  const [body, setBody] = useState(() => t("preview.reading"));
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const html = /\.html?$/i.test(path);
  useEffect(() => {
    let gone = false;
    setBinary(false);
    setError(null);
    setBody(t("preview.reading"));
    window.harness.workspace.read(path, workspace).then(
      (result) => {
        if (gone) return;
        setBinary(result.binary);
        setBody(result.binary ? t("preview.binary") : result.content);
      },
      (err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      gone = true;
    };
  }, [path, workspace, t]);
  if (error) {
    return (
      <div className="file-panel">
        <p className="file-panel-error"><AlertCircle size={14} aria-hidden="true" />{error}</p>
      </div>
    );
  }
  if (html && !binary) {
    return (
      <div className="file-panel">
        <iframe className="file-panel-frame" title={path} src={workspacePreviewUrl(path)} sandbox="allow-scripts allow-same-origin allow-forms" />
      </div>
    );
  }
  return (
    <div className="file-panel">
      {binary ? <p className="file-panel-error">{body}</p> : (
        <pre className="file-panel-code" key={path}>
          <HighlightedFileCode code={body} language={path} />
        </pre>
      )}
    </div>
  );
}
