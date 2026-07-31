# Project governance

The Palladin browser extension is maintained by the Palladin project. The
maintainers decide whether deferred development resumes and whether a change
proposed against `main` satisfies the security and release gates. Historical
prototype branches are unsupported and do not participate in governance.

## Decision process

- Product and architecture proposals are discussed in public issues when they
  can be disclosed safely.
- Code and documentation changes go through pull requests to `main`.
- Maintainers may request a narrower change, threat analysis, or independent
  security review before accepting security-sensitive work.
- Security reports and incident details remain private until coordinated
  disclosure is appropriate.
- A tagged release requires an explicit maintainer decision; a branch, artifact,
  or successful CI run is not itself a release.

The zero-knowledge boundary, least privilege, and non-persistence of plaintext
secrets are hard constraints. Maintainers should reject changes that weaken
them, even when the change improves convenience or shortens implementation.

## Changes to project status

The status in `README.md` and `docs/STATUS.md` is authoritative for this
repository. A pull request that resumes implementation or announces a supported
release must update both documents and include evidence for every applicable
gate.
