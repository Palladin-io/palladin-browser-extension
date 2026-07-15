/**
 * Value-free service-worker logger.
 *
 * SECURITY: passwords, keys, tokens, and mnemonics must never reach the console.
 * The logger accepts only a static message plus an optional flat metadata object,
 * and it redacts any field whose KEY looks sensitive before anything is printed —
 * a defence-in-depth backstop for the caller's own discipline. It never accepts
 * `Uint8Array`/binary values (the type forbids them), so raw key material cannot
 * be stringified into a log line even by mistake.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Primitive, non-secret metadata values. Deliberately excludes binary buffers. */
export type LogValue = string | number | boolean | null;
export type LogMeta = Readonly<Record<string, LogValue>>;

/** Placeholder substituted for any value stored under a sensitive-looking key. */
export const REDACTED = "[redacted]";

// Substring match on the field name — catches password, authHash, masterKey,
// privateKey, accessToken, refreshToken, secret, mnemonic, recoveryCode, etc.
const SENSITIVE_KEY = /pass|secret|token|key|hash|mnemonic|recovery|seed|cipher|nonce/i;

export function redactMeta(meta: LogMeta): Record<string, LogValue> {
  const safe: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(meta)) {
    safe[key] = SENSITIVE_KEY.test(key) ? REDACTED : value;
  }
  return safe;
}

type Sink = (level: LogLevel, line: string, meta?: Record<string, LogValue>) => void;

const consoleSink: Sink = (level, line, meta) => {
  const prefixed = `[palladin] ${line}`;
  if (meta && Object.keys(meta).length > 0) console[level](prefixed, meta);
  else console[level](prefixed);
};

function emit(sink: Sink, level: LogLevel, message: string, meta?: LogMeta): void {
  sink(level, message, meta ? redactMeta(meta) : undefined);
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

/** Build a logger over a custom sink — used by tests to capture output. */
export function createLogger(sink: Sink = consoleSink): Logger {
  return {
    debug: (message, meta) => emit(sink, "debug", message, meta),
    info: (message, meta) => emit(sink, "info", message, meta),
    warn: (message, meta) => emit(sink, "warn", message, meta),
    error: (message, meta) => emit(sink, "error", message, meta),
  };
}

export const logger: Logger = createLogger();
