import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, CircleDashed, Code2, Database, FileJson, FolderOpen, Globe, Plug, Plus, RefreshCw, Search, Server, Trash2, XCircle } from "lucide-react";
import type { CapabilityScope, McpTestResult } from "../../shared/capabilities";
import type { McpServerRow } from "../../shared/integrations";
import { formatMcpServerJson, parseMcpArguments, parseMcpKeyValues, parseMcpServerJson, validateMcpServer } from "../../shared/mcp-config";
import type { MessageKey } from "../../shared/i18n";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "../ui";
import type { CapabilityPanelProps } from "./skills-panel";
import { CapabilityBack, CapabilityNotice, CapabilityScopePicker, CapabilitySearch, CapabilitySkeleton, CapabilitySwitch, CapabilityTrust, errorText, useCapabilityData, useDirty, useDiscardGuard } from "./common";

const transportLabel = (kind: McpServerRow["kind"]): string => kind === "http" ? "HTTP" : kind === "sse" ? "SSE" : "stdio";
const testKey = (server: McpServerRow): string => JSON.stringify(server);

function catalog(workspace?: string) {
  return [
    { name: "Filesystem", icon: FolderOpen, description: "cap.catalogFilesystem", server: { name: "filesystem", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ...(workspace ? [workspace] : [])] } },
    { name: "Context7", icon: Search, description: "cap.catalogContext7", server: { name: "context7", kind: "http", url: "https://mcp.context7.com/mcp" } },
    { name: "GitHub", icon: Code2, description: "cap.catalogGithub", server: { name: "github", kind: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } },
    { name: "Playwright", icon: Globe, description: "cap.catalogPlaywright", server: { name: "playwright", kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
    { name: "Memory", icon: Database, description: "cap.catalogMemory", server: { name: "memory", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
    { name: "Fetch", icon: Globe, description: "cap.catalogFetch", server: { name: "fetch", kind: "stdio", command: "uvx", args: ["mcp-server-fetch"] } },
  ] satisfies Array<{ name: string; icon: typeof Plug; description: MessageKey; server: McpServerRow }>;
}

function displayTarget(server: McpServerRow): string {
  if (server.kind === "stdio") return [server.command, ...(server.args ?? [])].join(" ");
  try { const url = new URL(server.url ?? ""); return `${url.origin}${url.pathname}`; } catch { return server.url ?? ""; }
}

export function McpPanel(props: CapabilityPanelProps) {
  const [scope, setScope] = useState<CapabilityScope>(props.workspace ? "project" : "user");
  // 提示放在外层：编辑器把配置存进另一个作用域时，列表会随作用域整体重挂载。
  const [notice, setNotice] = useState("");
  return <McpLibrary key={`${props.workspace ?? ""}:${scope}`} {...props} scope={scope} onScopeChange={setScope} notice={notice} onNoticeChange={setNotice} />;
}

function McpLibrary({ workspace, scope, onScopeChange, notice, onNoticeChange: setNotice, onUsePrompt, onDirtyChange }: CapabilityPanelProps & { scope: CapabilityScope; onScopeChange(scope: CapabilityScope): void; notice: string; onNoticeChange(notice: string): void }) {
  const { t } = useI18n();
  const load = useCallback(() => window.harness.mcp.list(scope, workspace), [scope, workspace]);
  const { data, loading, error, refresh, setError } = useCapabilityData(load, workspace);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<{ server: McpServerRow; previousName?: string }>();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<McpServerRow>();
  const [busy, setBusy] = useState("");
  const [tests, setTests] = useState<Record<string, McpTestResult>>({});
  const servers = data?.servers ?? [];
  const filtered = servers.filter((server) => [server.name, server.description, displayTarget(server)].join(" ").toLowerCase().includes(search.toLowerCase().trim()));
  const available = useMemo(() => catalog(workspace).filter((item) => !servers.some((server) => server.name === item.server.name) && [item.name, t(item.description)].join(" ").toLowerCase().includes(search.toLowerCase().trim())), [workspace, servers, search, t]);
  const mutate = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name); setError("");
    try { await action(); await refresh(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(""); }
  };

  if (importing) return <McpImport scope={scope} workspace={workspace} onBack={() => setImporting(false)} onDirtyChange={onDirtyChange} onSaved={(count) => { setImporting(false); setNotice(t("cap.jsonImported", { count })); void refresh(); }} />;
  if (editor) return <McpEditor key={editor.previousName ?? "new"} {...editor} scope={scope} workspace={workspace} onDirtyChange={onDirtyChange} onBack={() => setEditor(undefined)} onSaved={(savedScope) => { setEditor(undefined); setNotice(t("cap.saved")); if (savedScope === scope) void refresh(); else onScopeChange(savedScope); }} onTested={(server, result) => setTests((current) => ({ ...current, [testKey(server)]: result }))} />;

  return <section className="cap-panel" aria-label="MCP">
    <header className="cap-heading"><div className="cap-heading-title"><Plug size={22} /><h2>MCP</h2><span className="cap-count">{servers.length}</span></div><CapabilityScopePicker scope={scope} workspace={workspace} onChange={onScopeChange} /></header>
    <p className="cap-intro">{t("cap.mcpHint")}</p>
    <div className="cap-toolbar"><CapabilitySearch value={search} onChange={setSearch} placeholder={t("cap.searchMcp")} /><button type="button" className="cap-icon-button" aria-label={t("cap.refresh")} title={t("cap.refresh")} onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "cap-spinning" : ""} /></button>
      <button type="button" className="primary" onClick={() => setEditor({ server: { name: "", kind: "stdio", command: "" } })}><Plus size={15} />{t("cap.addServer")}</button>
      <button type="button" className="ghost" onClick={() => setImporting(true)}><FileJson size={15} />{t("cap.import")}</button>
      <button type="button" className="cap-icon-button" title={t("cap.configFile")} aria-label={t("cap.configFile")} onClick={() => void window.harness.mcp.reveal(scope, workspace).catch((reason) => setError(errorText(reason)))}><FolderOpen size={16} /></button>
    </div>
    <div className="cap-scroll">
      {scope === "project" && data && <CapabilityTrust trusted={data.projectTrusted} workspace={workspace} onTrusted={() => void refresh()} />}
      {error && <CapabilityNotice error>{error}<button type="button" className="cap-text-button" onClick={() => void refresh()}>{t("cap.retry")}</button></CapabilityNotice>}
      {notice && <CapabilityNotice>{notice}</CapabilityNotice>}
      {loading && !data ? <CapabilitySkeleton label={t("cap.loading")} /> : <>
        {filtered.length > 0 && <><h3 className="cap-section-title">{t("cap.configured")}<span className="cap-count">{filtered.length}</span></h3><div className="cap-card-list">{filtered.map((server) => {
          const test = tests[testKey(server)];
          return <article className={`cap-card${server.disabled ? " is-disabled" : ""}`} key={server.name}>
            <button type="button" className="cap-card-open" onClick={() => setEditor({ server, previousName: server.name })} aria-label={`${t("cap.configure")} ${server.name}`}><div className="cap-card-top"><span className="cap-card-icon"><Server size={18} /></span><div className="cap-card-title"><h3>{server.name}</h3><span className="cap-chip">{transportLabel(server.kind)}</span></div></div><p className="cap-card-description">{server.description || displayTarget(server)}</p></button>
            <div className="cap-card-switch"><CapabilitySwitch checked={!server.disabled} label={t("cap.toggle", { name: server.name })} disabled={Boolean(busy)} onChange={(enabled) => void mutate(server.name, () => window.harness.mcp.setEnabled(server.name, enabled, scope, workspace))} /></div>
            <div className="cap-card-footer"><span className={test?.success ? "cap-status-success" : test ? "cap-status-error" : ""}>{server.disabled ? t("cap.disabled") : test?.success ? <><CheckCircle2 size={13} />{t("cap.testPassed", { count: test.tools.length })}</> : test ? <><XCircle size={13} />{t("cap.testFailed")}</> : <><CircleDashed size={13} />{t("cap.notTested")}</>}</span>
              <button type="button" className="cap-text-button" disabled={Boolean(busy)} onClick={() => void mutate(server.name, async () => { const result = await window.harness.mcp.test(server, workspace); setTests((current) => ({ ...current, [testKey(server)]: result })); if (!result.success) setNotice(result.message); })}>{busy === server.name ? t("cap.testing") : t("cap.test")}</button><button type="button" className="cap-icon-button cap-danger" title={t("cap.remove")} aria-label={`${t("cap.remove")} ${server.name}`} disabled={Boolean(busy)} onClick={() => setRemoving(server)}><Trash2 size={14} /></button>
            </div>
          </article>;
        })}</div></>}
        {!servers.length && !search && <div className="cap-empty cap-empty-compact"><h3>{t("cap.mcpEmpty")}</h3><p>{t("cap.mcpEmptyHint")}</p></div>}
        {available.length > 0 && <><h3 className="cap-section-title">{t("cap.catalog")}<span className="cap-count">{available.length}</span></h3><p className="cap-section-hint">{t("cap.catalogHint")}</p><div className="cap-card-list">{available.map((item) => <article className="cap-card cap-catalog-card" key={item.name}><div className="cap-card-top"><span className="cap-card-icon"><item.icon size={20} /></span><div className="cap-card-title"><h3>{item.name}</h3><span className="cap-chip">{transportLabel(item.server.kind)}</span></div></div><p className="cap-card-description">{t(item.description)}</p><div className="cap-card-footer"><span><CircleDashed size={13} />{t("cap.notConfigured")}</span><button type="button" className="ghost" aria-label={`${t("cap.configure")} ${item.name}`} onClick={() => setEditor({ server: { ...item.server, description: t(item.description) } })}>{t("cap.configure")}</button></div></article>)}</div></>}
        {search && !filtered.length && !available.length && <div className="cap-empty">{t("cap.noResults")}</div>}
      </>}
    </div>
    <footer className="cap-footer">{onUsePrompt && <button type="button" className="cap-agent-action" onClick={() => onUsePrompt(t("cap.agentMcpPrompt"))}><Bot size={16} />{t("cap.agentMcp")}</button>}<p>{t("cap.appliesNext")}</p></footer>
    {removing && <ConfirmDialog title={t("cap.mcpRemoveTitle", { name: removing.name })} detail={t("cap.mcpRemoveDetail")} confirmLabel={t("cap.remove")} cancelLabel={t("cap.cancel")} onCancel={() => setRemoving(undefined)} onConfirm={() => { const server = removing; setRemoving(undefined); void mutate(server.name, () => window.harness.mcp.remove(server.name, scope, workspace)); }} />}
  </section>;
}

const keyValues = (values: Record<string, string> | undefined, separator: string): string => Object.entries(values ?? {}).map(([key, value]) => `${key}${separator}${value}`).join("\n");
const argumentText = (args: string[] = []): string => args.some((arg) => !arg || arg.trim() !== arg || /[\r\n]/.test(arg)) ? JSON.stringify(args, null, 2) : args.join("\n");
interface EditorValues { name: string; kind: McpServerRow["kind"]; description: string; command: string; args: string; env: string; url: string; headers: string; cwd: string; timeout: string; enabled: boolean }

const editorValues = (server: McpServerRow): EditorValues => ({ name: server.name, kind: server.kind, description: server.description ?? "", command: server.command ?? "", args: argumentText(server.args), env: keyValues(server.env, "="), url: server.url ?? "", headers: keyValues(server.headers, ": "), cwd: server.cwd ?? "", timeout: String(server.timeout ?? 20), enabled: !server.disabled });

function McpEditor({ server, previousName, scope, workspace, onBack, onSaved, onTested, onDirtyChange }: CapabilityPanelProps & { server: McpServerRow; previousName?: string; scope: CapabilityScope; onBack(): void; onSaved(scope: CapabilityScope): void; onTested(server: McpServerRow, result: McpTestResult): void }) {
  const { t } = useI18n();
  const initial = useMemo(() => editorValues(server), [server]);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [values, setValues] = useState(initial);
  const [savedValues, setSavedValues] = useState(initial);
  // 未知扩展字段在表单和 JSON 之间来回切换都不能丢。
  const [extra, setExtra] = useState<Record<string, unknown> | undefined>(server.extra);
  const [json, setJson] = useState("");
  const [jsonBase, setJsonBase] = useState("");
  const [targetScope, setTargetScope] = useState(scope);
  const [busy, setBusy] = useState<"save" | "test">();
  const [error, setError] = useState("");
  const [test, setTest] = useState<McpTestResult>();
  const jsonRef = useRef<HTMLTextAreaElement>(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(savedValues) || json !== jsonBase;
  useDirty(dirty, onDirtyChange);
  const guard = useDiscardGuard(dirty, onBack);
  useEffect(() => { if (mode === "json") jsonRef.current?.focus(); }, [mode]);
  const update = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => { setValues((current) => ({ ...current, [key]: value })); setTest(undefined); };
  const keyValueRow = (text: string, separator: "=" | ":"): Record<string, string> | undefined => {
    const entries = parseMcpKeyValues(text, separator);
    return Object.keys(entries).length ? entries : undefined;
  };
  const build = (): McpServerRow => validateMcpServer({
    name: values.name, kind: values.kind, description: values.description, disabled: !values.enabled,
    timeout: Number(values.timeout), extra, cwd: values.cwd,
    // env / headers 与 transport 无关地保留：JSON 里粘进来的字段不能因为经过表单就被删掉。
    env: keyValueRow(values.env, "="), headers: keyValueRow(values.headers, ":"),
    ...(values.kind === "stdio" ? { command: values.command, args: parseMcpArguments(values.args) } : { url: values.url }),
  });
  const current = (): McpServerRow => mode === "json" ? parseMcpServerJson(json) : build();
  // 表单 → JSON：表单填完了就按表单生成；没填完保留用户已经在写的内容。
  const toJson = () => {
    setError("");
    try { const generated = formatMcpServerJson(build()); setJson(generated); setJsonBase(generated); } catch { /* 表单还没填完整，保留现有 JSON */ }
    setTest(undefined); setMode("json");
  };
  // JSON → 表单：只有解析成功才切换，失败留在 JSON 并显示原因。
  const toForm = () => {
    setError("");
    if (json.trim()) {
      try {
        const row = parseMcpServerJson(json);
        setValues(editorValues(row)); setExtra(row.extra);
      } catch (reason) { setError(errorText(reason)); return; }
    }
    setTest(undefined); setMode("form");
  };
  const run = async (action: "save" | "test") => {
    setBusy(action); setError("");
    try {
      const row = current();
      if (action === "test") { const result = await window.harness.mcp.test(row, workspace); setTest(result); onTested(row, result); }
      else {
        // 换作用域保存等于复制一份新配置：previousName 只在当前作用域里有意义。
        await window.harness.mcp.save(row, targetScope === scope ? previousName : undefined, targetScope, workspace);
        if (mode === "json") { setSavedValues(editorValues(row)); setJsonBase(json); } else setSavedValues(values);
        onSaved(targetScope);
      }
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(undefined); }
  };
  return <section className="cap-panel"><CapabilityBack title={previousName ?? t("cap.addServer")} dirty={dirty} onBack={onBack} trailing={<div className="cap-editor-tabs" role="group" aria-label={t("cap.editMode")}><button type="button" className={mode === "form" ? "active" : ""} aria-pressed={mode === "form"} disabled={Boolean(busy)} onClick={() => { if (mode === "json") toForm(); }}>{t("cap.modeForm")}</button><button type="button" className={mode === "json" ? "active" : ""} aria-pressed={mode === "json"} disabled={Boolean(busy)} onClick={() => { if (mode === "form") toJson(); }}>{t("cap.modeJson")}</button></div>} /><form className="cap-form cap-scroll" onSubmit={(event) => { event.preventDefault(); void run("save"); }}>
    <div className={`cap-detail-meta${mode === "json" ? " cap-json-meta" : ""}`}><span>{t("cap.scope")}</span><CapabilityScopePicker scope={targetScope} workspace={workspace} onChange={setTargetScope} />{mode === "form" && <span className="cap-enabled-control">{t(values.enabled ? "cap.enabled" : "cap.disabled")}<CapabilitySwitch checked={values.enabled} disabled={Boolean(busy)} label={t("cap.toggle", { name: values.name || "MCP" })} onChange={(enabled) => update("enabled", enabled)} /></span>}</div>
    {error && <CapabilityNotice error>{error}</CapabilityNotice>}
    {mode === "json" ? <fieldset disabled={Boolean(busy)} className="cap-fieldset">
      <label>{t("cap.jsonConfig")}<textarea ref={jsonRef} aria-label={t("cap.jsonConfig")} className="cap-source-editor cap-mono" spellCheck={false} rows={16} value={json} placeholder={'{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}'} onChange={(event) => { setJson(event.target.value); setTest(undefined); }} /><small>{t("cap.jsonServerHint")}</small><small>{t("cap.jsonNameHint")}</small><small>{t("cap.jsonOnlyOne")}</small></label>
    </fieldset> : <fieldset disabled={Boolean(busy)} className="cap-fieldset">
      <label>{t("cap.serverName")}<input autoFocus value={values.name} required maxLength={100} placeholder="my-server" onChange={(event) => update("name", event.target.value)} /></label>
      <label>{t("cap.description")}<input value={values.description} onChange={(event) => update("description", event.target.value)} /></label>
      <label>{t("cap.transport")}<select value={values.kind} onChange={(event) => update("kind", event.target.value as McpServerRow["kind"])}><option value="stdio">{t("cap.stdio")}</option><option value="http">{t("cap.http")}</option><option value="sse">{t("cap.sse")}</option></select></label>
      {values.kind === "stdio" ? <>
        <label>{t("cap.command")}<input value={values.command} required placeholder="npx" onChange={(event) => update("command", event.target.value)} /><small>{t("cap.commandHint")}</small></label>
        <label>{t("cap.args")}<textarea spellCheck={false} className="cap-mono" value={values.args} rows={4} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'} onChange={(event) => update("args", event.target.value)} /><small>{t("cap.argsHint")}</small></label>
        <label>{t("cap.env")}<textarea spellCheck={false} className="cap-mono" value={values.env} rows={3} placeholder="API_KEY=…" onChange={(event) => update("env", event.target.value)} /><small>{t("cap.envHint")}</small></label>
      </> : <>
        <label>{t("cap.url")}<input type="url" value={values.url} required placeholder="https://example.com/mcp" onChange={(event) => update("url", event.target.value)} /></label>
        <label>{t("cap.headers")}<textarea spellCheck={false} className="cap-mono" value={values.headers} rows={3} placeholder="Authorization: Bearer …" onChange={(event) => update("headers", event.target.value)} /><small>{t("cap.headersHint")}</small></label>
      </>}
      <details className="cap-advanced"><summary>{t("cap.advanced")}</summary>{values.kind === "stdio" && <label>{t("cap.cwd")}<input value={values.cwd} onChange={(event) => update("cwd", event.target.value)} /><small>{t("cap.cwdHint")}</small></label>}<label>{t("cap.timeout")}<input type="number" min={1} max={300} value={values.timeout} onChange={(event) => update("timeout", event.target.value)} /></label></details>
    </fieldset>}
    {test && <div className={`cap-test-result ${test.success ? "is-success" : "is-error"}`} role="status"><div>{test.success ? <CheckCircle2 size={17} /> : <XCircle size={17} />}<strong>{test.success ? t("cap.testPassed", { count: test.tools.length }) : t("cap.testFailed")}</strong></div>{!test.success && <p>{test.message}</p>}{test.success && <details open={test.tools.length <= 5}><summary>{t("cap.tools")}</summary>{!test.tools.length && <p>{t("cap.noTools")}</p>}<ul>{test.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description && <p>{tool.description}</p>}</li>)}</ul></details>}</div>}
    <div className="cap-form-actions"><button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => void run("test")}><Plug size={15} />{t(busy === "test" ? "cap.testing" : "cap.test")}</button><button type="button" className="ghost" disabled={Boolean(busy)} onClick={guard.request}>{t("cap.cancel")}</button><button type="submit" className="primary" disabled={Boolean(busy)}>{t(busy === "save" ? "cap.saving" : "cap.save")}</button></div>
    <p className="cap-section-hint">{t("cap.appliesNext")}</p>
  </form>{guard.dialog}</section>;
}

function McpImport({ scope, workspace, onBack, onSaved, onDirtyChange }: CapabilityPanelProps & { scope: CapabilityScope; onBack(): void; onSaved(count: number): void }) {
  const { t } = useI18n();
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDirty(Boolean(json), onDirtyChange);
  return <section className="cap-panel"><CapabilityBack title={t("cap.jsonImport")} dirty={Boolean(json)} onBack={onBack} /><div className="cap-scroll cap-form"><span className="cap-chip">{t(scope === "project" ? "cap.project" : "cap.user")}</span><p className="cap-section-hint">{t("cap.jsonHint")}</p>{error && <CapabilityNotice error>{error}</CapabilityNotice>}<textarea autoFocus aria-label={t("cap.jsonImport")} className="cap-source-editor" rows={18} spellCheck={false} value={json} onChange={(event) => setJson(event.target.value)} placeholder={'{\n  "mcpServers": {\n    "example": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}'} /><div className="cap-form-actions"><button type="button" className="primary" disabled={busy || !json.trim()} onClick={() => {
    setBusy(true); setError("");
    void window.harness.mcp.import(json, scope, workspace).then(onSaved).catch((reason) => setError(errorText(reason))).finally(() => setBusy(false));
  }}>{t(busy ? "cap.importing" : "cap.import")}</button></div></div></section>;
}
