/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Firebase Web App apiKey — injected by the orchestrator at integration. */
  readonly VITE_FB_API_KEY?: string;
  /** Firebase Web App appId — injected by the orchestrator at integration. */
  readonly VITE_FB_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
