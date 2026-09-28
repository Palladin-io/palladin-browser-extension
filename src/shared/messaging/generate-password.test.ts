import { expect, it } from 'vitest';
import { GENERATE_PASSWORD_CHANNEL, isGeneratePasswordCommand } from './capture';

it('allows content to request generation without choosing the value or origin', () => {
  const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: 'document_0123456789abcdef',
    candidateId: 'candidate_0123456789abcdef', operationId: 'operation_0123456789abcdef' };
  expect(isGeneratePasswordCommand(command)).toBe(true);
  expect(isGeneratePasswordCommand({ ...command, value: 'page-selected-password' })).toBe(false);
  expect(isGeneratePasswordCommand({ ...command, origin: 'https://other.example.test' })).toBe(false);
  expect(isGeneratePasswordCommand({ ...command, operationId: '' })).toBe(false);
});
