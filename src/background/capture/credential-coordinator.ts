import {
  type CredentialCaptureCommand,
  type CredentialCapturePrompt,
  type CredentialCaptureResult,
  type SubmittedCredential,
} from "@shared/messaging/credential-capture";
import { registrableDomain } from "@shared/security/domain";

const PENDING_TTL_MS = 3 * 60_000;
const MAX_PENDING_TABS = 20;

export interface CredentialCaptureSource {
  readonly tabId: number;
  readonly browserDocumentId: string;
  readonly documentId: string;
  readonly url: string;
}

export type CredentialWriteTarget =
  | { readonly action: "create"; readonly vaultId: string; readonly label: string; readonly vaultLabel: string }
  | {
      readonly action: "update";
      readonly vaultId: string;
      readonly entryId: string;
      readonly revision: string;
      readonly label: string;
      readonly vaultLabel: string;
      readonly exactAccount: boolean;
      readonly previousPasswordMatches: boolean;
    };

export interface CredentialCaptureChoices {
  readonly identical: boolean;
  readonly targets: readonly CredentialWriteTarget[];
  readonly defaultIndex: number | null;
}

export interface CaptureSession {
  readonly profileId: string;
  readonly unlocked: boolean;
  readonly generation: number;
}

export interface AutomaticUpdateBinding {
  readonly vaultId: string;
  readonly entryId: string;
  readonly revision: string;
  readonly origin: string;
}

export interface CredentialCapturePreferences {
  isMuted(profileId: string, site: string): Promise<boolean>;
  mute(profileId: string, site: string): Promise<void>;
  isAutomatic(profileId: string, binding: AutomaticUpdateBinding): Promise<boolean>;
  setAutomatic(profileId: string, binding: AutomaticUpdateBinding, enabled: boolean): Promise<void>;
}

export interface CredentialCaptureCoordinatorDeps {
  getSession(): Promise<CaptureSession | null>;
  isSubmissionDocument(source: CredentialCaptureSource): boolean;
  isCurrentDocument(source: CredentialCaptureSource): Promise<boolean>;
  choices(credential: SubmittedCredential, url: string): Promise<CredentialCaptureChoices>;
  save(
    credential: SubmittedCredential,
    url: string,
    target: CredentialWriteTarget,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<{ readonly action: "created" | "updated"; readonly revision: string }>;
  readonly preferences: CredentialCapturePreferences;
  now?: () => number;
  createId?: () => string;
}

interface PendingCredential {
  readonly id: string;
  readonly submissionId: string;
  profileId: string | null;
  readonly credential: SubmittedCredential | null;
  readonly identifier: string | null;
  readonly origin: string;
  readonly site: string;
  readonly submittedAt: number;
  readonly sourceDocumentId: string;
  source: CredentialCaptureSource;
  outcome: "waiting" | "manual" | "confirmed";
  choices: Map<string, CredentialWriteTarget>;
  defaultTargetId: string | null;
  sessionGeneration: number | null;
  navigationStarted: boolean;
  loading: boolean;
  successorDocumentId: string | null;
}

function origin(url: string): string | null {
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.origin : null; }
  catch { return null; }
}

function sameDocument(left: CredentialCaptureSource, right: CredentialCaptureSource): boolean {
  return left.tabId === right.tabId && left.browserDocumentId === right.browserDocumentId
    && left.documentId === right.documentId && origin(left.url) === origin(right.url);
}

export class CredentialCaptureCoordinator {
  private readonly pending = new Map<number, PendingCredential>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly operations = new Map<number, Promise<CredentialCaptureResult>>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: CredentialCaptureCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? (() => crypto.randomUUID());
  }

  dispatch(command: CredentialCaptureCommand, source: CredentialCaptureSource): Promise<CredentialCaptureResult> {
    if (command.documentId !== source.documentId || origin(source.url) === null) return Promise.resolve({ status: "stale" });
    // Admit browser-authenticated submits before storage awaits can race a classic navigation.
    const isSubmission = command.type === "submitted" || command.type === "identifier";
    const submission = isSubmission && this.deps.isSubmissionDocument(source)
      ? this.stage(command, source) : null;
    if (isSubmission && submission === null) return Promise.resolve({ status: "stale" });
    const previous = this.operations.get(source.tabId);
    const operation = (previous ?? Promise.resolve()).then(() => this.handle(command, source, submission))
      .catch((): CredentialCaptureResult => {
        if (submission && this.pending.get(source.tabId) === submission) this.clearTab(source.tabId);
        return { status: "unavailable" };
      });
    this.operations.set(source.tabId, operation);
    void operation.finally(() => {
      if (this.operations.get(source.tabId) === operation) this.operations.delete(source.tabId);
    });
    return operation;
  }

  clearTab(tabId: number): void {
    this.pending.delete(tabId);
    const timer = this.timers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(tabId);
  }

  clear(): void {
    for (const tabId of this.pending.keys()) this.clearTab(tabId);
  }

  navigation(tabId: number, url: string): void {
    const pending = this.pending.get(tabId);
    if (pending && origin(url) !== pending.origin) this.clearTab(tabId);
  }

  navigationStarted(tabId: number): void {
    const pending = this.pending.get(tabId);
    if (!pending) return;
    if (pending.credential === null) return;
    if (pending.outcome !== "waiting" || pending.navigationStarted) this.clearTab(tabId);
    else pending.navigationStarted = true;
  }

  navigationUpdated(tabId: number, status: string): void {
    const pending = this.pending.get(tabId);
    if (!pending) return;
    pending.loading = status === "loading";
    // Chrome also emits loading/complete for history.pushState, without a new document.
    const browserDocumentId = pending.successorDocumentId ?? pending.source.browserDocumentId;
    if (this.deps.isSubmissionDocument({ ...pending.source, browserDocumentId })) return;
    if (status === "loading") this.navigationStarted(tabId);
  }

  documentDisconnected(tabId: number, browserDocumentId: string): void {
    const pending = this.pending.get(tabId);
    if (pending?.loading && this.deps.isSubmissionDocument({ ...pending.source, browserDocumentId })) {
      this.navigationStarted(tabId);
    }
  }

  documentConnected(tabId: number, documentId: string, url: string): void {
    const pending = this.pending.get(tabId);
    if (!pending) return;
    if (origin(url) !== pending.origin) { this.clearTab(tabId); return; }
    if (documentId === pending.source.browserDocumentId) return;
    if (pending.credential === null) { pending.successorDocumentId = documentId; return; }
    if (pending.outcome !== "waiting"
      || (pending.successorDocumentId !== null && pending.successorDocumentId !== documentId)) this.clearTab(tabId);
    else pending.successorDocumentId = documentId;
  }

  private async handle(command: CredentialCaptureCommand, source: CredentialCaptureSource,
    submission: PendingCredential | null): Promise<CredentialCaptureResult> {
    if (submission ? this.pending.get(source.tabId) !== submission
      : !(await this.deps.isCurrentDocument(source))) return { status: "stale" };
    const session = await this.deps.getSession();
    if (session === null) { this.clearTab(source.tabId); return { status: "unavailable" }; }
    if (submission) {
      if ((submission.profileId !== null && submission.profileId !== session.profileId)
        || (submission.sessionGeneration !== null && submission.sessionGeneration !== session.generation)) {
        this.clearTab(source.tabId);
        return { status: "stale" };
      }
      submission.profileId = session.profileId;
      const muted = await this.deps.preferences.isMuted(session.profileId, submission.site);
      const current = await this.deps.getSession();
      if (this.live(source.tabId, session.profileId) !== submission) return { status: "stale" };
      if (current?.profileId !== session.profileId || current.generation !== session.generation) {
        this.clearTab(source.tabId);
        return { status: "stale" };
      }
      if (muted) { this.clearTab(source.tabId); return { status: "dismissed" }; }
      if (submission.credential === null) submission.sessionGeneration = session.generation;
      return { status: "accepted" };
    }
    if (command.type === "submitted" || command.type === "identifier") return { status: "stale" };
    const pending = this.live(source.tabId, session.profileId);
    if (!pending) return command.type === "resume" ? { status: "accepted" } : { status: "prompt", prompt: null };
    if (pending.origin !== origin(source.url)) { this.clearTab(source.tabId); return { status: "stale" }; }

    if (pending.credential === null) {
      if ((command.type === "resume" && command.hasError)
        || (command.type === "outcome" && command.outcome === "rejected"
          && command.submissionId === pending.submissionId && sameDocument(pending.source, source))) {
        this.clearTab(source.tabId);
        return { status: "dismissed" };
      }
      return command.type === "get" ? { status: "prompt", prompt: null } : { status: "accepted" };
    }

    if (command.type === "resume") {
      // Only a pending submission may cross to one new browser-issued document.
      if (pending.outcome !== "waiting" || source.browserDocumentId === pending.sourceDocumentId) {
        return { status: "accepted" };
      }
      if (command.hasError || (command.hasPasswordForm && !command.hasSuccess)) {
        this.clearTab(source.tabId);
        return { status: "dismissed" };
      }
      pending.source = source;
      pending.outcome = command.hasSuccess ? "confirmed" : "manual";
      return this.present(pending, session);
    }
    if (!sameDocument(pending.source, source)) return { status: "stale" };
    if (command.type === "outcome") {
      if (command.submissionId !== pending.submissionId || pending.outcome !== "waiting") return { status: "stale" };
      if (command.outcome === "rejected") { this.clearTab(source.tabId); return { status: "dismissed" }; }
      pending.outcome = command.outcome === "success-message" ? "confirmed" : "manual";
      return this.present(pending, session);
    }
    if (command.type === "get") {
      return pending.outcome === "waiting" ? { status: "prompt", prompt: null } : this.present(pending, session);
    }
    if (command.type === "unlock") return { status: "accepted" };
    if (command.promptId !== pending.id || pending.outcome === "waiting") return { status: "stale" };
    if (command.type === "dismiss" || command.type === "mute") {
      this.clearTab(source.tabId);
      if (command.type === "mute") await this.deps.preferences.mute(session.profileId, pending.site);
      return { status: "dismissed" };
    }
    if (!session.unlocked || pending.sessionGeneration !== session.generation) return { status: "stale" };
    const target = pending.choices.get(command.targetId);
    if (!target) return { status: "stale" };
    return this.save(pending, session, target, command.autoUpdate);
  }

  private stage(
    command: Extract<CredentialCaptureCommand, { type: "submitted" | "identifier" }>,
    source: CredentialCaptureSource,
  ): PendingCredential | null {
    const previous = this.pending.get(source.tabId);
    let credential = command.type === "submitted" ? { ...command.credential } : null;
    const inherit = credential !== null && !credential.username && credential.kind !== "password-change";
    if (inherit) {
      if (!previous || previous.credential !== null || previous.profileId === null
        || previous.origin !== origin(source.url) || this.now() - previous.submittedAt >= PENDING_TTL_MS
        || !(sameDocument(previous.source, source) || previous.successorDocumentId === source.browserDocumentId)) {
        this.clearTab(source.tabId);
        return null;
      }
      credential = { ...credential!, username: previous.identifier! };
    }
    this.clearTab(source.tabId);
    const site = registrableDomain(source.url);
    if (!site) return null;
    if (this.pending.size >= MAX_PENDING_TABS) this.clearTab(this.pending.keys().next().value!);
    const pending: PendingCredential = {
      id: this.createId(), submissionId: command.submissionId, profileId: inherit ? previous!.profileId : null,
      credential, identifier: command.type === "identifier" ? command.username : null, origin: origin(source.url)!, site,
      submittedAt: inherit ? previous!.submittedAt : this.now(), sourceDocumentId: source.browserDocumentId, source,
      outcome: "waiting", choices: new Map(), defaultTargetId: null, sessionGeneration: inherit ? previous!.sessionGeneration : null,
      navigationStarted: false, loading: false, successorDocumentId: null,
    };
    this.pending.set(source.tabId, pending);
    this.timers.set(source.tabId, setTimeout(() => this.clearTab(source.tabId),
      PENDING_TTL_MS - (this.now() - pending.submittedAt)));
    return pending;
  }

  private async present(pending: PendingCredential, session: CaptureSession, refresh = false): Promise<CredentialCaptureResult> {
    if (pending.credential === null) return { status: "prompt", prompt: null };
    if (!session.unlocked) return { status: "prompt", prompt: this.view(pending, "locked") };
    if (refresh || pending.sessionGeneration !== session.generation || pending.choices.size === 0) {
      const choices = await this.deps.choices(pending.credential, pending.source.url);
      if (!(await this.stillAuthorized(pending, session))) return { status: "stale" };
      if (choices.identical) { this.clearTab(pending.source.tabId); return { status: "dismissed" }; }
      const entries = choices.targets.map((target) => [this.createId(), target] as const);
      pending.choices = new Map(entries);
      pending.defaultTargetId = choices.defaultIndex === null ? null : entries[choices.defaultIndex]?.[0] ?? null;
      pending.sessionGeneration = session.generation;
    }
    const exact = [...pending.choices.values()].filter((target) => target.action === "update" && target.exactAccount);
    if (pending.outcome === "confirmed" && pending.credential.kind === "password-change" && exact.length === 1) {
      const target = exact[0]!;
      if (target.action === "update" && target.previousPasswordMatches
        && await this.deps.preferences.isAutomatic(session.profileId, { ...target, origin: pending.origin })) {
        return this.save(pending, session, target, true);
      }
    }
    return { status: "prompt", prompt: this.view(pending, "ready") };
  }

  private async save(
    pending: PendingCredential,
    session: CaptureSession,
    target: CredentialWriteTarget,
    autoUpdate: boolean,
  ): Promise<CredentialCaptureResult> {
    if (pending.credential === null) return { status: "stale" };
    const stillAuthorized = () => this.stillAuthorized(pending, session);
    if (!(await stillAuthorized())) return { status: "stale" };
    let result: Awaited<ReturnType<CredentialCaptureCoordinatorDeps["save"]>>;
    try { result = await this.deps.save(pending.credential, pending.source.url, target, stillAuthorized); }
    catch {
      if (!(await stillAuthorized())) return { status: "stale" };
      // Never retry automation after an uncertain write; refresh and ask for a new explicit decision.
      pending.outcome = "manual";
      try {
        const refreshed = await this.present(pending, session, true);
        if (refreshed.status !== "prompt" || !refreshed.prompt) return refreshed;
        return { status: "prompt", prompt: { ...refreshed.prompt, error: "save-failed" } };
      } catch {
        if (!(await stillAuthorized())) return { status: "stale" };
        return { status: "prompt", prompt: { ...this.view(pending, "ready"), error: "save-failed" } };
      }
    }
    if (this.pending.get(pending.source.tabId) === pending) this.clearTab(pending.source.tabId);
    if (target.action === "update") {
      // Preference failure must not offer a second write after an already committed mutation.
      try {
        await this.deps.preferences.setAutomatic(session.profileId,
          { ...target, revision: result.revision, origin: pending.origin }, autoUpdate);
      } catch { /* The password was saved; automation remains disabled for the new revision. */ }
    }
    return { status: "saved", action: result.action };
  }

  private async stillAuthorized(pending: PendingCredential, session: CaptureSession): Promise<boolean> {
    const current = await this.deps.getSession();
    const currentDocument = await this.deps.isCurrentDocument(pending.source);
    return this.pending.get(pending.source.tabId) === pending && this.live(pending.source.tabId, session.profileId) === pending
      && current?.profileId === session.profileId && current.unlocked && current.generation === session.generation
      && currentDocument;
  }

  private live(tabId: number, profileId: string): PendingCredential | null {
    const pending = this.pending.get(tabId);
    if (!pending) return null;
    if (pending.profileId === null) return null;
    if (pending.profileId !== profileId || this.now() - pending.submittedAt >= PENDING_TTL_MS) {
      this.clearTab(tabId);
      return null;
    }
    return pending;
  }

  private view(pending: PendingCredential, state: "locked" | "ready"): CredentialCapturePrompt {
    return {
      id: pending.id, site: pending.site, state,
      targets: state === "locked" ? [] : [...pending.choices].map(([id, target]) => ({
        id, action: target.action, label: target.label, vaultLabel: target.vaultLabel,
      })),
      defaultTargetId: state === "locked" ? null : pending.defaultTargetId,
    };
  }
}
