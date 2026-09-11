/// <reference types="vite/client" />
/// <reference types="chrome" />

declare const __PALLADIN_TARGET__: "chromium" | "firefox" | "safari";
declare const __PALLADIN_CHANNEL__: "production" | "debug";

declare const __PALLADIN_SHARED_UNLOCK_ENVIRONMENTS__: readonly { apiUrl: string; webOrigin: string }[];
