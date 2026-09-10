import { describe, expect, it, vi } from "vitest";
import { hashSharedUnlockKeyContext, hashSharedUnlockTranscript } from "@palladin/crypto";
import fixtures from "./fixtures/session-api-v1.json";
import { SharedUnlockApi } from "./api";
import type { SharedUnlockOperation, SharedUnlockOperationInput } from "./api-types";
import type { SessionTokens } from "../session/types";

const apiUrl = "https://api.example.test";
const session: SessionTokens = {
  accessToken: "synthetic-source-access", refreshToken: "synthetic-source-refresh",
  userId: fixtures.operations[0].operation.context.accountId, apiUrl,
};
const signal = () => new AbortController();
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const fixture = (name: string) => fixtures.responses.find(item => item.name === name)!.body;
const operation = fixtures.operations[0].operation as SharedUnlockOperation;
const context = operation.context;
const input: SharedUnlockOperationInput = {
  authorizationId: fixtures.operations[0].sourceAuthorization.authorizationId,
  linkId: context.linkId, linkEpoch: context.linkEpoch, expectedPreferenceRevision: context.preferenceRevision,
  recipientOrganizationId: context.organizationId, direction: context.direction,
  apiOrigin: context.apiOrigin, webOrigin: context.webOrigin, extensionId: context.extensionId,
  documentBinding: context.documentBinding, webGeneration: context.webGeneration, extensionGeneration: context.extensionGeneration,
  sourcePublicKey: operation.sourcePublicKey, recipientPublicKey: operation.recipientPublicKey,
  recipientProofPublicKey: operation.recipientProofPublicKey,
};

for (const vector of fixtures.responses) {
  it(`reads the provider response without stricter client business rules: ${vector.name}`, async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(vector.body));
    const client = new SharedUnlockApi(fetcher, () => apiUrl);
    switch (vector.type) {
      case "preference": {
        const result = await client.readPreference(session);
        expect({ sharedUnlockEnabled: result.sharedUnlockEnabled, revision: result.revision }).toEqual(vector.body);
        break;
      }
      case "link": {
        const result = await client.readLink(session, context.linkId);
        expect({ linkId: result.linkId, revision: result.revision, epoch: result.epoch, state: result.state,
          lastInvalidationSequence: result.lastInvalidationSequence, lastLogoutSequence: result.lastLogoutSequence }).toEqual(vector.body);
        break;
      }
      case "authorization": {
        const result = await client.recordActivity(session, {
          authorizationId: input.authorizationId, sourceGeneration: context.extensionGeneration, idleDeadlineMs: context.idleDeadlineMs,
        });
        expect({ authorizationId: result.authorizationId, sequence: result.sequence, accountId: result.accountId,
          organizationId: result.organizationId, credentialRevision: result.credentialRevision,
          privateKeyWrapRevision: result.privateKeyWrapRevision, authorizationVersion: result.authorizationVersion,
          unlockedAtMs: result.unlockedAtMs, idleDeadlineMs: result.idleDeadlineMs,
          absoluteDeadlineMs: result.absoluteDeadlineMs, offlineDeadlineMs: result.offlineDeadlineMs }).toEqual(vector.body);
        break;
      }
      case "operation": {
        const result = await client.consume(apiUrl, context.operationId, "synthetic-consume-proof");
        expect(await hashSharedUnlockKeyContext(result.keyContext)).toBe(result.context.keyContextDigest);
        expect(await hashSharedUnlockTranscript(result.context, result.sourcePublicKey, result.recipientPublicKey)).toBe(result.transcriptHash);
        expect({ context: result.context, sourcePublicKey: result.sourcePublicKey, recipientPublicKey: result.recipientPublicKey,
          recipientProofPublicKey: result.recipientProofPublicKey, challenge: result.challenge,
          transcriptHash: result.transcriptHash, keyContext: result.keyContext }).toEqual(vector.body);
        break;
      }
      case "commit": {
        const result = await client.commit(apiUrl, context.operationId, "synthetic-commit-proof");
        expect({ session: { accessToken: result.session.accessToken, refreshToken: result.session.refreshToken,
          userId: result.session.userId, isOnboarded: result.session.isOnboarded, emailVerified: result.session.emailVerified,
          waitlistDeveloperBenefitStartedAt: result.session.waitlistDeveloperBenefitStartedAt,
          waitlistDeveloperBenefitEndsAt: result.session.waitlistDeveloperBenefitEndsAt },
          authorizationId: result.authorizationId, authorizationSequence: result.authorizationSequence,
          context: result.context }).toEqual(vector.body);
        break;
      }
      default: throw new Error("Unknown contract fixture");
    }
  });
}

describe("Identity request ownership and cancellation", () => {
  it("uses only the source's own tokens when offering and receives separate receiver tokens", async () => {
    const committed = fixtures.responses.find(item => item.type === "commit")!.body;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(operation)).mockResolvedValueOnce(json(committed));
    const client = new SharedUnlockApi(fetcher, () => apiUrl);
    await client.createOperation(session, input);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(`${apiUrl}/api/account/shared-unlock/operations`);
    expect(request?.headers).toMatchObject({ authorization: `Bearer ${session.accessToken}` });
    expect(JSON.parse(String(request?.body))).toEqual({ ...input, refreshToken: session.refreshToken });
    const result = await client.commit(apiUrl, context.operationId, "synthetic-commit-proof");
    expect(result.session.refreshToken).not.toBe(session.refreshToken);
    const receiverRequest = fetcher.mock.calls[1][1];
    expect(receiverRequest?.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(String(receiverRequest?.body))).toEqual({ signature: "synthetic-commit-proof" });
    expect(receiverRequest).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  });

  it("keeps lock/logout, preference and explicit disconnect/reconnect as separate requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture("link-locked")));
    const client = new SharedUnlockApi(fetcher, () => apiUrl);
    await client.lock(session, context.linkId, 2, 3);
    await client.logout(session, context.linkId, 2, 3);
    await client.disconnect(session, context.linkId, 2);
    await client.reconnect(session, context.linkId, 2);
    await client.setPreference(session, false, 3);
    expect(fetcher.mock.calls.map(([url]) => String(url).split("/").at(-1)))
      .toEqual(["lock", "logout", "disconnect", "reconnect", "shared-unlock"]);
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body))))
      .toEqual([{ expectedRevision: 2, expectedPreferenceRevision: 3 }, { expectedRevision: 2, expectedPreferenceRevision: 3 },
        { expectedRevision: 2 }, { expectedRevision: 2 }, { sharedUnlockEnabled: false, expectedRevision: 3 }]);
  });

  it("rejects an old source environment or proof attempt before contacting a new server", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new SharedUnlockApi(fetcher, () => "https://other.example.test");
    await expect(client.readPreference(session)).rejects.toMatchObject({ code: "cancelled" });
    await expect(client.consume(apiUrl, context.operationId, "proof")).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  for (const change of ["abort", "server"] as const) {
    for (const phase of ["fetch", "body"] as const) {
      it(`rejects ${change} while awaiting ${phase}, even if fetch ignores cancellation`, async () => {
        const controller = signal();
        let current = apiUrl;
        const invalidate = () => { if (change === "abort") controller.abort(); else current = "https://other.example.test"; };
        const response = json(operation);
        if (phase === "body") vi.spyOn(response, "json").mockImplementation(async () => { invalidate(); return operation; });
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
          if (phase === "fetch") invalidate();
          return response;
        });
        const client = new SharedUnlockApi(fetcher, () => current);
        await expect(client.consume(apiUrl, context.operationId, "proof", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
      });
    }
  }

  it("does not start an already cancelled attempt", async () => {
    const controller = signal(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const client = new SharedUnlockApi(fetcher, () => apiUrl);
    await expect(client.createOperation(session, input, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "not-found"],
    [409, "conflict"], [429, "rate-limited"], [503, "unavailable"], [500, "network"]] as const) {
    it(`keeps ${status} as ${code} without retrying or exposing the response body`, async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic-sensitive-error-body", { status }));
      const client = new SharedUnlockApi(fetcher, () => apiUrl);
      await expect(client.createOperation(session, input)).rejects.toMatchObject({ code, message: "Shared unlock request failed" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  it("sanitizes transport failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-token-in-transport-error"));
    const client = new SharedUnlockApi(fetcher, () => apiUrl);
    await expect(client.readPreference(session)).rejects.toMatchObject({ code: "network", message: "Shared unlock request failed" });
  });
});
