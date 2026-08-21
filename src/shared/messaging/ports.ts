/** Named channels for the chrome.runtime Port between content scripts and the service worker. */
export const CONTENT_PORT = "palladin.content" as const;
export const SESSION_LIVENESS_PORT = "palladin.session-liveness" as const;

export type PortName = typeof CONTENT_PORT | typeof SESSION_LIVENESS_PORT;
