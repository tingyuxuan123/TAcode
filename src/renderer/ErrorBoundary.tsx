import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "./i18n";
import { describeRenderError, type RenderErrorReport } from "./render-error";

/**
 * 渲染层错误边界：App 抛错时不再白屏，而是显示可操作的恢复界面。
 *
 * 恢复动作是重新加载界面（本地会话与文件都在磁盘上，重载即可继续）。
 * 技术细节默认折叠，并同时写入主进程本地诊断日志。
 */

type BoundaryProps = {
  children: ReactNode;
  /** 供测试/独立窗口复用的恢复动作；默认重新加载当前页面。 */
  onRetry?: () => void;
};

type BoundaryState = {
  report?: RenderErrorReport;
};

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {};

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { report: describeRenderError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = describeRenderError(error);
    // 诊断是尽力而为：桥接不可用时不影响恢复界面。
    void window.harness?.app
      ?.logDiagnostic?.("renderer", report.summary, `${report.detail}\n${info.componentStack ?? ""}`)
      .catch(() => undefined);
  }

  private readonly retry = (): void => {
    if (this.props.onRetry) {
      this.setState({});
      this.props.onRetry();
      return;
    }
    window.location.reload();
  };

  render(): ReactNode {
    const { report } = this.state;
    if (!report) return this.props.children;
    return <BoundaryFallback report={report} onRetry={this.retry} />;
  }
}

function BoundaryFallback({ report, onRetry }: { report: RenderErrorReport; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="error-boundary" role="alert">
      <h1 className="error-boundary-title">{t("error.boundaryTitle")}</h1>
      <p className="error-boundary-detail">{t("error.boundaryDetail")}</p>
      <button type="button" className="error-boundary-retry" onClick={onRetry}>
        {t("error.boundaryRetry")}
      </button>
      <details className="error-boundary-trace">
        <summary>{t("error.boundaryDetails")}</summary>
        <pre>{report.summary}</pre>
        <pre>{report.detail}</pre>
      </details>
    </div>
  );
}
