import { GENERATOR_SUGGESTIONS_KEY } from '@shared/messaging/capture';

export async function generatorSuggestionsEnabled(): Promise<boolean> {
  return (await chrome.storage.local.get(GENERATOR_SUGGESTIONS_KEY))[GENERATOR_SUGGESTIONS_KEY] !== false;
}
