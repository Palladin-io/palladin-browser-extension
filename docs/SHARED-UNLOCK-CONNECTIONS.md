# Shared-unlock connection configuration

Settings and onboarding use the same extension-owned editor. Each saved public
configuration contains a name, one API URL, one panel URL, the shared-unlock
switch and explicit HTTP consent. Only one configuration is active; switching
API/panel retires the previous account session and clears its encrypted cache.
This is not simultaneous multi-account support. No key or token is stored in a
connection configuration.

The user explicitly saves the pair; an arbitrary page cannot propose or install
it. Legacy API-only settings and build environment lists do not authorize a
panel for shared unlock. The configured panel origin (scheme, host and port) is
the boundary; a path prefix controls links, not isolation from other scripts on
the same origin. The panel must independently configure the expected distributed
extension ID. A matching domain with the wrong installed extension ID still fails.

Manifest external-connect patterns permit routing from arbitrary self-hosted
addresses. They grant no key/session authority. The worker checks the active pair,
the browser-provided sender, top frame, exact origin/port and current document
before creating a coordinator. Firefox discovery returns only an approved-origin
boolean; its extension bridge still requires the native parent-document checks.
Chromium requests optional API access; Firefox/Safari also request the configured
panel origin for their platform transport. Declared optional HTTP permissions do
not grant access to every HTTP site.

Shared unlock starts enabled for a newly entered configuration. Disabling it
cancels browser cooperation and saves the authenticated account preference through
its existing revision-fenced endpoint. It does not lock/logout a completed own
session. A failed preference save is shown as failure. Signed-out configuration
stores only the local switch. Existing account OFF, MFA, expiry and independent
idle policies are retained. Manual lock/logout propagation uses the existing
Identity lifecycle once a pair is active.

HTTP requires explicit consent for both entered addresses, including localhost.
Editing either address clears the draft consent. Legacy/build HTTP configuration
does not bypass that consent at network-client creation. Consent is durable for
the saved pair, not one browser session. No certificate error is ignored, no
HTTPS request is downgraded, and ordinary autofill remains HTTPS-only.

## Current rollout gates

The native Chromium test proves default rejection, dynamic approval without an
environment rebuild, exact-port/host/iframe rejection, document replacement and
OFF/ON channel cancellation. It does not perform an Identity/MK handoff.

The consumers pin the coordinated crypto 0.12.0 candidate. Its SHA-256/HKDF
implementation preserves existing vectors without requiring SubtleCrypto. Web
uses exclusive, empty IndexedDB transactions when Web Locks are unavailable;
publication and local pause/link/expiry writes share the same transaction fence.
No keys or tokens are persisted by this lock fallback. The extension passes only
the active configuration's independent HTTP approval to session-envelope crypto.

A real Chromium Identity run on `http://panel.palladin.test` passed 39 checks:
registration/login, shared unlock, Entry decryption, worker restart, manual
lock/logout, preference OFF/retry/conflict and concurrent documents. The browser confirmed a non-secure context without SubtleCrypto or
Web Locks. A separate two-document native test passed eight publication and
pause/lock/logout/expiry checks. The fixture API still used its already declared
localhost:5000 permission. A subsequent run exercised HTTP consent and address-edit consent reset through
the real Settings form. Its full 24-check run also passed real 15-minute Web
idle while the active extension kept decrypting, persistent denial after reload,
zero steady retries, rejected-session cleanup and fresh manual recovery.
Optional-host permission prompt UX, remote API host, staging and platform
acceptance remain separate rollout gates.
The candidate was installed locally from npm cache against the registry lock;
0.12.0 must be published and its registry integrity verified before consumer CI
and release. Firefox/Safari builds are not runtime acceptance.
The original staging artifact additionally needs an ID matching the panel's
independently configured distribution ID; changing routing alone cannot fix that.
