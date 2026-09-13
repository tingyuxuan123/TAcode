/** 仅在性能夹具中启用 React profiling 构建与提交计时，不进入产品 bundle。 */
export function rendererPerformancePlugin(enabled) {
  const record = `(id, phase, duration) => window.__tacodePerf?.commits.push({ id, phase, duration })`;
  return { name: "tacode-performance-fixture", enforce: "pre", transform(code, id) {
    if (!enabled) return;
    if (id.endsWith("/src/renderer/main.tsx")) {
      return `import { Profiler as BenchmarkProfiler } from "react";\n${code.replace("<App />", `<BenchmarkProfiler id="main" onRender={${record}}><App /></BenchmarkProfiler>`)}`;
    }
    if (id.endsWith("/src/renderer/browser/workbench-panels.tsx")) {
      return `import { Profiler as BenchmarkProfiler } from "react";\n${code.replace(/<ChildSessionPanel\b[\s\S]*?\/>/g, (jsx) => `<BenchmarkProfiler id={"child:" + tab.key} onRender={${record}}>${jsx}</BenchmarkProfiler>`).replace(/<SideChatPanel\b[\s\S]*?\/>/g, (jsx) => `<BenchmarkProfiler id={"side:" + tab.id} onRender={${record}}>${jsx}</BenchmarkProfiler>`)}`;
    }
  } };
}
