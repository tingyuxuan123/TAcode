import { HighlightedFileCode } from "../codeblock";
import { FilePreviewActions, FilePreviewStatus, useFilePreview } from "../file-preview";
import { workspacePreviewUrl } from "../../shared/preview";

export function FilePanel({ path, workspace, active = true }: { path: string; workspace?: string; active?: boolean }) {
  const preview = useFilePreview(path, workspace, active);
  const { data, bodyRef, revision } = preview;
  const ready = data && !data.binary && data.status !== "missing";
  const html = /\.html?$/i.test(path) && !data?.truncated;
  return <div className="file-panel" data-preview-path={path}>
    <div className="file-panel-toolbar"><span title={workspace}>{workspace}</span><FilePreviewActions {...preview} /></div>
    <FilePreviewStatus {...preview} />
    <div className="file-panel-body" ref={bodyRef}>
      {ready && data.content && (html
        ? <iframe className="file-panel-frame" title={path} src={`${data.previewUrl ?? workspacePreviewUrl(path)}?revision=${revision}`} sandbox="allow-scripts allow-same-origin allow-forms" />
        : <pre className="file-panel-code"><HighlightedFileCode code={data.content} language={path} /></pre>)}
    </div>
  </div>;
}
