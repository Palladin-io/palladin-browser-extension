import type { GeneratorHistoryCommand, GeneratorHistoryResult } from '@shared/messaging/generator-history';

export async function historyCommand(command: GeneratorHistoryCommand): Promise<Extract<GeneratorHistoryResult, { ok: true }>> {
  const result: GeneratorHistoryResult = await chrome.runtime.sendMessage(command);
  if (!result?.ok) throw new Error(result?.code ?? 'unavailable');
  return result;
}
