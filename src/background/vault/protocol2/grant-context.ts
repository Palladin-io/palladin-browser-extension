export interface EntryGrantContext {
  readonly id: string;
  readonly vaultId: string;
  readonly type: "full" | "granular" | "scriptExecution";
  readonly agentId: string | null;
  readonly agentAccessEpoch: number | null;
  readonly agentPublicKey: string | null;
  readonly recipientAgentKeyVersion: number | null;
  readonly methods: string | null;
  readonly entryId: string | null;
  readonly entryScopes: readonly {
    readonly entryId: string;
    readonly fieldIds: readonly string[];
    readonly grantEnvelopeRevision: string | null;
    readonly grantKeyVersion: number | null;
  }[];
  readonly scriptScopes: readonly { readonly entryId: string; readonly entryRevision: string; readonly isScript: boolean }[];
  readonly scriptPackageRevision: string | null;
  readonly expiresAt: string | null;
  readonly queryLimit: number | null;
  readonly queryCount: number | null;
}
