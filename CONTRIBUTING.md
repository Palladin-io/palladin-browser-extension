# Contributing

Thank you for helping evaluate the Palladin browser-extension design. The
project is deferred and has no buildable default branch, so contributions should
start with a scoped issue and target `main`, the only authoritative branch.

## Before opening a pull request

1. Read `README.md`, `docs/ARCHITECTURE.md`, and `docs/STATUS.md`.
2. Open an issue for implementation work that changes trust boundaries,
   permissions, storage, messaging, authentication, or release scope.
3. Use synthetic test values. Never include a real credential, token, recovery
   phrase, private endpoint, or production-derived vault payload.
4. Rebase on `main` and keep the change focused enough to audit.

## Pull-request expectations

Describe:

- the current problem and intended behavior;
- affected trust boundaries and data flows;
- any added browser permission, host, persistent state, or external service;
- failure and cleanup behavior;
- tests performed and remaining limitations;
- the provenance and license of any design or code used as input.

Security-sensitive behavior needs rejection-path tests, not only a happy-path
test. A buildable implementation should use strict TypeScript, locked
dependencies, co-located tests, and CI that executes without secrets on fork
pull requests.

## Legal terms

By contributing, you agree that your contribution is licensed under the
license applicable to the files you modify.

Every commit must include a Developer Certificate of Origin sign-off:

    Signed-off-by: Your Name <your.email@example.com>

Add it with `git commit -s`. Do not submit code copied from another project
unless its source, copyright, and license are identified and compatible.

Submitting a contribution does not grant rights to Palladin trademarks.

Report suspected vulnerabilities privately according to `SECURITY.md`; do not
open a public issue for them.
