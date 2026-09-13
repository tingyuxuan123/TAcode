import { AlertCircle, Check, CircleHelp } from "lucide-react";
import type { AgentSessionActivity } from "../shared/types";
import { friendlyAgentError } from "./conversation";
import { useI18n } from "./i18n";

export function SessionActivityIndicator({ activity }: { activity?: AgentSessionActivity }) {
  const { t } = useI18n();
  const status = activity?.pendingRequests.length ? "waiting"
    : activity?.status === "failed" ? "failed"
      : activity?.status === "completed" && activity.unread ? "completed" : undefined;
  if (!status) return null;
  const label = t(status === "waiting" ? "nav.sessionWaiting" : status === "failed" ? "nav.sessionFailed" : "nav.sessionUnread");
  const StatusIcon = status === "waiting" ? CircleHelp : status === "failed" ? AlertCircle : Check;
  return <span className={`session-activity-badge is-${status}`} data-session-state={status} title={label} aria-label={label}>
    <StatusIcon size={13} strokeWidth={1.8} aria-hidden="true" />
  </span>;
}

export function SessionActivityError({ activity }: { activity?: AgentSessionActivity }) {
  const { t } = useI18n();
  if (activity?.status !== "failed" || !activity.error) return null;
  return <section className="session-activity-error" role="alert">
    <strong><AlertCircle size={15} aria-hidden="true" />{t("chat.sessionFailed")}</strong>
    <p>{friendlyAgentError(activity.error) || activity.error}</p>
    <details><summary>{t("chat.errorDetails")}</summary><pre>{activity.error}</pre></details>
  </section>;
}
