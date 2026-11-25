export const ONE_CLICK_CHANNEL = 'palladin.one-click.v1' as const;
export const ONE_CLICK_STAGES = ['entry', 'identifier', 'password', 'login', 'totp'] as const;
export type OneClickStage = typeof ONE_CLICK_STAGES[number];

interface Base { readonly channel: typeof ONE_CLICK_CHANNEL; readonly documentId: string }
export type OneClickCommand =
  | Base & { readonly type: 'start'; readonly vaultId: string; readonly entryId: string }
  | Base & { readonly type: 'resume' | 'dismiss' | 'prompt-missing' }
  | Base & { readonly type: 'step'; readonly runId: string; readonly stage: OneClickStage }
  | Base & { readonly type: 'stop'; readonly runId: string };

export interface OneClickRun {
  readonly runId: string;
  readonly vaultId: string;
  readonly entryId: string;
  readonly name: string;
  readonly username: string;
  readonly match: 'exact' | 'related';
}
export type OneClickResult =
  | { readonly status: 'run'; readonly run: OneClickRun }
  | { readonly status: 'granted' | 'idle' | 'stopped' | 'hidden' };

export function isOneClickCommand(value: unknown): value is OneClickCommand {
  if (!record(value) || value.channel !== ONE_CLICK_CHANNEL
    || typeof value.documentId !== 'string' || !/^[a-f0-9]{32}$/.test(value.documentId)) return false;
  const keys = (...extra: string[]) => Object.keys(value).every(key => ['channel', 'type', 'documentId', ...extra].includes(key));
  switch (value.type) {
    case 'start': return keys('vaultId', 'entryId') && id(value.vaultId) && id(value.entryId);
    case 'resume': case 'dismiss': case 'prompt-missing': return keys();
    case 'step': return keys('runId', 'stage') && id(value.runId) && ONE_CLICK_STAGES.some(stage => stage === value.stage);
    case 'stop': return keys('runId') && id(value.runId);
    default: return false;
  }
}

export function isOneClickResult(value: unknown): value is OneClickResult {
  if (!record(value)) return false;
  if (value.status !== 'run') return ['granted', 'idle', 'stopped', 'hidden'].includes(String(value.status)) && Object.keys(value).length === 1;
  const run = value.run;
  return record(run) && id(run.runId) && id(run.vaultId) && id(run.entryId) && typeof run.name === 'string'
    && typeof run.username === 'string' && (run.match === 'exact' || run.match === 'related');
}

function id(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 256; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
