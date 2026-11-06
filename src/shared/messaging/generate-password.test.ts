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

it('accepts bounded password/passphrase settings and rejects values or unsupported options', () => {
  const command = { channel: GENERATE_PASSWORD_CHANNEL, documentId: 'document_0123456789abcdef',
    candidateId: 'candidate_0123456789abcdef', operationId: 'operation_0123456789abcdef' };
  expect(isGeneratePasswordCommand({ ...command, options: { mode: 'password', length: 24, digits: false, symbols: true } })).toBe(true);
  expect(isGeneratePasswordCommand({ ...command, options: { mode: 'passphrase', words: 5, separator: '-', capitalize: false, includeNumber: true } })).toBe(true);
  for (const options of [
    { mode: 'password', length: 7, digits: true, symbols: true },
    { mode: 'password', length: 65, digits: true, symbols: true },
    { mode: 'password', length: 20.5, digits: true, symbols: true },
    { mode: 'password', length: 20, digits: 'yes', symbols: true },
    { mode: 'password', length: 20, digits: true, symbols: true, value: 'chosen' },
    { mode: 'passphrase', words: 5, separator: ['-'], capitalize: false, includeNumber: true },
    { mode: 'passphrase', words: 11, separator: '-', capitalize: false, includeNumber: true },
    { mode: 'passphrase', words: 3, separator: '-', capitalize: false, includeNumber: true },
    { mode: 'passphrase', words: 5, separator: 'chosen', capitalize: false, includeNumber: true },
  ]) expect(isGeneratePasswordCommand({ ...command, options })).toBe(false);
});
