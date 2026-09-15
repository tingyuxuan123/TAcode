import { ProjectFilePanel } from "../workbench/project-file-panel";
import { fileScope } from "../workbench/file-view-state";
import { useI18n } from "../i18n";
import type { SourceLocation } from "../workbench/types";

export function FilePanel({ path, workspace, scope, active = true, location, reveal, onOpen = () => {} }: {
  path: string; workspace?: string; scope?: string; active?: boolean; location?: SourceLocation; reveal?: number;
  onOpen?(path: string, options?: { preview?: boolean; literal?: boolean }): void;
}) {
  const { t } = useI18n();
  return workspace ? <ProjectFilePanel root={workspace} scope={scope ?? fileScope(workspace)} path={path} active={active} location={location} reveal={reveal} onOpen={onOpen} />
    : <p className="panel-empty">{t("inspect.workspace")}</p>;
}
