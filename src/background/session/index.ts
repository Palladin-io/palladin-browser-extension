/**
 * Public session API barrel (pure modules only — no `chrome` access). The live
 * singleton is built in {@link ./runtime}, imported directly by the worker
 * bootstrap so importing this barrel never touches `chrome`.
 */

export * from "./types";
export * from "./auto-lock";
export * from "./hooks";
export * from "./unlock-source";
export * from "./session-store";
export * from "./auth-client";
export * from "./session-manager";
export * from "./commands";
