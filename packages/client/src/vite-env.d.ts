/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute signaling URL (wss://…). Defaults to same-origin /ws. */
  readonly VITE_SIGNALING_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
