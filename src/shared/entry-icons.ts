export const ENTRY_GLYPHS = ["vpn_key", "lock", "badge", "security", "fingerprint", "password", "enhanced_encryption", "language", "public", "cloud", "cloud_upload", "api", "person", "people", "favorite", "star", "email", "chat", "phone", "forum", "notifications", "database", "folder", "storage", "archive", "code", "terminal", "extension", "devices", "smartphone", "credit_card", "wallet", "payments", "currency_bitcoin", "work", "business", "settings", "home", "bookmark", "label", "category", "school"] as const;
export const ENTRY_COLORS = ["#8A95A6", "#E54645", "#FFAB87", "#10B981", "#60A5FA", "#A78BFA"] as const;

export function validEntryPresentation(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.color !== undefined && (typeof entry.color !== "string" || !/^#[0-9a-f]{6}$/i.test(entry.color))) return false;
  if (entry.icon === undefined) return true;
  return typeof entry.icon === "string" && (ENTRY_GLYPHS.some(glyph => glyph === entry.icon)
    || /^public-asset:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.icon));
}
