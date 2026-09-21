# Chrome Web Store release

The first distribution is Chrome Web Store **Unlisted** (installation by link),
with `https://api.palladin.io` as the default API. Settings retains the existing
server selector, including staging and custom HTTPS servers. Other browser
stores are out of scope for this release. Unlisted is visibility, not access
control: anyone with the link can install the extension.

Version `0.1.0` is the initial candidate. Preparing an archive does not complete
the release gates in [STATUS.md](STATUS.md).

## CI/CD

Run **Actions -> Chrome Web Store -> Run workflow** on `main` only:

| Operation | Result |
| --- | --- |
| `bootstrap` | ZIP for creating an unpublished store item; no Google authentication or upload. Panel remains localhost and shared unlock is unconfigured. Never submit this artifact. |
| `package` | Release ZIP using the configured panel and shared-unlock environments; no upload. |
| `upload` | Upload the verified release ZIP to the existing store item as a draft. |
| `publish` | Upload the release ZIP and request normal Google review; publish automatically after approval using the item's existing visibility. |

All modes run the same repository-native CI through reusable `test.yml`. A
separate job builds the Chromium production channel, packages only its resources
with deterministic ZIP metadata, and retains `package.zip`, SHA-256, source/build
metadata and a production-dependency CycloneDX SBOM. Another job attaches GitHub
build provenance to the ZIP. Download the `chrome-store-<run>-<attempt>` artifact
from the workflow run. This GitHub provenance does not replace the runtime's
independent Agent Inject artifact-attestation gate.

Only the store job can obtain Google credentials. It runs in the
`chrome-web-store` environment and requests a short-lived access token through
Workload Identity Federation (OIDC) and a dedicated service account. No service
account JSON key, client secret or refresh token is needed. Dependency install,
tests and builds run in other jobs. No npm dependencies run in the store job.
All newly introduced Actions references are pinned to commit SHAs.

Before upload, the script checks the artifact checksum/source, release gates,
nonzero version, and exact manifest-derived Item ID. It obtains the store's
public key through API v2 and compares identities before any mutation. It refuses
an existing pending/staged submission, policy warnings, or an already-published
version. Async upload processing has a two-minute deadline. Upload errors never
lead to publication; mutations are not automatically retried. A publish request
uses normal review and blocks on warnings. `PENDING_REVIEW` is not `PUBLISHED`.
Keep manual dashboard changes out of an active upload/publish run.

## One-time setup

1. Register the publisher account and enable Google two-step verification.
2. Merge this workflow through reviewed PR/CI. Run `bootstrap` on `main` and
   download its ZIP. API v2 uploads update **existing** items; create the first
   unpublished item in the Developer Dashboard with this bootstrap ZIP.
3. Copy the Item ID and public key from Package. Reconcile the manifest and
   runtime's compiled identity through coordinated PRs before uploading a release
   artifact. Do not silently replace the key during packaging.
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
6. Create an OIDC Workload Identity Provider for GitHub. Map `google.subject` and
   the repository ID, owner ID, ref, workflow ref and event-name claims. Require
   the exact immutable repository/owner numeric IDs, `refs/heads/main`,
   `Palladin-io/palladin-browser-extension/.github/workflows/chrome-web-store.yml@refs/heads/main`,
   `workflow_dispatch`, and the subject
   `repo:Palladin-io/palladin-browser-extension:environment:chrome-web-store`.
   Grant only `roles/iam.workloadIdentityUser` on this service account to that
   pool's `attribute.repository_id` principal set. Do not grant project-wide
   Editor, Owner, Token Creator or access to runtime secrets.
7. Create GitHub environment `chrome-web-store` with a deployment branch rule
   allowing only branch `main`. Populate the variables below. Actual cloud IDs
   belong in GitHub configuration, not runnable tracked examples.

Repository variables (available to the secretless package job):

| Variable | Value |
| --- | --- |
| `CWS_WEB_APP_URL` | Confirmed production HTTPS panel address; no localhost or placeholders. |
| `CWS_SHARED_UNLOCK_ENVIRONMENTS` | Reviewed JSON pairs of `apiUrl` and `webOrigin`; empty disables the integration. |

Environment `chrome-web-store` variables:

| Variable | Value |
| --- | --- |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` resource name. |
| `CWS_SERVICE_ACCOUNT` | Dedicated service account email linked to the publisher. |
| `CWS_PUBLISHER_ID` | Publisher ID from Publisher -> Settings. |
| `CWS_EXTENSION_ID` | Item ID assigned by the store and reconciled with the native runtime. |
| `CWS_VISIBILITY` | `unlisted`, only after confirming it in the dashboard. API v2 does not expose visibility; this records the owner's configuration, not an API verification. |
| `CWS_RELEASE_READY` | `true` only after the gates in `STATUS.md` and the release checklist are complete; absent/false blocks all automated uploads and submissions. |

Every upload needs an incremented version in manifest/package/lockfile. After a
bootstrap upload of `0.1.0`, use a higher version for the final package. If a run
fails after a mutation, inspect its status in the dashboard before retrying.
Rollback requires a new higher-version build of the reviewed previous source;
do not try uploading a lower manifest version.

## Current product gates

The owner has registered a developer account and selected a GCP project. The
production panel URL remains undecided. Its URL must become user-configurable
alongside API URL; that feature is not implemented by this CI change. Current
links use build-time `VITE_WEB_APP_URL`, while shared unlock independently uses
API/origin pairs and generated browser routing. An editable navigation URL must
not silently authorize key transfer. Dynamic configuration and its shared-unlock
trust boundary still need implementation and validation before final release.
The workflow keeps `CWS_RELEASE_READY` false until those existing gates close.

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

These drafts do not claim production Agent Inject support. Its independent
artifact-attestation gate remains open in `STATUS.md`. Confirm the public privacy
policy URL, required disclosures, support contact and reviewer access before
submission; this document does not approve legal declarations.

## References

- [Prepare an extension](https://developer.chrome.com/docs/webstore/prepare)
- [Publish an extension](https://developer.chrome.com/docs/webstore/publish)
- [Distribution and Unlisted visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Images](https://developer.chrome.com/docs/webstore/images)
- [Store identity and manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Version format](https://developer.chrome.com/docs/extensions/reference/manifest/version)

- [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
- [Service account access](https://developer.chrome.com/docs/webstore/service-accounts)
- [GitHub OIDC authentication](https://github.com/google-github-actions/auth)
