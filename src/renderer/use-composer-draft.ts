import { useSyncExternalStore } from "react";
import { composerDrafts } from "./composer-drafts";

export function useComposerDraft(key: string) {
  const store = composerDrafts();
  useSyncExternalStore(store.subscribe, store.version);
  return { store, draft: store.get(key) };
}
