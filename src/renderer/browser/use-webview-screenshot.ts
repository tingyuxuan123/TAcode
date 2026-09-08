import { useCallback, useEffect, useRef, useState } from "react";
import { captureWebviewPage } from "./capture-webview-page";

export type ScreenshotFeedback = "idle" | "success" | "error";

const FEEDBACK_RESET_MS = 1500;

/**
 * 截取当前 webview 页面为整页 PNG 并经主进程写入系统剪贴板。
 * 移植自 Snow App（MIT）useWebviewScreenshot.ts，剪贴板调用改为
 * harness.browser.writeImage（browser:write-image IPC）。
 */
export const useWebviewScreenshot = (
  webviewRef: React.RefObject<Electron.WebviewTag | null>,
): {
  isCapturing: boolean;
  feedback: ScreenshotFeedback;
  captureScreenshot: () => Promise<void>;
} => {
  const [isCapturing, setIsCapturing] = useState(false);
  const [feedback, setFeedback] = useState<ScreenshotFeedback>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const setFeedbackWithReset = useCallback((value: ScreenshotFeedback): void => {
    setFeedback(value);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    if (value !== "idle") {
      resetTimerRef.current = setTimeout(() => setFeedback("idle"), FEEDBACK_RESET_MS);
    }
  }, []);

  const captureScreenshot = useCallback(async (): Promise<void> => {
    const webview = webviewRef.current;
    if (!webview || isCapturing) return;

    setIsCapturing(true);
    try {
      const dataUrl = await captureWebviewPage(webview);
      await window.harness.browser.writeImage(dataUrl);
      setFeedbackWithReset("success");
    } catch (error) {
      console.error("Failed to capture screenshot:", error);
      setFeedbackWithReset("error");
    } finally {
      setIsCapturing(false);
    }
  }, [webviewRef, isCapturing, setFeedbackWithReset]);

  return { isCapturing, feedback, captureScreenshot };
};
