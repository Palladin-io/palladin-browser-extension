import {
  computePairingSas,
  formatSecretKey,
  fromBase64Url,
  generateAccountSecret,
  generatePairingKeyPair,
  parsePairingQr,
  sealAccountSecretForPairing,
  toBase64Url,
  type PairingEnvelope,
} from "@palladin/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthClient, type FetchLike } from "./auth-client";
import { AutoLock } from "./auto-lock";
import { SessionManager } from "./session-manager";
import { SessionStore } from "./session-store";
import {
  buildTestAccount,
  FakeAccountSecretDevice,
  FakeAlarms,
  FakeStorageArea,
  mockBackend,
  toBase64,
  type TestAccount,
} from "./test-support";
import { MasterPasswordUnlock } from "./unlock-source";

const API = "https://api.test";
const TRANSFER_ID = toBase64Url(new Uint8Array(16).fill(7));
const CHALLENGE = toBase64Url(new Uint8Array(32).fill(9));
const POLL_TOKEN = "poll-token";
const OTHER_ACCOUNT_ID = "99887766-5544-4332-8110-ffeeddccbbaa";

interface TransferBackend {
  recipientPublicKey: Uint8Array | null;
  envelope: PairingEnvelope | null;
  claimStatus: number | null;
  cancelled: string[];
}

function harness(account: TestAccount, device = new FakeAccountSecretDevice(), transfer: TransferBackend = {
  recipientPublicKey: null, envelope: null, claimStatus: null, cancelled: [],
}) {
  const backend = mockBackend(account);
  const loginBodies: Record<string, unknown>[] = [];
  const doFetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === `${API}/api/auth/secret-key-transfers`) {
      transfer.recipientPublicKey = fromBase64Url(String(body["recipientPublicKey"]), 1216);
      return Response.json({ transferId: TRANSFER_ID, challenge: CHALLENGE, pollToken: POLL_TOKEN,
        expiresAt: new Date(1_000_000 + 300_000).toISOString() });
    }
    if (url === `${API}/api/auth/secret-key-transfers/${TRANSFER_ID}/claim`) {
      if (body["pollToken"] !== POLL_TOKEN) return new Response(null, { status: 404 });
      if (transfer.claimStatus) return new Response(null, { status: transfer.claimStatus });
      if (!transfer.envelope) return new Response(null, { status: 202 });
      return Response.json({ accountId: account.accountId, ...transfer.envelope });
    }
    if (url === `${API}/api/auth/secret-key-transfers/${TRANSFER_ID}` && init?.method === "DELETE") {
      transfer.cancelled.push(String(body["pollToken"]));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/api/auth/login")) loginBodies.push(body);
    return backend.fetch(input, init);
  };
  const now = { value: 1_000_000 };
  let mgr: SessionManager;
  const autoLock = new AutoLock(new FakeAlarms(), () => void mgr.lock());
  mgr = new SessionManager({
    store: new SessionStore(new FakeStorageArea()),
    authClient: new AuthClient(doFetch, API),
    autoLock,
    now: () => now.value,
    accountSecrets: device,
  });
  return { mgr, device, transfer, loginBodies, now };
}

/** The signed-in sender device: scans the QR, confirms the SAS and seals. */
async function approveFromSender(
  qrPayload: string,
  relayedKey: Uint8Array,
  accountId: string,
  accountSecret: Uint8Array,
): Promise<{ envelope: PairingEnvelope; sas: string }> {
  const qr = parsePairingQr(qrPayload);
  if (qr.flow !== "recipient-shows-qr") throw new Error("unexpected flow");
  const session = { accountId, transferId: qr.transferId, challenge: CHALLENGE, recipientPublicKey: relayedKey };
  const envelope = await sealAccountSecretForPairing({
    ...session, flow: "recipient-shows-qr", scannedRecipientPublicKeyDigest: qr.recipientPublicKeyDigest, sasConfirmed: true,
  }, accountSecret);
  return { envelope, sas: computePairingSas(session) };
}

describe("Identity v2 sign-in with the Secret Key", () => {
  let secret: Uint8Array;
  let account: TestAccount;

  beforeAll(async () => {
    secret = await generateAccountSecret();
    account = await buildTestAccount(undefined, undefined, secret);
  });

  it("signs in with the Secret Key held by this browser", async () => {
    const device = new FakeAccountSecretDevice();
    await device.store(account.accountId, secret);
    const { mgr, loginBodies } = harness(account, device);

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({ status: "unlocked" });
    expect(loginBodies[0]).toMatchObject({ securityVersion: 2, kdfProfileId: "identity-argon2id-account-secret-v2" });
    expect(toBase64(mgr.getKeys()!.privateKey)).toBe(account.privateKeyB64);
  });

  it("asks for the Secret Key before deriving or sending anything", async () => {
    const { mgr, loginBodies } = harness(account);

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({ status: "secret-key-required" });
    expect(loginBodies).toHaveLength(0);
    expect(await mgr.getStatus()).toBe("signed-out");
  });

  it("keeps a typed Secret Key only after the login proves it", async () => {
    const { mgr, device } = harness(account);
    await mgr.login(account.email, account.password);

    mgr.secretKey.submitSecretKey(formatSecretKey(account.accountId, secret));
    await expect(mgr.login(account.email, "wrong password")).rejects.toMatchObject({ code: "invalid-credentials" });
    expect(device.secrets.size).toBe(0);

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({ status: "unlocked" });
    expect(device.secrets.get(account.accountId)).toEqual(secret);
  });

  it("rejects a Secret Key that belongs to another account", async () => {
    const { mgr } = harness(account);
    await mgr.login(account.email, account.password);

    expect(() => mgr.secretKey.submitSecretKey(formatSecretKey(OTHER_ACCOUNT_ID, secret)))
      .toThrow(expect.objectContaining({ code: "secret-key-invalid" }));
  });

  it("refuses a password-only profile for an account this browser knows uses a Secret Key", async () => {
    const v1 = await buildTestAccount();
    const device = new FakeAccountSecretDevice();
    await device.store(v1.accountId, secret);
    const { mgr, loginBodies } = harness(v1, device);

    await expect(mgr.login(v1.email, v1.password)).rejects.toMatchObject({ code: "unsupported-security" });
    expect(loginBodies).toHaveLength(0);
  });

  it("unlocks offline with the device Secret Key and fails closed without it", async () => {
    const device = new FakeAccountSecretDevice();
    await device.store(account.accountId, secret);
    const { mgr } = harness(account, device);
    await mgr.login(account.email, account.password);
    await mgr.lock();

    await mgr.unlock(new MasterPasswordUnlock(account.password, device));
    expect(await mgr.getStatus()).toBe("unlocked");

    await mgr.lock();
    await device.delete(account.accountId);
    await expect(mgr.unlock(new MasterPasswordUnlock(account.password, device)))
      .rejects.toMatchObject({ code: "secret-key-required" });
    expect(await mgr.getStatus()).toBe("locked");
  });

  it("forgets the Secret Key on sign-out", async () => {
    const device = new FakeAccountSecretDevice();
    await device.store(account.accountId, secret);
    const { mgr } = harness(account, device);
    await mgr.login(account.email, account.password);

    await mgr.logout("manual");

    expect(device.secrets.size).toBe(0);
  });
});

describe("Secret Key transfer to this browser (recipient-shows-qr)", () => {
  let secret: Uint8Array;
  let account: TestAccount;

  beforeAll(async () => {
    secret = await generateAccountSecret();
    account = await buildTestAccount(undefined, undefined, secret);
  });

  it("shows the same SAS as the sender, claims the envelope and finishes sign-in", async () => {
    const { mgr, device, transfer } = harness(account);
    await mgr.login(account.email, account.password);

    const offer = await mgr.secretKey.startTransfer();
    expect(offer.expiresAt).toBeLessThanOrEqual(1_000_000 + 300_000);
    await expect(mgr.secretKey.pollTransfer()).resolves.toBe("pending");

    const approved = await approveFromSender(offer.qrPayload, transfer.recipientPublicKey!, account.accountId, secret);
    expect(approved.sas).toBe(offer.sas);
    transfer.envelope = approved.envelope;
    await expect(mgr.secretKey.pollTransfer()).resolves.toBe("ready");

    await expect(mgr.login(account.email, account.password)).resolves.toEqual({ status: "unlocked" });
    expect(device.secrets.get(account.accountId)).toEqual(secret);
  });

  it("shows a different SAS when the relay substitutes the recipient key", async () => {
    const { mgr } = harness(account);
    await mgr.login(account.email, account.password);
    const offer = await mgr.secretKey.startTransfer();
    const relayed = (await generatePairingKeyPair()).publicKey;

    expect(computePairingSas({ accountId: account.accountId, transferId: TRANSFER_ID, challenge: CHALLENGE,
      recipientPublicKey: relayed })).not.toBe(offer.sas);
    await expect(approveFromSender(offer.qrPayload, relayed, account.accountId, secret))
      .rejects.toMatchObject({ code: "recipient-key-digest-mismatch" });
  });

  it("rejects an envelope sealed for another account without keeping anything", async () => {
    const { mgr, transfer } = harness(account);
    await mgr.login(account.email, account.password);
    const offer = await mgr.secretKey.startTransfer();
    transfer.envelope = (await approveFromSender(offer.qrPayload, transfer.recipientPublicKey!, OTHER_ACCOUNT_ID, secret)).envelope;

    await expect(mgr.secretKey.pollTransfer()).rejects.toMatchObject({ code: "secret-key-transfer-failed" });
    await expect(mgr.login(account.email, account.password)).resolves.toEqual({ status: "secret-key-required" });
  });

  it("rejects a malformed envelope", async () => {
    const { mgr, transfer } = harness(account);
    await mgr.login(account.email, account.password);
    await mgr.secretKey.startTransfer();
    transfer.envelope = { kemCiphertext: toBase64Url(new Uint8Array(1120)), ciphertext: "short" };

    await expect(mgr.secretKey.pollTransfer()).rejects.toMatchObject({ code: "secret-key-transfer-failed" });
  });

  it("ends an expired or consumed session", async () => {
    const { mgr, transfer, now } = harness(account);
    await mgr.login(account.email, account.password);
    await mgr.secretKey.startTransfer();
    transfer.claimStatus = 410;
    await expect(mgr.secretKey.pollTransfer()).rejects.toMatchObject({ code: "secret-key-transfer-failed" });

    transfer.claimStatus = null;
    await mgr.secretKey.startTransfer();
    now.value += 300_000;
    await expect(mgr.secretKey.pollTransfer()).rejects.toMatchObject({ code: "secret-key-transfer-failed" });
    expect(transfer.cancelled).toContain(POLL_TOKEN);
  });

  it("cannot start a transfer before a sign-in named the account", async () => {
    const { mgr } = harness(account);

    await expect(mgr.secretKey.startTransfer()).rejects.toMatchObject({ code: "secret-key-transfer-failed" });
  });
});
