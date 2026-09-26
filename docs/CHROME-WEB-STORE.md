# Chrome Web Store release

The first distribution is Chrome Web Store **Unlisted** (installation by link),
with `https://api.stage.palladin.io` as the default API and
`https://stage.palladin.io` as the panel for the first release. These defaults are
injected through GitHub repository variables. Settings retains the existing
server selector, including production and custom HTTPS servers. Other browser
stores are out of scope for this release. Unlisted is visibility, not access
control: anyone with the link can install the extension.

Version `0.1.1` is the next candidate after the initial `0.1.0` draft. Preparing an archive does not complete
the release gates in [STATUS.md](STATUS.md).

Non-bootstrap packaging requires `CWS_SHARED_UNLOCK_ENVIRONMENTS` to include the
exact `apiUrl` / `webOrigin` pair selected by `CWS_API_URL` / `CWS_WEB_APP_URL`.
Set this public JSON in deployment variables, never in generic build defaults.
The Web build must separately select this channel's reviewed Item ID through
`STAGING_VITE_SHARED_UNLOCK_EXTENSION_ID`. Changing either configuration requires
rebuilding its artifact; selecting the API in extension settings alone does not
enable the browser channel. Bootstrap archives intentionally remain unconfigured.

## CI/CD

Two separate **Unlisted** items provide installable channels:

| Trigger | Store item | Version | Result |
| --- | --- | --- | --- |
| Push/merge to `main` | Palladin BETA | `0.0.<run / 65536>.<run % 65536>` (integer division) | Run CI, upload and submit for normal review; automatically publish after approval. |
| Push `vX.Y.Z` | Palladin | `X.Y.Z` | Require the tag version in manifest/package/lockfile and a commit reachable from `main`; run CI, upload and submit for staged review. Approval alone does not publish. |

Until the separate beta item/public key is configured, a main push runs CI and reports that beta submission was skipped; it does not fail packaging or submit to the stable item. Manual beta packaging still requires its key.

The beta counter is the workflow's `github.run_number`, independent of the stable
version. For example, run 65535 is `0.0.0.65535`; run 65536 is `0.0.1.0`.
`version_name` also includes the source version and beta run. Re-running the same
run keeps the same version. Do not reset/rename the workflow without planning a
monotonic version migration. The stable source version is incremented through a
PR before creating its tag. Do not move or reuse release tags.

CWS does not provide an installable prerelease track within one item. Beta has
its own Item ID and public key, with Google's required BETA name/testing label.
An approved staged submission is unpublished; testers cannot install it as a
separate track. Both beta and stable use the API and panel selected in deployment
configuration, with the existing server selector. The beta channel does not grant
any additional native runtime or shared-unlock trust; its separate identity must be explicitly reviewed
and configured in those integrations. It is not the local debug runtime channel.

A push submits a candidate, not an immediate installation. If a previous version
is pending review or staged, an upload/review job fails without replacing it or cancelling
review. An explicit stable `publish` can release the matching staged version after the live release gates pass; it does not upload again. Its tested ZIP remains in Actions for 30 days. After resolving the store
status, rerun the relevant failed job only if its version is still newer than the
published version, or dispatch the latest `main` beta. There is no automatic
review cancellation, retry queue, GitHub prerelease, or store submission for PRs.
GitHub concurrency serializes each channel separately; newer queued runs may
replace older queued runs while an active run finishes.

Manual recovery/bootstrap: **Actions -> Chrome Web Store -> Run workflow**,
selecting `channel` (`stable` or `beta`) and an operation:

| Operation | Allowed source | Result |
| --- | --- | --- |
| `status` | `main` for beta, an existing stable release tag for stable | Read current published/submitted states and versions; no build, upload or mutation. |
| `bootstrap` | `main` (either channel) | ZIP for creating an unpublished item; no Google credentials/upload. API and panel use the configured defaults; shared unlock is unconfigured. Never submit this artifact. |
| `package` | `main`, or a matching stable tag | Configured ZIP only; no upload. |
| `upload` | `main` for beta, matching tag for stable | Upload as draft, e.g. before the first manual publication. |
| `review` | Matching stable tag | Upload and request `STAGED_PUBLISH`: approval keeps the candidate unpublished, even while `CWS_RELEASE_READY=false`. |
| `publish` | `main` for beta, matching tag for stable | With `CWS_RELEASE_READY=true`, release the matching staged stable version without uploading again; otherwise upload and request review with automatic publication after approval. |

All packaging and mutation modes run the same repository-native CI through reusable `test.yml`. A
separate job builds the Chromium production channel, packages only its resources
with deterministic ZIP metadata, and retains `package.zip`, SHA-256, source/build
metadata and a production-dependency CycloneDX SBOM. Another job attaches GitHub
build provenance to the ZIP. The ZIP manifest omits the development-only `key`
field, which CWS rejects on upload. The unpacked build keeps it, and release
metadata retains the public key for the uploader identity checks. Download the
`chrome-store-<run>-<attempt>` artifact from the workflow run. This GitHub provenance attests the ZIP build; it does not identify the extension
invoking a native host. The accepted Chrome/macOS caller boundary is documented
in `STATUS.md` and still needs installed-runtime acceptance.

Only the store and read-only status jobs can obtain Google credentials. Status requests only the `chromewebstore.readonly` scope, skips package CI, and emits bounded states/versions and policy flags without public keys or arbitrary API text. The existing tag/main environment and WIF restrictions also apply to status; stable status cannot run from main.

The store mutation job obtains Google credentials separately. It runs in the
`chrome-web-store-beta` (main) or `chrome-web-store` (tags) environment and requests a short-lived access token through
Workload Identity Federation (OIDC) and a dedicated service account. No service
account JSON key, client secret or refresh token is needed. Dependency install,
tests and builds run in other jobs. No npm dependencies run in the store job.
All newly introduced Actions references are pinned to commit SHAs.

Before upload, the script checks the artifact checksum/source, release gates,
nonzero version, exact manifest-derived Item ID, and that its API/panel URLs match
the deployment variables. A configuration change requires a new matching package.
It obtains the store's public key through API v2 and compares identities before any mutation. It refuses
an existing pending/staged submission except explicit publication of the matching approved stable version, policy warnings, or an already-published
version. Async upload processing has a two-minute deadline. Upload errors never
lead to publication; mutations are not automatically retried. Submission uses normal review and blocks on warnings. Stable tag pushes select `review` (`STAGED_PUBLISH`). A later explicit `publish` releases an approved candidate after `CWS_RELEASE_READY=true`. Keep the same tag and deployment configuration; do not replace its package in the dashboard between review and publication. The API exposes the approved version and identity, not its archive checksum. `PENDING_REVIEW` is not `PUBLISHED`.
Keep manual dashboard changes out of an active upload/publish run.

## One-time setup

1. Register the publisher account and enable Google two-step verification.
2. Merge this workflow through reviewed PR/CI. Run `bootstrap` separately for
   `stable` and `beta` on `main` and download their ZIPs. API v2 uploads update **existing** items; create the first
   unpublished item in the Developer Dashboard with this bootstrap ZIP.
3. Copy each Item ID and public key from Package. The beta bootstrap omits the
   stable key; set `CWS_BETA_PUBLIC_KEY` to the new beta key and the beta
   environment Item ID accordingly. Reconcile the manifest and
   runtime's compiled identity through coordinated PRs before uploading a release
   artifact. CWS assigns the identity for both new items; the existing stable
   development key does not reserve a store ID. Set `CWS_STABLE_PUBLIC_KEY` to
   the assigned stable public key and reconcile the store ID with native
   integrations before release. Stable store builds use
   this key; builds without a store channel retain the development identity. Beta
   key injection is explicit at manifest build time; it rejects the development key and the uploader
   verifies it against the independently configured beta Item ID and store key.
4. Complete Store listing, Privacy, reviewer Test instructions and **Unlisted**
   distribution. API publishing preserves existing visibility and cannot change
   it. Google requires a manual publication after a visibility change; complete
   that first publication with a final CI-built artifact after all release gates.
5. Enable Chrome Web Store API, IAM Service Account Credentials API and Security
   Token Service API in the selected GCP project. Create a dedicated service
   account without project roles or downloadable keys. Add its email in the
   Chrome Web Store publisher account settings; only one service account can be
   linked to a publisher. This grants publisher-wide API access, while this
   workflow additionally checks the configured exact Item ID.
6. Create an OIDC Workload Identity Provider for GitHub. Require the exact
   immutable repository/owner numeric IDs and event `push` or `workflow_dispatch`.
   Bind the exact workflow path and ref, with two allowed combinations:
   - `refs/heads/main`, workflow ref ending `@refs/heads/main`, environment subject
     `repo:Palladin-io/palladin-browser-extension:environment:chrome-web-store-beta`.
   - `refs/tags/vX.Y.Z`, workflow ref ending with that exact tag ref, environment
     subject `repo:Palladin-io/palladin-browser-extension:environment:chrome-web-store`.
   Grant only `roles/iam.workloadIdentityUser` on the service account to the pool's
   immutable repository ID principal set. No project-wide roles or runtime secrets.
7. Configure deployment rules: `chrome-web-store-beta` allows only branch `main`;
   `chrome-web-store` allows only tags `v*`. Protect release tags against moving
   and deletion; restrict creation to trusted release maintainers. Both environments
   start with `CWS_RELEASE_READY=false`. The provider must also enforce the
   ref/environment combinations above; GitHub rules alone are insufficient.
   Real cloud identifiers belong in GitHub configuration, not tracked defaults.

Repository variables (available to the secretless package job):

| Variable | Value |
| --- | --- |
| `CWS_STABLE_PUBLIC_KEY` | Canonical base64 DER public key from the stable item. Required for stable package/upload/publish; bootstrap may omit it. Public build configuration, never a private key. |
| `CWS_BETA_PUBLIC_KEY` | Canonical base64 DER public key from the separate beta item. Public configuration, never a private key. Required except beta bootstrap. |
| `CWS_API_URL` | Selected staging or production API; required for every package operation. |
| `CWS_WEB_APP_URL` | Selected HTTPS panel address; no localhost or placeholders for release packages. |
| `CWS_SHARED_UNLOCK_ENVIRONMENTS` | Reviewed JSON pairs of `apiUrl` and `webOrigin`; must include the selected API/panel pair for non-bootstrap artifacts. |

Changing these defaults takes effect in a newly built extension version; it does
not migrate accounts or Vaults between servers or replace a saved server choice.
Keep URL variables at repository scope so packaging and store validation use the
same values. Changing navigation URLs does not authorize shared unlock.

Each environment (`chrome-web-store-beta` and `chrome-web-store`) has its own variables:

| Variable | Value |
| --- | --- |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` resource name. |
| `CWS_SERVICE_ACCOUNT` | Dedicated service account email linked to the publisher. |
| `CWS_PUBLISHER_ID` | Publisher ID from Publisher -> Settings. |
| `CWS_EXTENSION_ID` | That channel's distinct Item ID assigned by the store and reconciled with integrations. |
| `CWS_VISIBILITY` | `unlisted`, only after confirming it in the dashboard. API v2 does not expose visibility; this records the owner's configuration, not an API verification. |
| `CWS_RELEASE_READY` | `true` only after the gates in `STATUS.md` and the release checklist are complete; absent/false blocks draft `upload` and live `publish`. Stable `review` is permitted while false because Google keeps an approved submission unpublished. All identity, source, configuration, visibility and policy checks still apply. |

Stable uploads need an incremented version in manifest/package/lockfile. After
a stable bootstrap upload of `0.1.0`, use a higher version for the final package.
Beta versions increment automatically with new workflow runs. If a run
fails after a mutation, inspect its status in the dashboard before retrying.
Rollback requires a new higher-version build of the reviewed previous source;
do not try uploading a lower manifest version.

## Current product gates

The owner has registered a developer account, selected a GCP project and linked
the service account to the publisher. The stable item exists; use the status workflow on its release tag for the current review/publication state. The beta item still needs creation. The first release uses staging; the
production panel URL remains undecided. The panel URL must become user-configurable
alongside API URL; that feature is not implemented by this CI change. Current
links use build-time `VITE_WEB_APP_URL`, while shared unlock independently uses
API/origin pairs and generated browser routing. An editable navigation URL must
not silently authorize key transfer. Dynamic configuration and its shared-unlock
trust boundary still need implementation and validation before final release.
The workflow keeps `CWS_RELEASE_READY` false until those existing gates close. This blocks live distribution, while staged Google review can proceed independently; submitting for review is not installed-runtime acceptance.

## Signing

Upload a ZIP, not a locally signed CRX. Chrome Web Store packages/signs its store
distribution; the pipeline does not create or store a signing private key. The
manifest `key` is public and keeps an unpacked development build on the assigned
store ID once reconciled. It is retained outside the upload ZIP; CWS owns the
identity/signing of the uploaded item. Google service-account
authentication is separate: OIDC yields a short-lived upload token without a
service-account JSON key. GitHub provenance is also separate from Chrome signing
and does not attest which local extension called Agent Inject. The approved
Chrome/macOS trust model uses signed Chrome plus the exact extension origin,
with the same-ID local-replacement limitation documented in `STATUS.md`.

## Listing materials

Required graphics: packaged 128 x 128 PNG icon, a 440 x 280 promotional image,
and at least one real screenshot at 1280 x 800 or 640 x 400. Use synthetic
account and Vault data. Do not expose real usernames, URLs, passwords or tokens.

Suggested English description:

> Palladin gives you access to your encrypted vault in Chrome. Save login
> credentials, fill matching websites, generate passwords, and keep your vault
> available in the popup or side panel. Encryption and decryption happen on your
> device. When unlocked, Palladin can automatically fill an empty login form on
> the exact saved HTTPS host; automatic fill does not submit the form. You can
> select your Palladin server in Settings. English and Polish interfaces and
> system, light and dark themes are included.

Suggested Polish description:

> Palladin zapewnia dostęp do zaszyfrowanego sejfu w Chrome. Zapisuj dane
> logowania, wypełniaj formularze na pasujących stronach, generuj hasła i korzystaj
> z sejfu w oknie rozszerzenia lub panelu bocznym. Szyfrowanie i odszyfrowywanie
> odbywa się na Twoim urządzeniu. Odblokowany Palladin może automatycznie wypełnić
> pusty formularz logowania na dokładnie zapisanym hoście HTTPS; automatyczne
> wypełnienie nie wysyła formularza. Serwer Palladin wybierzesz w ustawieniach.
> Dostępne są interfejsy polski i angielski oraz motywy systemowy, jasny i ciemny.

These drafts do not claim production Agent Inject support. The first release
requires working Agent Inject on Chrome/macOS with an updated signed Runtime,
installed-build acceptance and accurate reviewer instructions. Its accepted
browser-identity boundary and local-replacement limitation are in `STATUS.md`.
Confirm the public privacy
policy URL, required disclosures, support contact and reviewer access before
submission; this document does not approve legal declarations.

## References

- [Prepare an extension](https://developer.chrome.com/docs/webstore/prepare)
- [Publish an extension](https://developer.chrome.com/docs/webstore/publish)
- [Distribution and Unlisted visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Images](https://developer.chrome.com/docs/webstore/images)
- [Store identity and manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Beta distribution](https://developer.chrome.com/docs/extensions/develop/migrate/publish-mv3)
- [Version format](https://developer.chrome.com/docs/extensions/reference/manifest/version)

- [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
- [Service account access](https://developer.chrome.com/docs/webstore/service-accounts)
- [GitHub OIDC authentication](https://github.com/google-github-actions/auth)

- [API staged publication](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
- [API read-only status](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus)
