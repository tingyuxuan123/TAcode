/// <reference types="vite/client" />
import type { DesktopApi } from "../shared/types";

declare global {
  interface Window {
    harness: DesktopApi;
  }
}

// Electron <webview> tag (host renderer needs webviewTag: true).
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        preload?: string;
        /** Must be a string (React drops unknown boolean attributes). */
        webpreferences?: string;
        partition?: string;
      };
    }
  }
}

export {};
