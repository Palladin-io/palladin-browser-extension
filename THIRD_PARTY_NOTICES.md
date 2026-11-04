# Third-party notices

The default branch does not contain browser-extension runtime dependencies,
vendored runtime code, or bundled third-party visual assets.

Repository CI invokes these GitHub-maintained actions without redistributing
them in an extension artifact:

| Component | Version reference | License | Source |
|---|---|---|---|
| `actions/checkout` | v4 | MIT | <https://github.com/actions/checkout> |
| `actions/setup-node` | v4 | MIT | <https://github.com/actions/setup-node> |

The extension bundles this runtime dependency, recorded here when it was
introduced; other bundled runtime dependencies are not yet inventoried in this
file:

| Component | Version | License | Copyright | Source |
|---|---|---|---|---|
| `qr` | 0.7.2 | MIT OR Apache-2.0 (used under MIT) | Copyright (c) 2023 Paul Miller (https://paulmillr.com) | <https://github.com/paulmillr/qr> |

Public prototype branches have their own dependency graphs and assets. Their
presence is not covered by this default-branch inventory. Any code consolidated
into `main` must update this file with exact runtime dependencies, bundled
assets, copyright notices, and licenses before merge.
