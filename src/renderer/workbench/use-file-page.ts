import { useEffect, useRef, useState } from "react";
import { DOCUMENT_PAGE_BYTES, type FileDocument, type FileFailure } from "../../shared/files";

export function useFilePage(base: FileDocument | undefined, active: boolean, initialOffset: number | undefined, onOffset: (offset: number) => void) {
  const [offset, setOffset] = useState(initialOffset ?? 0); const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ offset: number; document: FileDocument }>(); const [loading, setLoading] = useState(false); const [error, setError] = useState<FileFailure>();
  const cache = useRef(new Map<string, FileDocument>()); const history = useRef<number[]>([]);
  const large = base?.status === "truncated";
  const target = large ? Math.min(offset, Math.max(0, base.metadata.size - 1)) : 0;
  useEffect(() => {
    if (!base || !large || !active) return;
    let disposed = false; const key = JSON.stringify([base.projectRoot, base.path, base.version, target]);
    setError(undefined);
    if (target === 0) { setPage({ offset: target, document: base }); setLoading(false); return; }
    const cached = cache.current.get(key);
    if (cached && !retry) { setPage({ offset: target, document: cached }); setLoading(false); return; }
    setLoading(true);
    void window.harness.files.readDocument({ projectRoot: base.projectRoot, path: base.path, offset: target, length: DOCUMENT_PAGE_BYTES, expectedVersion: base.version }).then((result) => {
      if (disposed) return;
      if (result.kind === "error") { setError(result.error); return; }
      cache.current.set(key, result); while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
      setPage({ offset: target, document: result });
    }, (error) => { if (!disposed) setError({ code: "failed", message: String(error) }); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [base?.projectRoot, base?.path, base?.version, active, large, target, retry]);
  const go = (value: number, remember = true) => {
    if (!Number.isSafeInteger(value) || value < 0 || !base || value >= base.metadata.size || value === target) return;
    if (remember) history.current.push(target);
    if (history.current.length > 100) history.current.shift();
    setLoading(true); setError(undefined);
    setOffset(value); onOffset(value); setRetry(0);
  };
  const document = !large || target === 0 ? base : page?.offset === target ? page.document : undefined;
  return { document, offset: target, loading, error, go,
    previous: () => go(history.current.pop() ?? Math.max(0, target - DOCUMENT_PAGE_BYTES), false),
    retry: () => setRetry((value) => value + 1) };
}
