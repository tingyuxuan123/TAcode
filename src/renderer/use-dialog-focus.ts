import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createImeGuard } from "./ime";

type DialogEntry = { root: HTMLElement; opener: HTMLElement | null; lastFocus?: HTMLElement };
const dialogs: DialogEntry[] = [];
const inertElements = new Map<HTMLElement, boolean>();
const focusableSelector = "button, input:not([type=hidden]), select, textarea, a[href], [tabindex], [contenteditable=true]";

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((node) =>
    node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[inert]") && node.getClientRects().length > 0,
  );
}

function focusInside(entry: DialogEntry) {
  const nodes = focusable(entry.root);
  const target = entry.lastFocus && nodes.includes(entry.lastFocus) ? entry.lastFocus
    : nodes.find((node) => node.hasAttribute("data-dialog-autofocus")) ?? nodes[0]
      ?? entry.root.querySelector<HTMLElement>("[role=dialog]") ?? entry.root;
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function updateInert() {
  for (const [element, previous] of inertElements) element.inert = previous;
  inertElements.clear();
  // A nested editor may live inside the settings form. Only its siblings and
  // its ancestors' siblings become inert; never disable an ancestor of it.
  let current: HTMLElement | undefined = dialogs.at(-1)?.root;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || child === current) continue;
      inertElements.set(child, child.inert);
      child.inert = true;
    }
    current = parent;
  }
}

/** Shared modal focus/keyboard boundary, including nested and portal dialogs. */
export function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // Capture before React autoFocus moves focus during the mount commit.
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const entryRef = useRef<DialogEntry | null>(null);
  const ime = useRef(createImeGuard());

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const entry: DialogEntry = { root, opener: opener.current };
    entryRef.current = entry;
    const descendant = dialogs.findIndex((candidate) => root.contains(candidate.root));
    if (descendant < 0) dialogs.push(entry);
    else dialogs.splice(descendant, 0, entry);
    updateInert();
    if (dialogs.at(-1) === entry && !root.contains(document.activeElement)) focusInside(entry);
    const onFocus = (event: FocusEvent) => {
      if (dialogs.at(-1) !== entry) return;
      if (event.target instanceof HTMLElement && root.contains(event.target)) entry.lastFocus = event.target;
      else focusInside(entry);
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      dialogs.splice(dialogs.indexOf(entry), 1);
      entryRef.current = null;
      updateInert();
      queueMicrotask(() => {
        // StrictMode may already have mounted this dialog again.
        if (entryRef.current) return;
        const top = dialogs.at(-1);
        if (entry.opener?.isConnected && !entry.opener.closest("[inert]") && (!top || top.root.contains(entry.opener))) {
          entry.opener.focus({ preventScroll: true });
        } else if (top && !top.root.contains(document.activeElement)) focusInside(top);
      });
    };
  }, []);

  return {
    ref,
    onCompositionStartCapture: () => { ime.current.start(); },
    onCompositionEndCapture: () => { ime.current.end(); },
    onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => {
      if (dialogs.at(-1) !== entryRef.current || !ime.current.handles(event.nativeEvent)) return;
      // Keep a composing Enter/Escape away from child shortcuts and implicit
      // form submission (including macOS's Enter just after compositionend).
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();
      if (dialogs.at(-1) !== entryRef.current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab" && ref.current) {
        const nodes = focusable(ref.current);
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)
          || !nodes.includes(document.activeElement as HTMLElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
      }
    },
  };
}
