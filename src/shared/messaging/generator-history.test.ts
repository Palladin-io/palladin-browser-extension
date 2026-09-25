import { describe, expect, it } from 'vitest';
import { isGeneratorHistoryCommand } from './generator-history';
import { GENERATE_PASSWORD_CHANNEL, isGeneratePasswordCommand } from './capture';

describe('generator independent messaging boundary', () => {
  it('accepts only the typed bounded popup commands', () => {
    expect(isGeneratorHistoryCommand({ type: 'generator-history/list' })).toBe(true);
    expect(isGeneratorHistoryCommand({ type: 'generator-history/remember', value: 'synthetic-password' })).toBe(true);
    expect(isGeneratorHistoryCommand({ type: 'generator-history/remember', value: 'x'.repeat(4097) })).toBe(false);
    expect(isGeneratorHistoryCommand({ type: 'generator-history/list', accountId: 'other' })).toBe(false);
    expect(isGeneratorHistoryCommand({ type: 'generator-history/reveal', id: '../../other' })).toBe(false);
  });
  it('allows content to request generation without choosing the value or origin', () => {
    const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: 'document_0123456789abcdef',
      candidateId: 'candidate_0123456789abcdef', operationId: 'operation_0123456789abcdef' };
    expect(isGeneratePasswordCommand(command)).toBe(true);
    expect(isGeneratePasswordCommand({ ...command, value: 'page-selected-password' })).toBe(false);
    expect(isGeneratePasswordCommand({ ...command, origin: 'https://other.example.test' })).toBe(false);
    expect(isGeneratePasswordCommand({ ...command, operationId: '' })).toBe(false);
  });
});
