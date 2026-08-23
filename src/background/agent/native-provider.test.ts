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
  getActivePage: ReturnType<typeof vi.fn>;
  getPageById: ReturnType<typeof vi.fn>;
  sendStep: ReturnType<typeof vi.fn>;
  probeTransition: ReturnType<typeof vi.fn>;
} {
  return {
    getActivePage: vi.fn(() => Promise.resolve(page)),
    getPageById: vi.fn(() => Promise.resolve(page)),
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

  it("selects the framework tab exactly and rejects a stale URL snapshot", async () => {
    const fill = deps();
    const session: AgentProviderSession = { prepared: null };
    const targeted = await handleNativeAgentMessage(fill, replay(), session, {
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "a".repeat(64),
      targetTabId: 7,
      targetUrl: "https://login.example.com/start",
    });
    expect(targeted).toMatchObject({ outcome: "ready" });
    expect(fill.getPageById).toHaveBeenCalledWith(7);
    expect(fill.getActivePage).not.toHaveBeenCalled();

    const stale = await handleNativeAgentMessage(fill, replay(), session, {
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "b".repeat(64),
      targetTabId: 7,
      targetUrl: "https://login.example.com/other",
    });
    expect(stale).toMatchObject({ outcome: "target-url-mismatch", currentUrl: null });
    expect(session.prepared).toBeNull();
  });

  it("reports a bounded target-tab diagnostic without exposing browsing data", async () => {
    const fill = deps(null);
    const session: AgentProviderSession = { prepared: null };
    const response = await handleNativeAgentMessage(fill, replay(), session, {
      protocol: "palladin.inject-provider.v1",
      type: "prepare",
      nonce: "a".repeat(64),
      targetTabId: 7,
      targetUrl: "https://login.example.com/start",
    });
    expect(response).toMatchObject({ outcome: "target-tab-unavailable", currentUrl: null });
    expect(session.prepared).toBeNull();
  });

  it("executes the exact Rust form+values contract without returning a secret", async () => {
    const fill = deps();
    const captured: unknown[] = [];
    fill.sendStep.mockImplementation((_tabId, _domain, _documentId, step, values) => {
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
    const readPage = vi.fn(() => Promise.resolve(pages.shift() ?? secondPage));
    const fill: AgentFillDeps = {
      getActivePage: readPage,
      getPageById: readPage,
      sendStep: vi.fn((_tab, _domain, _documentId, step, values) => {
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
      const readPage = vi.fn(() => Promise.resolve(pages.shift() ?? changed));
      fill.getActivePage = readPage;
      fill.getPageById = readPage;
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

  it("reports only structural form failures as a stale Form Discovery Map", async () => {
    const cases = [
      { outcome: "no-password-field" as const, expected: "stale-form-map" },
      { outcome: "no-submit-control" as const, expected: "stale-form-map" },
      { outcome: "ambiguous-form" as const, expected: "stale-form-map" },
      { outcome: "origin-mismatch" as const, expected: "origin-mismatch" },
      { outcome: "insecure-origin" as const, expected: "insecure-origin" },
      { outcome: "provider-unavailable" as const, expected: "provider-unavailable" },
    ];

    for (const item of cases) {
      const fill = deps();
      fill.sendStep.mockResolvedValue({ ok: false, outcome: item.outcome });

      const response = await preparedInject(fill, replay(), request({
        transactionId: `tx-${item.outcome}`,
      }));

      expect(response).toMatchObject({
        transactionId: `tx-${item.outcome}`,
        outcome: item.expected,
      });
    }
  });

  it("separates a stale transition selector from origin and transport failures", async () => {
    const cases = [
      { status: "missing" as const, expected: "stale-form-map" },
      { status: "ambiguous" as const, expected: "stale-form-map" },
      { status: "origin-mismatch" as const, expected: "origin-mismatch" },
      { status: "insecure-origin" as const, expected: "insecure-origin" },
      { status: null, expected: "provider-unavailable" },
    ];

    for (const item of cases) {
      const fill = deps();
      fill.probeTransition.mockResolvedValue(
        item.status === null ? null : { status: item.status },
      );

      const response = await preparedInject(fill, replay(), request({
        transactionId: `tx-transition-${item.expected}`,
        form: {
          version: 1,
          steps: [{
            fields: [{ entryFieldId: "credential.username", selector: "#user", control: "username" }],
            submit: { action: "click", selector: "#next" },
            waitFor: { selector: "#pass", timeoutMs: 100 },
          }],
        },
        values: [{ entryFieldId: "credential.username", value: "fixture-user" }],
      }));

      expect(response).toMatchObject({ outcome: item.expected });
    }
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
