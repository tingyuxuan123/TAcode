import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BROWSER_HOMEPAGE, normalizeBrowserHomepage } from "./url";

const HOMEPAGE_KEY = "tether.browserHomepage";
const HOMEPAGE_CHANGED_EVENT = "tether:browser-homepage-changed";

// 模块级共享状态：所有浏览器实例共用同一份 homepage 缓存与全局监听，
// 多个实例不会各自重复读写 localStorage。
let cachedHomepage = readHomepage();
let globalListenerAttached = false;
const subscribers = new Set<() => void>();

function readHomepage(): string {
  try {
    const raw = localStorage.getItem(HOMEPAGE_KEY);
    if (raw === null) return DEFAULT_BROWSER_HOMEPAGE;
    return normalizeBrowserHomepage(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_HOMEPAGE;
  }
}

function writeHomepage(value: string): void {
  try {
    localStorage.setItem(HOMEPAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore private mode / quota failures.
  }
}

const notifySubscribers = (): void => {
  for (const subscriber of subscribers) subscriber();
};

const ensureGlobalListener = (): void => {
  if (globalListenerAttached) return;
  globalListenerAttached = true;
  window.addEventListener(HOMEPAGE_CHANGED_EVENT, () => {
    cachedHomepage = readHomepage();
    notifySubscribers();
  });
};

/**
 * 浏览器默认起始页：localStorage 持久化（对齐 Tether 既有 UI 偏好存储方式），
 * 模块级缓存 + 变更事件同步所有浏览器实例。
 */
export function useBrowserHomepage(): {
  homepage: string;
  /** 恒为 true：localStorage 为同步读取（保留字段以兼容原组件逻辑）。 */
  loaded: boolean;
  setHomepage: (url: string) => Promise<void>;
} {
  const [, setVersion] = useState(0);

  useEffect(() => {
    ensureGlobalListener();
    const subscriber = () => setVersion((version) => version + 1);
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const setHomepage = useCallback(async (url: string) => {
    const normalized = normalizeBrowserHomepage(url);
    writeHomepage(normalized);
    cachedHomepage = normalized;
    notifySubscribers();
    window.dispatchEvent(new Event(HOMEPAGE_CHANGED_EVENT));
  }, []);

  return { homepage: cachedHomepage, loaded: true, setHomepage };
}
