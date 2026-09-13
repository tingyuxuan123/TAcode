import type { AgentEvent, ExtensionUiRequest } from "./types";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function isAgentUiDialog(event: AgentEvent): event is AgentEvent & ExtensionUiRequest {
  return event.type === "extension_ui_request"
    && typeof event.id === "string"
    && typeof event.method === "string"
    && DIALOG_METHODS.has(event.method);
}
