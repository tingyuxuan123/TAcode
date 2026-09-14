import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider, useI18n } from "../../src/renderer/i18n";
import { GitReviewPanel } from "../../src/renderer/workbench/git-review-panel";
import type { WorkbenchColorScheme } from "../../src/renderer/workbench/types";
import "@fontsource-variable/inter";
import "./file-review.css";

const NativeWorker = window.Worker;
const workers = { active: 0, created: 0 };
const nativeAnimationFrame = window.requestAnimationFrame;
function setPageHidden(hidden: boolean) {
  if (hidden) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.requestAnimationFrame = () => 0;
  } else {
    delete (document as any).visibilityState;
    window.requestAnimationFrame = nativeAnimationFrame;
  }
  document.dispatchEvent(new Event("visibilitychange"));
}
// Count actual native workers and termination, without replacing their work.
window.Worker = class extends NativeWorker {
  private alive = true;
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.active++; workers.created++; }
  terminate() { if (this.alive) { this.alive = false; workers.active--; } super.terminate(); }
};

function Fixture() {
  const [project, setProject] = useState(new URLSearchParams(location.search).get("project") ?? "");
  const [active, setActive] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [colorScheme, setColorScheme] = useState<WorkbenchColorScheme>("light");
  const [opened, setOpened] = useState("");
  const workerState = useRef<unknown>(null);
  const onWorkerStateChange = useCallback((state: unknown) => { workerState.current = state; }, []);
  const { setLocale } = useI18n();
  useEffect(() => { (window as any).gitReviewFixture = { setProject, setActive, setHidden, setPageHidden, setColorScheme, setLocale, state: () => ({ project, active, hidden, opened, workers: { ...workers }, workerState: workerState.current }) }; });
  return <div style={{ height: "100%", display: hidden ? "none" : "block" }}>
    <GitReviewPanel projectRoot={project} active={active} colorScheme={colorScheme} onOpenFile={setOpened} onOpenTerminal={() => setOpened("terminal")} onWorkerStateChange={onWorkerStateChange} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>);
