import { expect, it } from 'vitest';
import { generateInlinePassphrase } from './inline-passphrase';
import { isGeneratorPreviewCommand, isInlineGeneratorOptions, GENERATOR_PREVIEW_CHANNEL } from '../messaging/capture';

it('generates the actual approved three-to-six word previews without changing generic policy', () => {
  for (const words of [3, 4, 5, 6]) {
    for (const separator of ['-', ' ', '.'] as const) {
      const options = { mode: 'passphrase', words, separator, capitalize: false, includeNumber: false } as const;
      expect(isGeneratorPreviewCommand({ channel: GENERATOR_PREVIEW_CHANNEL, type: 'preview', documentId: 'document_0123456789abcdef', candidateId: 'candidate_0123456789abcdef', options })).toBe(true);
      const value = generateInlinePassphrase(options);
      expect(value.split(separator).length).toBe(words);
      expect(value.split(separator).every(word => /^[a-z]+$/.test(word))).toBe(true);
    }
  }
  expect(isInlineGeneratorOptions({ mode: 'passphrase', words: 3, separator: '-', capitalize: false, includeNumber: false })).toBe(false);
});
