const mediaTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip",
  gz: "application/gzip", wasm: "application/wasm", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown", json: "application/json",
};
export function fileMediaType(path: string): string {
  const name = path.split("/").at(-1) ?? ""; const dot = name.lastIndexOf(".");
  return mediaTypes[dot > 0 ? name.slice(dot + 1).toLowerCase() : ""] ?? "application/octet-stream";
}
export function filePreviewKind(path: string, mediaType = fileMediaType(path)): "image" | "markdown" | "html" | undefined {
  return mediaType.startsWith("image/") ? "image" : mediaType === "text/html" ? "html" : mediaType === "text/markdown" ? "markdown" : undefined;
}
export function formatFileSize(bytes: number): string {
  const unit = bytes >= 1024 ** 3 ? "GiB" : bytes >= 1024 ** 2 ? "MiB" : bytes >= 1024 ? "KiB" : "B";
  const divisor = unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : unit === "KiB" ? 1024 : 1;
  return `${Number((bytes / divisor).toFixed(2))} ${unit}`;
}
