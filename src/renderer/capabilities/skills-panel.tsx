import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, FileText, FolderOpen, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import type { CapabilityScope, ManagedSkill, SkillDocument } from "../../shared/capabilities";
import { skillSlashCommand } from "../../shared/skills";
import { useI18n } from "../i18n";
import { ConfirmDialog, Markdown } from "../ui";
import { CapabilityBack, CapabilityNotice, CapabilityScopePicker, CapabilitySearch, CapabilitySkeleton, CapabilitySwitch, CapabilityTrust, errorText, useCapabilityData, useDirty } from "./common";

const COLLAPSED_KEY = "skills:collapsed-groups";

export interface CapabilityPanelProps {
  workspace?: string;
  onUsePrompt?(text: string): void;
  onDirtyChange?(dirty: boolean): void;
}

export function SkillsPanel(props: CapabilityPanelProps) {
  const [scope, setScope] = useState<CapabilityScope>(props.workspace ? "project" : "user");
  return <SkillsLibrary key={`${props.workspace ?? ""}:${scope}`} {...props} scope={scope} onScopeChange={setScope} />;
}

function SkillsLibrary({ workspace, scope, onScopeChange, onUsePrompt, onDirtyChange }: CapabilityPanelProps & { scope: CapabilityScope; onScopeChange(scope: CapabilityScope): void }) {
  const { t } = useI18n();
  const load = useCallback(() => window.harness.skills.list(workspace), [workspace]);
  const { data, loading, error, refresh, setError } = useCapabilityData(load, workspace);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<ManagedSkill>();
  // 折叠的分组名跨会话记忆在 localStorage，展开仍是默认态。
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
  });
  const toggleGroup = (name: string, open: boolean) => setCollapsed((current) => {
    const next = open ? current.filter((item) => item !== name) : current.includes(name) ? current : [...current, name];
    if (next === current) return current;
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* 隐私模式等场景只对本次生效 */ }
    return next;
  });
  const skills = (data?.skills ?? []).filter((skill) => skill.scope === scope);
  const groups = useMemo(() => {
    const grouped = new Map<string, ManagedSkill[]>();
    for (const skill of skills) {
      if (![skill.name, skill.description, skill.group].join(" ").toLowerCase().includes(search.toLowerCase().trim())) continue;
      const group = skill.group || t("cap.ungrouped");
      grouped.set(group, [...(grouped.get(group) ?? []), skill]);
    }
    return [...grouped].sort(([a], [b]) => a.localeCompare(b));
  }, [skills, search, t]);

  const mutate = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setError(""); setNotice("");
    try { await action(); await refresh(); } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(""); }
  };

  if (editing === "new") return <NewSkill scope={scope} workspace={workspace} onBack={() => setEditing(undefined)} onSaved={(skill) => { void refresh(); setEditing(skill.id); }} onDirtyChange={onDirtyChange} />;
  if (editing) return <SkillEditor key={editing} id={editing} workspace={workspace} onBack={() => { setEditing(undefined); void refresh(); }} onUsePrompt={onUsePrompt} onDirtyChange={onDirtyChange} />;

  return <section className="cap-panel" aria-label="Skills">
    <header className="cap-heading"><div className="cap-heading-title"><Sparkles size={22} /><h2>Skills</h2><span className="cap-count">{skills.length}</span></div><CapabilityScopePicker scope={scope} workspace={workspace} onChange={onScopeChange} /></header>
    <p className="cap-intro">{t("cap.skillsHint")}</p>
    <div className="cap-toolbar"><CapabilitySearch value={search} onChange={setSearch} placeholder={t("cap.searchSkills")} />
      <button type="button" className="cap-icon-button" aria-label={t("cap.refresh")} title={t("cap.refresh")} onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "cap-spinning" : ""} /></button>
      <button type="button" className="primary" onClick={() => setEditing("new")} disabled={Boolean(busy)}><Plus size={15} />{t("cap.newSkill")}</button>
      <button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => void mutate("import", async () => {
        const result = await window.harness.skills.import(scope, workspace);
        if (result) {
          setNotice(t("cap.importSummary", { count: result.imported.length, skipped: result.skipped.length }));
          if (result.errors.length) throw new Error(result.errors.join("\n"));
        }
      })}><Upload size={15} />{busy === "import" ? t("cap.importing") : t("cap.import")}</button>
    </div>
    <div className="cap-scroll">
      {scope === "project" && data && <CapabilityTrust trusted={data.projectTrusted} workspace={workspace} onTrusted={() => void refresh()} />}
      {error && <CapabilityNotice error>{error}<button type="button" className="cap-text-button" onClick={() => void refresh()}>{t("cap.retry")}</button></CapabilityNotice>}
      {notice && <CapabilityNotice>{notice}</CapabilityNotice>}
      {loading && !data ? <CapabilitySkeleton label={t("cap.loading")} /> : groups.length === 0 ? <div className="cap-empty"><Sparkles size={28} /><h3>{search ? t("cap.noResults") : t("cap.skillsEmpty")}</h3><p>{search ? "" : t("cap.skillsEmptyHint")}</p></div> : groups.map(([name, entries]) => <details className="cap-group" key={name} open={Boolean(search.trim()) || !collapsed.includes(name)}>
        <summary onClick={(event) => {
          if (search.trim()) { event.preventDefault(); return; } // 搜索时结果组保持展开，不可折叠
          const group = event.currentTarget.parentElement as HTMLDetailsElement | null;
          if (group) toggleGroup(name, !group.open);
        }}><ChevronDown size={14} /><span>{name}</span><span className="cap-count">{entries.length}</span></summary>
        <div className="cap-card-list">{entries.map((skill) => <article className={`cap-card cap-skill-card${skill.enabled ? "" : " is-disabled"}`} key={skill.id}>
          <button type="button" className="cap-card-open" onClick={() => setEditing(skill.id)} aria-label={`${t("cap.configure")} ${skill.name}`}>
            <div className="cap-card-top"><span className="cap-card-icon"><Sparkles size={18} /></span><div className="cap-card-title"><h3>{skill.name}</h3><code>{skillSlashCommand(skill.name)}</code></div></div>
            <p className="cap-card-description">{skill.description || skill.warning}</p>
            {skill.warning && <div className="cap-card-tags"><span className="cap-chip is-error">{t("cap.invalidSkill")}</span></div>}
          </button>
          <div className="cap-card-switch"><CapabilitySwitch checked={skill.enabled} label={t("cap.toggle", { name: skill.name })} disabled={Boolean(busy)} onChange={(enabled) => void mutate(skill.id, () => window.harness.skills.setEnabled(skill.id, enabled, workspace))} /></div>
          <div className="cap-card-footer"><span><span className="cap-chip">{skill.rootLabel}</span>{skill.version && <span className="cap-chip">v{skill.version}</span>}</span><button type="button" className="cap-icon-button" title={t("cap.openFolder")} aria-label={`${t("cap.openFolder")} ${skill.name}`} onClick={() => void window.harness.skills.reveal(skill.id, workspace).catch((reason) => setError(errorText(reason)))}><FolderOpen size={14} /></button><button type="button" className="cap-icon-button cap-danger" title={t("cap.remove")} aria-label={`${t("cap.remove")} ${skill.name}`} disabled={Boolean(busy)} onClick={() => setRemoving(skill)}><Trash2 size={14} /></button></div>
        </article>)}</div>
      </details>)}
    </div>
    <footer className="cap-footer">{onUsePrompt && <button type="button" className="cap-agent-action" onClick={() => onUsePrompt(t("cap.agentSkillPrompt"))}><Bot size={16} />{t("cap.agentSkill")}</button>}<p>{t("cap.appliesNext")}</p></footer>
    {removing && <ConfirmDialog title={t("cap.skillRemoveTitle", { name: removing.name })} detail={t("cap.skillRemoveDetail")} confirmLabel={t("cap.remove")} cancelLabel={t("cap.cancel")} onCancel={() => setRemoving(undefined)} onConfirm={() => {
      const skill = removing; setRemoving(undefined); void mutate(skill.id, () => window.harness.skills.remove(skill.id, workspace));
    }} />}
  </section>;
}

function NewSkill({ workspace, scope, onBack, onSaved, onDirtyChange }: CapabilityPanelProps & { scope: CapabilityScope; onBack(): void; onSaved(skill: ManagedSkill): void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = Boolean(name || description || group || body);
  useDirty(dirty, onDirtyChange);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const content = ["---", `name: ${JSON.stringify(name.trim())}`, `description: ${JSON.stringify(description.trim())}`, "version: 1.0.0", ...(group.trim() ? [`group: ${JSON.stringify(group.trim())}`] : []), "---", "", body.trim(), ""].join("\n");
      onSaved(await window.harness.skills.create(content, scope, workspace));
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <section className="cap-panel"><CapabilityBack title={t("cap.newSkill")} dirty={dirty} onBack={onBack} /><form className="cap-form cap-scroll" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <span className="cap-chip">{t(scope === "project" ? "cap.project" : "cap.user")}</span>
    {error && <CapabilityNotice error>{error}</CapabilityNotice>}
    <label>{t("cap.skillName")}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="code-review" required maxLength={64} pattern={"[a-z0-9][a-z0-9\\-]*"} /><small>{t("cap.nameHint")}</small></label>
    <label>{t("cap.description")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("cap.descriptionHint")} required rows={3} /></label>
    <label>{t("cap.group")}<input value={group} onChange={(event) => setGroup(event.target.value)} placeholder={t("cap.groupHint")} maxLength={100} /></label>
    <label>{t("cap.instructions")}<textarea className="cap-source-editor" value={body} onChange={(event) => setBody(event.target.value)} placeholder={t("cap.instructionsHint")} rows={12} /></label>
    <div className="cap-form-actions"><button type="submit" className="primary" disabled={busy || !name.trim() || !description.trim()}>{t(busy ? "cap.saving" : "cap.save")}</button></div>
  </form></section>;
}

function SkillEditor({ id, workspace, onBack, onUsePrompt, onDirtyChange }: CapabilityPanelProps & { id: string; onBack(): void }) {
  const { t } = useI18n();
  const [document, setDocument] = useState<SkillDocument>();
  const [file, setFile] = useState("SKILL.md");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingFile, setPendingFile] = useState<string>();
  const sequence = useRef(0);
  const dirty = content !== saved;
  useDirty(dirty, onDirtyChange);

  const load = useCallback(async (nextFile = "SKILL.md") => {
    const current = ++sequence.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const doc = await window.harness.skills.read(id, workspace);
      const text = nextFile === "SKILL.md" ? doc.content : await window.harness.skills.readFile(id, nextFile, workspace);
      if (current !== sequence.current) return;
      setDocument(doc); setContent(text); setSaved(text); setFile(nextFile); setPreview(false);
    } catch (reason) { if (current === sequence.current) setError(errorText(reason)); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [id, workspace]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    const snapshot = content;
    try {
      if (file === "SKILL.md") {
        const skill = await window.harness.skills.save(id, snapshot, saved, workspace);
        setDocument((current) => current ? { ...current, skill, content: snapshot } : current);
      } else await window.harness.skills.saveFile(id, file, snapshot, saved, workspace);
      setSaved(snapshot); setNotice(t("cap.saved"));
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <section className="cap-panel"><CapabilityBack title={document?.skill.name ?? "Skills"} dirty={dirty} onBack={onBack} />
    <div className="cap-scroll cap-form">
      {document && <><div className="cap-detail-meta"><span className="cap-chip">{document.skill.rootLabel}</span>{document.skill.version && <span className="cap-chip">v{document.skill.version}</span>}<span className="cap-chip">{t(document.skill.enabled ? "cap.enabled" : "cap.disabled")}</span></div>
        <p className="cap-detail-description">{document.skill.description}</p>
        <div className="cap-actions"><button type="button" className="ghost" onClick={() => void window.harness.skills.reveal(id, workspace).catch((reason) => setError(errorText(reason)))}><FolderOpen size={14} />{t("cap.openFolder")}</button>{onUsePrompt && <button type="button" className="ghost" disabled={!document.skill.enabled || Boolean(document.skill.warning)} onClick={() => onUsePrompt(`${skillSlashCommand(document.skill.name)} `)}>{t("cap.useSkill")}</button>}</div>
        {document.skill.warning && <CapabilityNotice error>{document.skill.warning}</CapabilityNotice>}
        <label>{t("cap.files")}<select aria-label={t("cap.files")} value={file} disabled={loading || busy} onChange={(event) => dirty ? setPendingFile(event.target.value) : void load(event.target.value)}><option value="SKILL.md">SKILL.md</option>{document.files.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </>}
      {error && <CapabilityNotice error>{error}<button type="button" className="cap-text-button" onClick={() => dirty ? setPendingFile(file) : void load(file)}>{t("cap.refresh")}</button></CapabilityNotice>}
      {loading ? <p>{t("cap.loading")}</p> : document && <>
        <div className="cap-editor-tabs"><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}><FileText size={14} />{file === "SKILL.md" ? t("cap.skillSource") : file}</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>{t("cap.preview")}</button></div>
        {preview ? <div className="cap-markdown"><Markdown>{file === "SKILL.md" ? content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "") : content}</Markdown></div> : <textarea aria-label={file === "SKILL.md" ? t("cap.skillSource") : file} className="cap-source-editor" spellCheck={false} value={content} rows={18} onChange={(event) => { setContent(event.target.value); setNotice(""); }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (dirty && !busy) void save(); } }} />}
        <div className="cap-form-actions"><span role="status">{dirty ? t("cap.unsaved") : notice}</span><button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>{t(busy ? "cap.saving" : "cap.save")}</button></div>
      </>}
    </div>
    {pendingFile && <ConfirmDialog title={t("cap.discardTitle")} detail={t("cap.discardDetail")} confirmLabel={t("cap.discard")} cancelLabel={t("cap.keepEditing")} onCancel={() => setPendingFile(undefined)} onConfirm={() => { const next = pendingFile; setPendingFile(undefined); void load(next); }} />}
  </section>;
}
