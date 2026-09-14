import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { defaultRehypePlugins } from "streamdown";
import { File, Maximize, Minus, Plus } from "lucide-react";
import { useI18n } from "../i18n";
import { MARKDOWN_COMPONENTS, MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS } from "../ui";
import { formatFileSize } from "../../shared/file-format";
import type { FileDocument, FileHtmlPreview, ProjectPath } from "../../shared/files";
import type { ScrollPosition } from "./file-view-state";
import { WorkbenchButton } from "./controls";

export function previewResource(value: string, base: string): string {
  if (/^(?:https?:|mailto:|tel:)/i.test(value) || value.startsWith("#")) return defaultUrlTransform(value);
  try {
    const url = new URL(value, base); const project = new URL(base);
    return url.protocol === project.protocol && url.host === project.host ? url.href : "";
  } catch { return ""; }
}
export function MarkdownPreview({ body, url, position, onPosition, onOpen }: {
  body: string; url: string; position?: ScrollPosition; onPosition(position: ScrollPosition): void; onOpen(path: string, options?: { literal?: boolean }): void;
}) {
  const ref = useRef<HTMLDivElement>(null); const remembered = useRef(position ?? { top: 0, left: 0 });
  const plugins = useMemo(() => MARKDOWN_REHYPE_PLUGINS.map((plugin) => {
    if (!Array.isArray(plugin)) return plugin;
    if (plugin === defaultRehypePlugins.harden) return [plugin[0], { ...plugin[1], defaultOrigin: url }] as typeof plugin;
    if (plugin === defaultRehypePlugins.sanitize) {
      const schema = plugin[1]; const protocol = new URL(url).protocol.replace(/:$/, "");
      return [plugin[0], { ...schema, protocols: { ...schema.protocols,
        href: [...(schema.protocols?.href ?? []), protocol], src: [...(schema.protocols?.src ?? []), protocol] } }] as typeof plugin;
    }
    return plugin;
  }), [url]);
  useLayoutEffect(() => { const node = ref.current!; node.scrollTop = remembered.current.top; node.scrollLeft = remembered.current.left; }, [body]);
  const components = useMemo<Components>(() => ({ ...MARKDOWN_COMPONENTS,
    img: ({ node: _node, ...props }) => <img {...props} onLoad={() => { if (ref.current) ref.current.scrollTop = remembered.current.top; }} />,
    code: ({ node: _node, ...props }) => <code {...props} />,
    a: ({ node: _node, href, children, ...props }) => <a {...props} href={href} onClick={(event) => {
      if (!href || href.startsWith("#")) return;
      const target = new URL(href, url); const base = new URL(url);
      if (target.protocol === base.protocol && target.host === base.host) {
        event.preventDefault(); try { onOpen(decodeURIComponent(target.pathname).replace(/^\//, ""), { literal: true }); } catch { /* Invalid encoded paths remain inert. */ }
      }
    }}>{children}</a>,
  }), [url, onOpen]);
  return <div ref={ref} className="file-rendered-markdown markdown" data-file-preview="markdown" onScroll={() => {
    const node = ref.current!; remembered.current = { top: node.scrollTop, left: node.scrollLeft }; onPosition(remembered.current);
  }}><ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={plugins} components={components}
    urlTransform={(value) => previewResource(value, url)}>{body}</ReactMarkdown></div>;
}

function htmlSnapshot(body: string, token: string, position: ScrollPosition): string {
  const parsed = new DOMParser().parseFromString(body, "text/html");
  parsed.documentElement.style.overflowAnchor = "none";
  for (const node of parsed.querySelectorAll("base")) node.remove();
  // The snapshot URL retains the file path on its explicit project origin.
  const baseElement = parsed.createElement("base"); baseElement.setAttribute("href", "."); parsed.head.prepend(baseElement);
  const script = parsed.createElement("script");
  // The frame reports only reading position; it has no access to the workbench bridge.
  script.textContent = `(()=>{const token=${JSON.stringify(token)},position=${JSON.stringify(position)};
    const send=()=>parent.postMessage({type:"tacode:preview-position",token,top:scrollY,left:scrollX},"*");
    addEventListener("load",()=>requestAnimationFrame(()=>{scrollTo(position.left,position.top);send()}));
    addEventListener("scroll",send,{passive:true});})();`;
  parsed.head.prepend(script);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}
export function HtmlPreview({ request, body, url, active, position, onPosition, revision }: {
  request: ProjectPath; body: string; url: string; active: boolean; position?: ScrollPosition; onPosition(position: ScrollPosition): void; revision?: FileDocument;
}) {
  const { t } = useI18n(); const frame = useRef<HTMLIFrameElement>(null); const remembered = useRef(position ?? { top: 0, left: 0 });
  const callback = useRef(onPosition); callback.current = onPosition;
  const held = useRef<string | undefined>(undefined);
  const [preview, setPreview] = useState<FileHtmlPreview>(); const [error, setError] = useState<string>(); const [loading, setLoading] = useState(true);
  // A displayed snapshot outlives the render that replaces it: releasing it first would leave the live frame pointing at a removed snapshot.
  useEffect(() => () => { const last = held.current; held.current = undefined; if (last) void window.harness.files.releaseHtml(last).catch(() => {}); }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const token = crypto.randomUUID(); setLoading(true); setError(undefined);
    const report = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "tacode:preview-position" || event.data.token !== token) return;
      const { top, left } = event.data;
      if (![top, left].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000_000)) return;
      remembered.current = { top, left }; callback.current(remembered.current);
    };
    window.addEventListener("message", report);
    void window.harness.files.renderHtml({ ...request, html: htmlSnapshot(body, token, remembered.current) }).then((result) => {
      if (result.kind === "error") throw new Error(result.error.message);
      if (disposed) { void window.harness.files.releaseHtml(result.id).catch(() => {}); return; }
      const previous = held.current; held.current = result.id;
      setPreview(result);
      if (previous && previous !== result.id) void window.harness.files.releaseHtml(previous).catch(() => {});
    }).catch((error) => { if (!disposed) { setError(String(error)); setLoading(false); } });
    return () => { disposed = true; window.removeEventListener("message", report); };
  }, [request.projectRoot, request.path, body, url, active, revision?.version]);
  return <div className="file-html-preview" data-file-preview="html">
    {loading && <div className="file-preview-overlay" role="status">{t("preview.reading")}</div>}
    {error && <p className="file-document-notice" role="alert">{t("preview.failed")} {error}</p>}
    {/* A new snapshot always gets its own frame: re-assigning src on a live frame can drop the navigation while the old document still loads. */}
    {active && preview && <iframe key={preview.id} ref={frame} title={t("preview.title", { path: request.path })} src={preview.url}
      sandbox="allow-scripts allow-same-origin allow-forms" onLoad={() => setLoading(false)} />}
  </div>;
}
export function ImagePreview({ document, zoom: initialZoom, position, onZoom, onPosition }: {
  document: FileDocument; zoom?: number; position?: ScrollPosition; onZoom(zoom: number): void; onPosition(position: ScrollPosition): void;
}) {
  const { t } = useI18n(); const [zoom, setZoom] = useState(initialZoom ?? 0); const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [error, setError] = useState(false); const [loading, setLoading] = useState(true); const ref = useRef<HTMLDivElement>(null);
  const remembered = useRef(position ?? { top: 0, left: 0 }); const [svgUrl, setSvgUrl] = useState<string>();
  const changeZoom = (value: number) => { setZoom(value); onZoom(value); };
  useEffect(() => {
    if (document.metadata.mediaType !== "image/svg+xml" || document.status === "truncated" || document.content === null) { setSvgUrl(undefined); return; }
    const url = URL.createObjectURL(new Blob([document.content], { type: "image/svg+xml" })); setSvgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [document.content, document.metadata.mediaType, document.status]);
  const imageUrl = svgUrl ?? (document.previewUrl ? `${document.previewUrl}?version=${document.version}` : "");
  useEffect(() => { setLoading(true); setError(false); }, [imageUrl]);
  return <div className="file-image-preview" data-file-preview="image">
    <div className="file-preview-tools"><span>{document.metadata.mediaType} · {formatFileSize(document.metadata.size)}{dimensions && ` · ${dimensions.width} × ${dimensions.height}`}</span>
      <WorkbenchButton label={t("filePreview.zoomOut")} disabled={zoom !== 0 && zoom <= .25} onClick={() => changeZoom(Math.max(.25, (zoom || 1) - .25))}><Minus size={15} /></WorkbenchButton>
      <select aria-label={t("filePreview.zoom")} value={zoom} onChange={(event) => changeZoom(Number(event.target.value))}>
        <option value={0}>{t("filePreview.fit")}</option>{[.25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
      </select>
      <WorkbenchButton label={t("filePreview.zoomIn")} disabled={zoom >= 4} onClick={() => changeZoom(Math.min(4, (zoom || 1) + .25))}><Plus size={15} /></WorkbenchButton>
      <WorkbenchButton label={t("filePreview.fit")} onClick={() => changeZoom(0)}><Maximize size={15} /></WorkbenchButton>
    </div>
    <div ref={ref} className={`file-image-scroll${zoom === 0 ? " is-fit" : ""}`} onScroll={() => {
      if (loading) return; const node = ref.current!; remembered.current = { top: node.scrollTop, left: node.scrollLeft }; onPosition(remembered.current);
    }}>
      {loading && <p className="workbench-empty" role="status">{t("preview.reading")}</p>}
      {error ? <p className="workbench-empty" role="alert">{t("filePreview.imageFailed")}</p> : <img src={imageUrl} alt={document.path}
        style={zoom && dimensions ? { width: dimensions.width * zoom, height: dimensions.height * zoom } : undefined}
        onLoad={(event) => { setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoading(false);
          requestAnimationFrame(() => { if (ref.current) { ref.current.scrollTop = remembered.current.top; ref.current.scrollLeft = remembered.current.left; } }); }}
        onError={() => { setError(true); setLoading(false); }} />}
    </div>
  </div>;
}
export function BinarySummary({ document }: { document: FileDocument }) {
  const { t } = useI18n();
  return <div className="file-binary-summary" data-file-preview="binary"><File size={32} strokeWidth={1.5} />
    <p>{t(document.metadata.encoding === "invalid" ? "fileView.invalidEncoding" : "preview.binary")}</p>
    <dl><dt>{t("filePreview.type")}</dt><dd>{document.metadata.mediaType ?? "application/octet-stream"}</dd>
      <dt>{t("filePreview.size")}</dt><dd>{formatFileSize(document.metadata.size)} ({document.metadata.size.toLocaleString()} B)</dd></dl>
  </div>;
}
