# Palladin Browser Extension

> **Status: experimental and deferred.** The default branch does not contain a
> buildable browser extension, and Palladin does not currently publish or
> support an extension from this repository.

This repository records the intended security boundary and development process
for a possible Manifest V3 companion to Palladin. Public development branches
contain separate experiments, but those branches have not been consolidated,
security-reviewed as one product, or promoted to a release.

Do not install branch builds with real credentials or treat screenshots,
manifests, or prototype behavior as a statement of a shipped Palladin feature.

## Intended scope

If development resumes, the extension is expected to cover two distinct flows:

- user-selected credential filling in a browser tab;
- agent-assisted filling where an authorized runtime asks the extension to use
  a prepared value without placing that value in model context.

These are design goals, not capabilities available from `main` today. Capture,
passkeys, multi-browser packaging, store publication, and production update
signing are likewise not current releases.

## Security requirements

Any implementation proposed for the default branch must preserve these
invariants:

- the web page and main-world script are untrusted;
- secrets cross into a page only for a narrowly authorized fill action;
- key material stays in JavaScript memory or ephemeral
  `chrome.storage.session`, never durable browser storage;
- local caches contain ciphertext and non-secret structural data only;
- no password, key, token, mnemonic, or plaintext field reaches logs,
  analytics, crash reports, or extension messages that do not need it;
- every fill revalidates the active frame, HTTPS state, domain scope, user or
  runtime authorization, and current session immediately before use;
- Manifest permissions and host access are minimal and justified in review;
- the extension bundles all executable code locally, as required by Manifest
  V3, and does not load remote code.

The proposed trust boundaries are described in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). A future implementation is not
ready for release merely because it builds; the security gates in
[`docs/STATUS.md`](docs/STATUS.md) must also be satisfied.

## Repository state

| Item | Current state on `main` |
|---|---|
| Installable extension | Not present |
| Package manifest and lockfile | Repository documentation tooling only; no extension dependencies |
| Browser-store release | Not published from this repository |
| Supported versions | None |
| Development status | Deferred pending branch consolidation and security review |

The public branch experiments explore a Manifest V3 scaffold, service-worker
session handling, popup unlock and entry selection, domain-gated filling,
password generation, and an integration path. They are useful research inputs,
not a linear release history. Any restart should consolidate them through a
reviewed pull request instead of declaring one branch authoritative.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and open an issue before a large
implementation. Pull requests should target `main`, state which prototype ideas
they retain, and include a security-boundary analysis. Do not submit real
credentials or production-derived vault data in examples, fixtures, issues, or
screenshots.

Suspected vulnerabilities must be reported privately as described in
[`SECURITY.md`](SECURITY.md), including issues found in public prototype
branches.

Project decisions and release authority are documented in
[`GOVERNANCE.md`](GOVERNANCE.md).

## License and trademarks

The repository's software and technical documentation are licensed under the
[Apache License 2.0](LICENSE). Contributions must follow
[the DCO](DCO) and [contribution guide](CONTRIBUTING.md). Third-party components
retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The software license does not grant rights to Palladin names, logos, or future
extension store identity. See [`TRADEMARKS.md`](TRADEMARKS.md).
