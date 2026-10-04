import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCapturedCredentialSecret,
  openEntryShare,
  parseEntryShareFragment,
} from '@palladin/crypto';
import { EntryActions } from './entry-actions';
import type { Protocol2VaultClient } from '../vault/protocol2/client';
import { WorkspaceError, type WorkspaceOperation } from './service';
import type { CreateEntryShareInput } from '../../shared/workspace/contracts';

const cryptoMocks = vi.hoisted(() => ({
  openVaultProjection: vi.fn(),
  openCurrentMemberSecret: vi.fn(),
  buildCanonicalGrantEnvelope: vi.fn(),
  openEncryptedReason: vi.fn(),
}));
vi.mock('@palladin/crypto', async (original) => ({
  ...(await original<typeof import('@palladin/crypto')>()),
  ...cryptoMocks,
}));
const vaultId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const shareId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const agentId = '66666666-6666-4666-8666-666666666666';
const grantId = '77777777-7777-4777-8777-777777777777';
const command = {
  type: 'workspace/create-share' as const,
  vaultId,
  entryId,
  operationId: shareId,
  hours: 24 as const,
  maximumReceipts: null,
  recipientEmail: null,
  protection: 'none' as const,
  protectionSecret: null,
  notifyOnFirstReceipt: false,
};
const source = createCapturedCredentialSecret({
  label: 'Synthetic entry',
  username: 'synthetic',
  password: 'synthetic-password',
  url: 'https://example.test',
  urlDomain: 'example.test',
});

function setup() {
  const vault = {
    id: vaultId,
    organizationId,
    memberKeyGeneration: 1,
    currentKeyEpoch: { agentMessageKeyVersion: 1 },
    vaultPrivateKeys: [],
  };
  const detail = {
    id: entryId,
    vaultId,
    organizationId,
    currentRevision: '4',
    entryKey: {},
    memberSecret: {},
    deliveryPolicy: 'standard',
  };
  const client = {
    getVault: vi.fn(async () => vault),
    getEntry: vi.fn(async () => detail),
  };
  const key = new Uint8Array(32).fill(4);
  cryptoMocks.openVaultProjection.mockImplementation(async () => ({
    vaultKey: key.slice(),
  }));
  cryptoMocks.openCurrentMemberSecret.mockResolvedValue(source);
  cryptoMocks.openEncryptedReason.mockResolvedValue(
    'Synthetic approved purpose',
  );
  cryptoMocks.buildCanonicalGrantEnvelope.mockResolvedValue({
    ciphertext: 'synthetic-ciphertext',
  });
  const actions = new EntryActions({
    data: { revealCurrentEntry: vi.fn(async () => source) },
    client: client as unknown as Pick<
      Protocol2VaultClient,
      'getVault' | 'getEntry'
    >,
    webUrl: 'https://web.example.test',
    session: {
      getUserId: async () => userId,
      getPrivateKey: () => key,
      getAccessToken: async () => 'test-token',
      refreshAccessToken: async () => null,
    },
  });
  const request = vi.fn<WorkspaceOperation['request']>(async (path) =>
    path.endsWith('/creation-challenge')
      ? { shareId, sourceRevision: '4', expiresAt: '2030-01-01T00:00:00Z' }
      : null,
  );
  const operation: WorkspaceOperation = {
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
    request,
  };
  return { actions, operation, request, client, detail };
}

beforeEach(() => vi.resetAllMocks());
describe('encrypted workspace operations', () => {
  it('shares interoperable ciphertext and puts the decryption key only in the link fragment', async () => {
    const { actions, operation, request } = setup();
    const result = await actions.handle(command, operation);
    if (!result?.ok || !result.data || !('url' in result.data))
      throw new Error('Expected link');
    const posted = request.mock.calls.find((call) =>
      call[0].endsWith('/sharing'),
    )?.[2] as CreateEntryShareInput;
    expect(JSON.stringify(posted)).not.toContain(source.content.password);
    expect(JSON.stringify(posted)).not.toContain(source.memberLabel);
    const url = new URL(result.data.url);
    expect(url.search).toBe('');
    const secrets = parseEntryShareFragment(url.hash);
    expect(JSON.stringify(posted)).not.toContain(
      new URLSearchParams(url.hash.slice(1)).get('key'),
    );
    const snapshot = await openEntryShare(
      posted,
      {
        organizationId,
        vaultId,
        entryId,
        shareId,
        sourceRevision: '4',
        expiresAt: posted.expiresAt,
      },
      shareId,
      secrets.key,
    );
    expect(
      snapshot.fields.find((field) => field.id === 'credential.password')
        ?.value,
    ).toBe(source.content.password);
  });

  it('retries an uncertain create with the identical challenge and encrypted payload', async () => {
    const { actions, operation, request } = setup();
    let fail = true;
    request.mockImplementation(async (path) => {
      if (path.endsWith('/creation-challenge'))
        return { shareId, sourceRevision: '4' };
      if (fail) {
        fail = false;
        throw new Error('Lost response');
      }
      return null;
    });
    await expect(actions.handle(command, operation)).rejects.toThrow(
      'Lost response',
    );
    const first = request.mock.calls[1]?.[2];
    await actions.handle(command, operation);
    expect(
      request.mock.calls.filter((call) =>
        call[0].endsWith('/creation-challenge'),
      ),
    ).toHaveLength(1);
    expect(request.mock.calls[2]?.[2]).toEqual(first);
  });

  it('does not encrypt a substituted Entry or Vault coordinate', async () => {
    const { actions, operation, client, detail } = setup();
    client.getEntry.mockResolvedValue({ ...detail, vaultId: organizationId });
    await expect(actions.handle(command, operation)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(cryptoMocks.openCurrentMemberSecret).not.toHaveBeenCalled();
    expect(operation.request).not.toHaveBeenCalled();
  });

  it('does not post after the session changes during decryption', async () => {
    const { actions, operation, request } = setup();
    let locked = false;
    operation.assertCurrent = () => {
      if (locked) throw new WorkspaceError('locked');
    };
    cryptoMocks.openCurrentMemberSecret.mockImplementation(async () => {
      locked = true;
      return source;
    });
    await expect(actions.handle(command, operation)).rejects.toMatchObject({
      code: 'locked',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('projects concealed values as masks until an explicit field request', async () => {
    const { actions, operation, client } = setup();
    const result = await actions.handle(
      { type: 'workspace/detail', vaultId, entryId },
      operation,
    );
    expect(JSON.stringify(result)).not.toContain(source.content.password);
    expect(client.getVault).not.toHaveBeenCalled();
    expect(client.getEntry).not.toHaveBeenCalled();
    expect(
      await actions.handle(
        {
          type: 'workspace/field',
          vaultId,
          entryId,
          fieldId: 'credential.password',
        },
        operation,
      ),
    ).toEqual({ ok: true, data: { value: source.content.password } });
  });

  it('rejects approval after the reviewed Entry changed and never builds an envelope', async () => {
    const { actions, operation, request } = setup();
    request.mockResolvedValue({
      id: grantId,
      vaultId,
      entryId,
      agentId,
      type: 'granular',
      methods: 'Inject',
    });
    await expect(
      actions.handle(
        {
          type: 'workspace/approve-grant',
          vaultId,
          grantId,
          entryId,
          revision: '3',
          methods: 4,
          fields: ['credential.password'],
          selection: 'selected',
          policy: { kind: 'uses', queryLimit: 1 },
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(cryptoMocks.buildCanonicalGrantEnvelope).not.toHaveBeenCalled();
    expect(request.mock.calls.some((call) => call[1] === 'PUT')).toBe(false);
  });

  it('binds approval to the authoritative request, reviewed revision, fields, methods and policy', async () => {
    const { actions, operation, request } = setup();
    const scope = {
      organizationId,
      vaultId,
      entryId,
      grantOrRequestId: grantId,
      agentId,
      memberId: null,
    };
    const reason = {
      descriptor: {
        protocolVersion: 2,
        cryptoSuiteId: 'palladin-vault-xchacha-v1',
        purpose: 'encryptedReason',
        scope,
        resourceRevision: '1',
        keyVersion: 1,
        memberKeyGeneration: 1,
        binding: {
          wrapperSuiteId: 'palladin-x25519-sealed-box-v1',
          recipientKeyVersion: 1,
          recipientKeyFingerprint: 'AA',
          requestedMethods: 4,
        },
      },
      encodedSuitePayload: 'AA',
      agentSignature: 'AA',
      wrappedReasonDek: {
        descriptor: {
          protocolVersion: 2,
          wrapperSuiteId: 'palladin-x25519-sealed-box-v1',
          purpose: 'reasonDek',
          scope,
          resourceRevision: '1',
          wrappedKeyVersion: 1,
          memberKeyGeneration: 1,
          recipientKeyKind: 'vaultMessageX25519',
          recipientKeyVersion: 1,
          recipientFingerprint: 'AA',
          parentDescriptorHash: 'AA',
        },
        encodedSealedKeyPackage: 'AA',
      },
    };
    request.mockImplementation(async (path) =>
      path.endsWith(`/grants/${grantId}`)
        ? {
            id: grantId,
            vaultId,
            entryId,
            agentId,
            type: 'granular',
            methods: 'Inject',
            encryptedReason: reason,
            agentSigningPublicKey: 'AA',
            agentSigningKeyVersion: 1,
            agentSigningKeyFingerprint: 'AA',
          }
        : path.endsWith(`/agents/${agentId}`)
          ? { agentId, publicKey: 'AA', recipientKeyVersion: 3, accessEpoch: 2 }
          : path.endsWith(`/entries/${entryId}`)
            ? { currentRevision: '4' }
            : null,
    );
    const approval = {
      type: 'workspace/approve-grant' as const,
      vaultId,
      grantId,
      entryId,
      revision: '4',
      methods: 4,
      fields: ['credential.password'],
      selection: 'selected' as const,
      policy: { kind: 'uses' as const, queryLimit: 3 },
    };
    expect(await actions.handle(approval, operation)).toEqual({
      ok: true,
      data: null,
    });
    expect(cryptoMocks.openEncryptedReason.mock.calls[0]?.[4]).toEqual({
      organizationId,
      vaultId,
      entryId,
      grantId,
      agentId,
    });
    expect(cryptoMocks.buildCanonicalGrantEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        vaultId,
        entryId,
        grantId,
        agentId,
        entryRevision: '4',
        approvedMethods: 4,
        approvedFieldIds: ['credential.password'],
        recipientKeyVersion: 3,
        remainingUses: 3,
      }),
    );
    expect(request).toHaveBeenLastCalledWith(
      `/api/vaults/${vaultId}/grants/${grantId}/approve`,
      'PUT',
      expect.objectContaining({
        methods: 'Inject',
        queryLimit: 3,
        fieldSelectionMode: 'selected',
      }),
    );
    request.mockClear();
    cryptoMocks.openEncryptedReason.mockRejectedValue(
      new Error('Signature invalid'),
    );
    await expect(actions.handle(approval, operation)).rejects.toThrow(
      'Signature invalid',
    );
    expect(request.mock.calls.some((call) => call[1] === 'PUT')).toBe(false);
  });

  it('does not expand the methods requested by the agent', async () => {
    const { actions, operation, request } = setup();
    request.mockResolvedValue({
      id: grantId,
      vaultId,
      entryId,
      agentId,
      type: 'granular',
      methods: 'Inject',
    });
    await expect(
      actions.handle(
        {
          type: 'workspace/approve-grant',
          vaultId,
          grantId,
          entryId,
          revision: '4',
          methods: 5,
          fields: ['credential.password'],
          selection: 'selected',
          policy: { kind: 'lifetime' },
        },
        operation,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(cryptoMocks.buildCanonicalGrantEnvelope).not.toHaveBeenCalled();
  });
});
