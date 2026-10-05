import { expect, it, vi } from 'vitest';
vi.mock('./build-target', () => ({ extensionBuildTarget: 'safari' }));
import { connectionOrigins, parseConnection } from './connection';

it('requests host-only Safari patterns while preserving the exact HTTP API/panel ports', () => {
  const connection = parseConnection({ name: 'Own', apiUrl: 'http://127.0.0.1:55083/api', webUrl: 'http://127.0.0.1:55189', allowHttp: true, sharedUnlockEnabled: true })!;
  expect(connectionOrigins(connection)).toEqual(['http://127.0.0.1/*']);
  expect(connection.apiUrl).toBe('http://127.0.0.1:55083/api');
  expect(connection.webUrl).toBe('http://127.0.0.1:55189');
});
it('preserves bracketed IPv6 host patterns', () => {
  const connection = parseConnection({ name: 'Own', apiUrl: 'http://[::1]:55083', webUrl: 'https://panel.example.test:8443', allowHttp: true, sharedUnlockEnabled: true })!;
  expect(connectionOrigins(connection)).toEqual(['http://[::1]/*', 'https://panel.example.test/*']);
});
