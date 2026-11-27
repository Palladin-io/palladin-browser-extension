# Firefox, Edge and Brave distribution

## Current release boundary

Chrome is already published. Brave desktop installs that same Chrome Web Store
listing; there is no separate Brave submission in this pipeline. Firefox AMO
and Microsoft Edge Add-ons publisher accounts have not yet been registered
(owner confirmation, 2026-10-02). Neither store has received these candidates.

The `Firefox and Edge store packages` workflow prepares candidates on a published
stable GitHub Release, with its `vX.Y.Z` tag as the version authority. A manual
run on `main` prepares the current source version. Prereleases are skipped; tags
must be reachable from `origin/main`. Repository tests precede packaging.
The workflow has read-only repository permissions and no store credentials.

It reuses the public `CWS_API_URL`, `CWS_WEB_APP_URL`,
`CWS_SHARED_UNLOCK_ENVIRONMENTS` and `CWS_STABLE_PUBLIC_KEY` build configuration
from the Chrome pipeline. Missing configuration fails packaging. Configuration
values remain in GitHub, not runnable source defaults. Current deployed store
configuration selects staging. Telemetry is disabled.

The uploaded GitHub artifact contains:

- `edge-store/package.zip`, checksum and release metadata: the same Chromium
  bundle and permissions as Chrome. The development manifest key is removed so
  Microsoft can assign the Edge store identity.
- `firefox-store/package.zip`, checksum and release metadata: Firefox resources.
- `firefox-store/sources.zip` and checksum: allowlisted tracked source files,
  lockfile, stamped version, dependency notices, public build settings, exact
  Node/npm versions and reviewer rebuild instructions.
- `firefox-lint.json`: Mozilla web-ext validation output. CI rebuilds the source
  archive in a separate directory and compares every output byte before upload.

## Register the publishers

1. Firefox: sign in or create a Mozilla account at
   [AMO Developer Hub](https://addons.mozilla.org/developers/). Complete the
   developer profile and its display name. Create a Firefox desktop listing
   with the package and matching sources together. Preserve the existing Gecko
   ID; do not create another identity for an update.
2. Edge: register for the Microsoft Edge program in
   [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).
   The primary owner must use a personal Microsoft account (MSA); a work/school
   Entra account alone cannot enroll. Select the actual publisher country and
   Individual/Company status carefully: Microsoft does not allow changing these
   after enrollment. Registration has no fee. Complete publisher verification,
   then create the extension item and upload the Edge package as a draft.
3. Record the resulting listing URL and opaque item/product ID. Configure store
   API credentials through a protected secret store, never in chat or Git.
   Store update automation is a follow-up after these identities exist; this
   workflow does not sign, submit for review or publish either listing.

## Listing and installed acceptance

Reuse the current Chrome brand assets and localized user-password-manager copy,
but do not promise Agent Inject on Firefox, Edge or Brave. The current native
runtime only supports Google Chrome on macOS. Firefox also omits clipboard-copy
controls because Chromium's timed clipboard-clear implementation is unavailable.
See [browser compatibility](BROWSER-COMPATIBILITY.md).

For each actual store-installed browser, record version, OS, listing identity,
artifact version and results for login, unlock/lock, exact-host autofill,
no-overwrite/no-submit, credential capture, synchronization, shared unlock,
restart and update. An unpacked build does not validate Microsoft-assigned
identity or the signed Firefox package. Edge shared-unlock trust must be checked
against the actual assigned identity before promising support.

Mozilla's linter currently reports warnings for Chromium-only offscreen calls
guarded by target capability, bundled React innerHTML paths, and the Android
minimum version for the data declaration. Review these against the source and
select desktop-only distribution; no Firefox Android support is claimed.
Do not suppress warnings as a substitute for review.

Publish only after repository review/CI and installed-browser acceptance. A
rollback uses the previous known-good sources with a higher store version;
never reuse or decrement an already uploaded version. Keep Firefox package and
reviewer sources from the same build. Brave receives updates through Chrome Web
Store; do not create a duplicate store item for it.

## Provider references

- [Brave Chrome extension installation](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)
- [Mozilla developer accounts](https://extensionworkshop.com/documentation/publish/developer-accounts/)
- [Mozilla source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Microsoft publisher registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
- [Microsoft submission](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- [Microsoft update API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference)
