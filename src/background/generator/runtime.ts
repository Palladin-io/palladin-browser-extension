import type { GeneratorHistoryCommand, GeneratorHistoryResult } from '@shared/messaging/generator-history';
import { GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';
import { initializeServerConfig, serverConfig } from '../config/server-runtime';
import { sessionManager } from '../session/runtime';
import { GeneratorHistory, GeneratorHistoryError } from './history';

export async function generatorSuggestionsEnabled(): Promise<boolean> {
  return (await chrome.storage.local.get(GENERATOR_SUGGESTIONS_KEY))[GENERATOR_SUGGESTIONS_KEY] !== false;
}

export const generatorHistory = new GeneratorHistory({
  get: keys => chrome.storage.local.get(keys),
  set: items => chrome.storage.local.set(items),
  remove: keys => chrome.storage.local.remove(keys),
}, async () => {
  await initializeServerConfig();
  const keys = sessionManager.getKeys();
  const apiUrl = serverConfig.apiUrl;
  const assertCurrent = () => {
    if (keys === null || keys !== sessionManager.getKeys() || apiUrl !== serverConfig.apiUrl) {
      throw new GeneratorHistoryError('locked');
    }
  };
  assertCurrent();
  const accountId = await sessionManager.getUserId();
  assertCurrent();
  if (accountId === null || keys === null) throw new GeneratorHistoryError('locked');
  return { accountId, apiUrl, privateKey: new Uint8Array(keys.privateKey), assertCurrent };
});

export async function handleGeneratorHistory(command: GeneratorHistoryCommand): Promise<GeneratorHistoryResult> {
  try {
    switch (command.type) {
      case 'generator-history/list': return { ok: true, items: await generatorHistory.list() };
      case 'generator-history/reveal': return { ok: true, value: await generatorHistory.reveal(command.id) };
      case 'generator-history/clear': await generatorHistory.clear(); break;
      case 'generator-history/remove': await generatorHistory.remove(command.id); break;
      case 'generator-history/remember': await generatorHistory.remember(command.value, null); break;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof GeneratorHistoryError ? error.code : 'unavailable' };
  }
}
