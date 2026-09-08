import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPanels } from "../../src/renderer/browser/workbench-panels";
import { useBrowserPanels } from "../../src/renderer/browser/use-browser-panels";
import { LocaleProvider } from "../../src/renderer/i18n";
import "../../src/renderer/styles.css";

function Fixture() {
  const panels = useBrowserPanels();
  return <div style={{ display: "flex", width: "100%", height: "100vh" }}>
    <WorkbenchPanels panels={panels} inspect={<div>审查测试内容</div>} onError={(message) => { throw new Error(message); }} />
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>,
);
