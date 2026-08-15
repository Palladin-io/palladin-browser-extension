import { describe, expect, it, vi } from "vitest";

import type { AgentInjectionRequest } from "@shared/messaging";

import {
  handleNativeAgentMessage,
  type AgentFillDeps,
  type AgentProviderSession,
  type AgentTabState,
  type TransactionReplayGuard,
} from "./native-provider";

const DOC_A = "d".repeat(32);
const DOC_B = "e".repeat(32);
const PAGE_A: AgentTabState = {
  id: 7,
  page: { url: "https://login.example.com/start", documentId: DOC_A },
};

function request(overrides: Record<string, unknown> = {}): AgentInjectionRequest {
  return {
    protocol: "palladin.inject-provider.v1",
    type: "inject",
    transactionId: "tx-1",
    grantId: "grant-1",
    entryId: "entry-1",
    expectedDomain: "login.example.com",
    form: {
      version: 1,
      steps: [{
        fields: [
          { entryFieldId: "credential.username", selector: "#user", control: "username" },
          { entryFieldId: "credential.password", selector: "#pass", control: "password" },
        ],
        submit: { action: "click", selector: "#submit" },
      }],
    },
    values: [
      { entryFieldId: "credential.username", value: "fixture-user" },
      { entryFieldId: "credential.password", value: "fixture-password-not-production" },
    ],
    ...overrides,
  } as AgentInjectionRequest;
}

function replay(accepted = true): TransactionReplayGuard {
  return { consume: vi.fn(() => Promise.resolve(accepted)) };
}

function deps(page: AgentTabState | null = PAGE_A): AgentFillDeps & {
  sendStep: ReturnType<typeof vi.fn>;
  probeTransition: ReturnType<typeof vi.fn>;
} {
  return {
    getActivePage: () => Promise.resolve(page),
    sendStep: vi.fn(() => Promise.resolve({ ok: true } as const)),
    probeTransition: vi.fn(() => Promise.resolve({ status: "ready" } as const)),
    wait: () => Promise.resolve(),
  };
}

async function preparedInject(
  fill: AgentFillDeps,
  guard: TransactionReplayGuard,
  injection: unknown,
): Promise<Awaited<ReturnType<typeof handleNativeAgentMessage>>> {
  const session: AgentProviderSession = { prepared: null };
  const prepared = await handleNativeAgentMessage(fill, guard, session, {
    protocol: "palladin.inject-provider.v1",
    type: "prepare",
    nonce: "c".repeat(64),
  });
  expect(prepared).toMatchObject({ type: "prepare.result", outcome: "ready" });
  return handleNativeAgentMessage(fill, guard, session, injection);
}

describe("authenticated native Agent provider", () => {
  it("returns only the public top-frame URL and binds the prepared document internally", async () => {
    const session: AgentProviderSession = { prepared: null };
    const response = await handleNativeAgentMessage(deps(), replay(), session, {
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "a".repeat(64),
    });
    expect(response).toEqual({
      protocol: "palladin.inject-provider.v1",
      type: "prepare.result",
      nonce: "a".repeat(64),
      currentUrl: "https://login.example.com/start",
      outcome: "ready",
    });
    expect(session.prepared).toEqual({ tabId: 7, documentId: DOC_A });
    expect(JSON.stringify(response)).not.toContain(DOC_A);
  });

  it("executes the exact Rust form+values contract without returning a secret", async () => {
    const fill = deps();
    const captured: unknown[] = [];
    fill.sendStep.mockImplementation((_tabId, _domain, step, values) => {
      captured.push(structuredClone({ step, values }));
      return Promise.resolve({ ok: true });
    });
    const response = await preparedInject(fill, replay(), request());

    expect(response).toEqual({
      protocol: "palladin.inject-provider.v1",
      type: "inject.result",
      transactionId: "tx-1",
      outcome: "injected",
    });
    expect(captured).toEqual([{
      step: request().form.steps[0],
      values: request().values,
    }]);
    expect(JSON.stringify(response)).not.toContain("fixture-password-not-production");
  });

  it("resumes only the next declared step after a same-tab document replacement", async () => {
    const secondPage: AgentTabState = {
      id: 7,
      page: { url: "https://login.example.com/password", documentId: DOC_B },
    };
    const pages: Array<AgentTabState | null> = [
      PAGE_A, // prepare
      PAGE_A, // inject document binding
      PAGE_A, // first step
      { id: 7, page: null }, // navigation gap
      secondPage, // transition probe
      secondPage, // second step
    ];
    const seen: unknown[] = [];
    const fill: AgentFillDeps = {
      getActivePage: vi.fn(() => Promise.resolve(pages.shift() ?? secondPage)),
      sendStep: vi.fn((_tab, _domain, step, values) => {
        seen.push(structuredClone({ step, values }));
        return Promise.resolve({ ok: true } as const);
      }),
      probeTransition: vi.fn(() => Promise.resolve({ status: "ready" } as const)),
      wait: () => Promise.resolve(),
    };
    const multiStep = request({
      form: {
        version: 1,
        steps: [
          {
            fields: [{ entryFieldId: "credential.username", selector: "#user", control: "username" }],
            submit: { action: "click", selector: "#next" },
            waitFor: { selector: "#pass", timeoutMs: 500 },
          },
          {
            fields: [{ entryFieldId: "credential.password", selector: "#pass", control: "password" }],
            submit: { action: "press-enter", selector: "#pass" },
          },
        ],
      },
    });

    const response = await preparedInject(fill, replay(), multiStep);
    expect(response).toMatchObject({ outcome: "injected" });
    expect(seen).toEqual([
      {
        step: multiStep.form.steps[0],
        values: [{ entryFieldId: "credential.username", value: "fixture-user" }],
      },
      {
        step: multiStep.form.steps[1],
        values: [{
          entryFieldId: "credential.password",
          value: "fixture-password-not-production",
        }],
      },
    ]);
  });

  it("does not move a prepared transaction to another tab or document", async () => {
    for (const changed of [
      {
        id: 8,
        page: { url: "https://login.example.com/start", documentId: DOC_A },
      },
      {
        id: 7,
        page: { url: "https://login.example.com/start", documentId: DOC_B },
      },
    ]) {
      const pages = [PAGE_A, changed];
      const fill = deps();
      fill.getActivePage = vi.fn(() => Promise.resolve(pages.shift() ?? changed));
      const response = await preparedInject(fill, replay(), request({ transactionId: `tx-${changed.id}-${changed.page?.documentId}` }));
      expect(response).toMatchObject({
        outcome: changed.id === 8 ? "provider-unavailable" : "rejected",
      });
      expect(fill.sendStep).not.toHaveBeenCalled();
    }
  });

  it("fails before delivery for insecure, sibling, or public-suffix targets", async () => {
    const cases: Array<{ page: AgentTabState; expectedDomain: string; outcome: string }> = [
      {
        page: { id: 7, page: { url: "http://login.example.com", documentId: DOC_A } },
        expectedDomain: "login.example.com",
        outcome: "insecure-origin",
      },
      {
        page: { id: 7, page: { url: "https://evil.example.com", documentId: DOC_A } },
        expectedDomain: "login.example.com",
        outcome: "origin-mismatch",
      },
    ];
    for (const item of cases) {
      const fill = deps(item.page);
      const response = await preparedInject(fill, replay(), request({
        transactionId: `tx-${item.outcome}`,
        expectedDomain: item.expectedDomain,
      }));
      expect(response).toMatchObject({ outcome: item.outcome });
      expect(fill.sendStep).not.toHaveBeenCalled();
    }

    const fill = deps({
      id: 7,
      page: { url: "https://alice.github.io", documentId: DOC_A },
    });
    const suffix = await preparedInject(fill, replay(), request({
      transactionId: "tx-suffix",
      expectedDomain: "github.io",
    }));
    expect(suffix).toMatchObject({ outcome: "rejected" });
    expect(fill.sendStep).not.toHaveBeenCalled();
  });

  it("maps replay and malformed frames to Rust-supported value-free outcomes", async () => {
    const replayed = await preparedInject(deps(), replay(false), request());
    expect(replayed).toMatchObject({ transactionId: "tx-1", outcome: "rejected" });

    const malformed = request() as unknown as Record<string, unknown>;
    malformed.extra = "not-allowed";
    const invalid = await preparedInject(deps(), replay(), malformed);
    expect(invalid).toMatchObject({ transactionId: "tx-1", outcome: "rejected" });
    expect(JSON.stringify(replayed)).not.toContain("fixture-password-not-production");
    expect(JSON.stringify(invalid)).not.toContain("fixture-password-not-production");
  });
});
