import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches, gotoLine } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { useI18n } from "../i18n";
import type { SourceLocation, WorkbenchColorScheme } from "./types";

export interface CodeEditorHandle {
  focus(): void;
  reveal(location: SourceLocation): void;
  getValue(): string;
}

const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#751ed9" },
  { tag: tags.moduleKeyword, color: "#d53638" },
  { tag: [tags.string, tags.regexp], color: "#00880a" },
  { tag: [tags.number, tags.bool, tags.null], color: "#751ed9" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#bd5800" },
  { tag: [tags.typeName, tags.className], color: "#751ed9" },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: "#bd5800" },
  { tag: [tags.comment, tags.meta], color: "#8b8e94" },
  { tag: [tags.operator, tags.punctuation], color: "#696c77" },
]);
const darkSyntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#c678dd" },
  { tag: tags.moduleKeyword, color: "#e06c75" },
  { tag: [tags.string, tags.regexp], color: "#98c379" },
  { tag: [tags.number, tags.bool, tags.null], color: "#d19a66" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#61afef" },
  { tag: [tags.typeName, tags.className], color: "#e5c07b" },
  { tag: [tags.comment, tags.meta], color: "#8e95a1" },
]);
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--workbench-ink)", backgroundColor: "var(--workbench-bg)", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--workbench-mono)", lineHeight: "22px" },
  ".cm-content": { padding: "0 0 36px", caretColor: "var(--workbench-ink)", minWidth: "0" },
  ".cm-line": { padding: "0 14px 0 3px" },
  ".cm-gutters": { backgroundColor: "var(--workbench-bg)", color: "var(--workbench-muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "31px", padding: "0 7px 0 6px" },
  ".cm-foldGutter": { width: "9px", opacity: ".5" },
  ".cm-activeLineGutter": { backgroundColor: "var(--workbench-hover)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--workbench-selection)" },
  ".cm-cursor": { borderLeftColor: "var(--workbench-ink)" },
  ".cm-panels": { backgroundColor: "var(--workbench-bg)", color: "var(--workbench-ink)", borderColor: "var(--workbench-border)" },
  ".cm-search": { fontFamily: "var(--workbench-sans)", padding: "8px", fontSize: "12px" },
  ".cm-textfield": { background: "var(--workbench-bg)", color: "var(--workbench-ink)", border: "1px solid var(--workbench-border)", borderRadius: "5px" },
  ".cm-button": { background: "var(--workbench-hover)", color: "var(--workbench-ink)", border: "1px solid var(--workbench-border)", borderRadius: "5px" },
});
const chinesePhrases = {
  "Find": "查找", "Replace": "替换", "next": "下一个", "previous": "上一个", "all": "全部",
  "match case": "区分大小写", "regexp": "正则表达式", "by word": "全字匹配", "replace": "替换",
  "replace all": "替换全部", "close": "关闭", "Go to line": "转到行", "go": "跳转", "Search:": "查找：",
};

export function CodeEditor({ documentId, path, value, readOnly = false, wrap = true, colorScheme = "light", active = true, location, onChange, onSave, ref }: {
  documentId: string;
  path: string;
  value: string;
  readOnly?: boolean;
  wrap?: boolean;
  colorScheme?: WorkbenchColorScheme;
  active?: boolean;
  location?: SourceLocation;
  onChange?(content: string): void;
  onSave?(): void;
  ref?: Ref<CodeEditorHandle>;
}) {
  const { locale } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const initial = useRef({ value, readOnly, wrap, colorScheme, locale });
  initial.current = { value, readOnly, wrap, colorScheme, locale };
  const compartments = useRef({ language: new Compartment(), writable: new Compartment(), wrapping: new Compartment(), syntax: new Compartment(), phrases: new Compartment() });
  const reveal = (target: SourceLocation) => {
    const editor = view.current;
    if (!editor) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, target.line)));
    const from = Math.min(line.to, line.from + Math.max(0, (target.column ?? 1) - 1));
    const end = target.endLine ? editor.state.doc.line(Math.max(1, Math.min(editor.state.doc.lines, target.endLine))).to : from;
    editor.dispatch({ selection: EditorSelection.single(from, Math.max(from, end)), effects: EditorView.scrollIntoView(from, { y: "center" }) });
  };
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus(), reveal, getValue: () => view.current?.state.sliceDoc() ?? initial.current.value }));

  useEffect(() => {
    if (!host.current) return;
    const config = initial.current;
    const parts = compartments.current;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: config.value, extensions: [
        lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), foldGutter(), highlightSelectionMatches(),
        keymap.of([{ key: "Mod-s", run: () => { callbacks.current.onSave?.(); return true; } }, { key: "Mod-g", run: gotoLine }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        theme,
        parts.wrapping.of(config.wrap ? EditorView.lineWrapping : []),
        parts.writable.of([EditorState.readOnly.of(config.readOnly), EditorView.editable.of(!config.readOnly)]),
        parts.syntax.of(syntaxHighlighting(config.colorScheme === "dark" ? darkSyntax : syntax)),
        parts.phrases.of(EditorState.phrases.of(config.locale === "zh" ? chinesePhrases : {})),
        parts.language.of([]),
        EditorState.lineSeparator.of(config.value.includes("\r\n") ? "\r\n" : "\n"),
        EditorView.contentAttributes.of({ "aria-label": path, spellcheck: "false" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && update.transactions.some((transaction) => !transaction.annotation(Transaction.remote))) {
            callbacks.current.onChange?.(update.state.sliceDoc());
          }
        }),
      ] }),
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [documentId]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.sliceDoc() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
  }, [value, documentId]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const parts = compartments.current;
    editor.dispatch({ effects: [
      parts.writable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      parts.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
      parts.syntax.reconfigure(syntaxHighlighting(colorScheme === "dark" ? darkSyntax : syntax)),
      parts.phrases.reconfigure(EditorState.phrases.of(locale === "zh" ? chinesePhrases : {})),
    ] });
  }, [readOnly, wrap, colorScheme, locale, documentId]);

  useEffect(() => {
    let disposed = false;
    const editor = view.current;
    void import("@codemirror/language-data").then(async ({ languages }) => {
      const language = LanguageDescription.matchFilename(languages, path);
      const support = language ? await language.load() : [];
      if (!disposed && editor === view.current) editor?.dispatch({ effects: compartments.current.language.reconfigure(support) });
    }).catch(() => { /* Unknown languages remain editable as plain text. */ });
    return () => { disposed = true; };
  }, [documentId, path]);
  useEffect(() => { if (active) view.current?.requestMeasure(); }, [active, wrap]);
  useEffect(() => { if (location) reveal(location); }, [documentId, location?.line, location?.column, location?.endLine]);
  return <div className="workbench-code-editor" ref={host} data-document-id={documentId} />;
}
