# Chrome Web Store release

The first distribution is Chrome Web Store **Unlisted** (installation by link),
with `https://api.palladin.io` as the default API. Settings retains the existing
server selector, including staging and custom HTTPS servers. Other browser
stores are out of scope for this release. Unlisted is visibility, not access
control: anyone with the link can install the extension.

Version `0.1.0` is the initial candidate. Preparing an archive does not complete
the release gates in [STATUS.md](STATUS.md).

## Current preparation (2026-09-21)

The owner has no developer account yet and has not selected a production panel
address. Panel URL must become user-configurable alongside API URL. Current
links still use build-time `VITE_WEB_APP_URL`; shared unlock independently uses
build-time API/origin pairs in `VITE_SHARED_UNLOCK_ENVIRONMENTS` and generated
browser routing. An editable navigation URL alone must not silently authorize
key transfer. Dynamic panel configuration and its shared-unlock trust boundary
need implementation and validation before the final upload.

A ZIP labelled `DRAFT-ID-ONLY` may be uploaded only to create the unpublished
store item and retrieve its public key/ID. It retains the localhost panel-link
fallback, has no configured shared-unlock environments, and is not a release
candidate for review or installation by testers. Replace it before submission.

## Build and upload

1. Build from a reviewed commit on `main` after repository CI passes.
2. Run `npm ci`, `npm audit --audit-level=high`, `npm run build`, and `npm test`,
   plus the browser checks required by `.github/workflows/test.yml`.
3. Set `VITE_WEB_APP_URL` to the confirmed production **web panel** URL and run
   `npm run build:chromium`. The generic development fallback is localhost;
   never upload a build using that fallback. Record the exact build environment,
   including any reviewed `VITE_SHARED_UNLOCK_ENVIRONMENTS` configuration.
4. Archive only the contents of `dist/chromium/`, with `manifest.json` at ZIP
   root. Do not upload the repository, debug build, `.env` files, source maps,
   browser profiles, credentials, or signing keys. Preserve the generated
   manifest; source changes belong in `manifest/*.json`.
5. Record the commit, artifact SHA-256, dependency SBOM (`npm sbom --sbom-format
   cyclonedx`), build settings and check results alongside the archive.
6. In the Chrome Developer Dashboard, create or open the existing Palladin item
   and upload the ZIP as a draft. Obtain its Item ID and public key from Package.
   Compare with the Chromium manifest and the runtime's compiled allowlist.
   The development manifest key does not establish the store-assigned identity.
   Any identity change needs coordinated extension/runtime review before release.
7. Select **Unlisted** in Distribution. Complete the listing, Privacy practices,
   and Test instructions. Provide a dedicated synthetic test account through
   the dashboard's reviewer-only field, never through Git or a public listing.
8. Complete the applicable release gates and test the exact installed artifact.
   Submit for review only with accurate support claims and working instructions.
   Store approval and actual publication are separate milestones.

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
