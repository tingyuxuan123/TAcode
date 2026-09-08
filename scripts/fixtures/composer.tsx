import { useState } from "react";
import { PromptBar } from "../../src/renderer/ui";

/** Real composer with local state only; callbacks do not start an Agent or access a model. */
export function ComposerFixture() {
  const [model, setModel] = useState("glm-5.3-flash");
  const [effort, setEffort] = useState("xhigh");
  const [permission, setPermission] = useState("auto");
  const [running, setRunning] = useState(false);
  const [action, setAction] = useState("");
  const models = ["glm-5.3-flash", "这是用于验证布局收缩与完整提示的超长模型名称"].map((name) => ({ value: name, label: name, modelId: name, providerName: "本地测试" }));
  return <>
    <output data-composer-action style={{ position: "absolute", top: 60, left: 24 }}>{action}</output>
    <PromptBar
      fillText="缩放后保留这条输入"
      workspace="/test/xc-app" onPickWorkspace={() => setAction("选择项目")}
      model={model} modelKey={model} models={models} onModel={(next) => { setModel(next); setAction(`模型：${next}`); }}
      effort={effort} effortLevels={["off", "low", "medium", "high", "xhigh"]} onEffort={(next) => { setEffort(next); setAction(`思考：${next}`); }}
      permission={permission} onPermission={(next) => { setPermission(next); setAction(`权限：${next}`); }}
      running={running} onSubmit={(text) => { setAction(`发送：${text}`); setRunning(true); }}
      onStop={() => { setRunning(false); setAction("已停止"); }} onCommand={(command) => setAction(command)}
      onCompact={() => setAction("已请求压缩")}
      stats={{ sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, cost: 0,
        tokens: { input: 2176, output: 10, cacheRead: 0, cacheWrite: 0, total: 2186 }, contextUsage: { tokens: 2176, contextWindow: 128000, percent: 1.7 } }}
    />
  </>;
}
