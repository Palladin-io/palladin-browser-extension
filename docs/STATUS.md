# Project status and restart gates

Development is deferred. The default branch intentionally contains no
installable extension and there are no supported versions.

Historical public prototype branches contain unsupported experiments. They are
not release candidates, maintained research inputs, or part of an integration
plan, and their branch refs will be removed during the OSS cleanup. `main` is
the only authoritative project surface. Any future implementation must start
from `main` and arrive through normal review.

## Minimum gates for a development baseline

- one buildable source tree on `main` with a locked dependency graph;
- repository-local instructions and architecture that match the merged code;
- CI that runs safely for forks without repository secrets;
- manifest permission and host inventory with least-privilege justification;
- tests for messaging, session lock/wipe, storage guards, domain matching, fill
  authorization, and logging redaction;
- no credentials, keys, private endpoints, or production-derived fixtures;
- an explicit compatibility statement for supported browsers and versions.

## Additional gates for any release

- independent security review of the consolidated implementation;
- threat model updated from observed code rather than prototype assumptions;
- reproducible production build and reviewed store manifest;
- dependency audit, SBOM, artifact hashes, and build provenance;
- browser-store signing, update, rollback, and incident-response procedures;
- end-to-end tests against a compatible public Palladin API contract;
- release notes that distinguish implemented behavior from future work.

Until every release gate is complete, documentation and UI must continue to use
experimental language and must not ask users to trust the extension with real
credentials.
