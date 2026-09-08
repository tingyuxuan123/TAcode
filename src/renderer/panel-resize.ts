interface PanelResizeStart {
  pointerId: number;
  button: number;
  isPrimary: boolean;
  clientX: number;
  preventDefault(): void;
}

/** A resize gesture must end even when an embedded webview swallowed pointerup. */
export function startPanelResize(
  handle: HTMLElement,
  event: PanelResizeStart,
  onMove: (clientX: number) => void,
  onFinish: () => void,
): () => void {
  if (event.button !== 0 || event.isPrimary === false) return () => {};
  const doc = handle.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  event.preventDefault();
  const pointerId = event.pointerId;
  const previousCursor = doc.body.style.cursor;
  const previousSelection = doc.body.style.userSelect;
  const alreadyResizing = doc.documentElement.classList.contains("is-resizing-panel");
  let active = true;
  const capture = { capture: true };

  const finish = () => {
    if (!active) return;
    active = false;
    win.removeEventListener("pointermove", move, capture);
    win.removeEventListener("pointerup", endPointer, capture);
    win.removeEventListener("pointercancel", endPointer, capture);
    win.removeEventListener("blur", finish);
    handle.removeEventListener("lostpointercapture", endPointer);
    doc.removeEventListener("visibilitychange", visibilityChanged);
    try {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {
      // The handle may already have been removed during unmount.
    }
    if (!alreadyResizing) doc.documentElement.classList.remove("is-resizing-panel");
    doc.body.style.cursor = previousCursor;
    doc.body.style.userSelect = previousSelection;
    onFinish();
  };
  const endPointer = (pointer: PointerEvent) => {
    if (pointer.pointerId === pointerId) finish();
  };
  const visibilityChanged = () => { if (doc.hidden) finish(); };
  const move = (pointer: PointerEvent) => {
    if (!active || pointer.pointerId !== pointerId) return;
    // Check before changing width: a missed release must not cause even one extra jump.
    if ((pointer.buttons & 1) === 0) { finish(); return; }
    pointer.preventDefault();
    onMove(pointer.clientX);
  };

  doc.body.style.cursor = "col-resize";
  doc.body.style.userSelect = "none";
  doc.documentElement.classList.add("is-resizing-panel");
  win.addEventListener("pointermove", move, capture);
  win.addEventListener("pointerup", endPointer, capture);
  win.addEventListener("pointercancel", endPointer, capture);
  win.addEventListener("blur", finish);
  handle.addEventListener("lostpointercapture", endPointer);
  doc.addEventListener("visibilitychange", visibilityChanged);
  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // Window listeners plus the buttons check remain a fallback if capture is unavailable.
  }
  return finish;
}
