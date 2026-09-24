import type { HistoryItem } from '../../background/generator/history';

export type GeneratorHistoryCommand =
  | { readonly type: 'generator-history/list' | 'generator-history/clear' }
  | { readonly type: 'generator-history/reveal' | 'generator-history/remove'; readonly id: string }
  | { readonly type: 'generator-history/remember'; readonly value: string };

export type GeneratorHistoryResult =
  | { readonly ok: true; readonly items?: HistoryItem[]; readonly value?: string }
  | { readonly ok: false; readonly code: 'locked' | 'full' | 'unavailable' };

export function isGeneratorHistoryCommand(value: unknown): value is GeneratorHistoryCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'generator-history/list':
    case 'generator-history/clear': return Object.keys(record).length === 1;
    case 'generator-history/reveal':
    case 'generator-history/remove': return Object.keys(record).length === 2
      && typeof record.id === 'string' && /^[0-9a-f-]{36}$/.test(record.id);
    case 'generator-history/remember': return Object.keys(record).length === 2
      && typeof record.value === 'string' && record.value.length >= 8 && record.value.length <= 4096;
    default: return false;
  }
}
