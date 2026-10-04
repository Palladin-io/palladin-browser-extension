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

Remote HTTP support is incomplete: the current consumer crypto release and
backend reject non-loopback HTTP operation contexts; Web also needs portable
crypto and cross-tab serialization where SubtleCrypto/Web Locks are absent.
Coordinated backend and crypto changes are prepared separately. A local Chromium
Identity run passed 18 checks: real registration/login, explicit public connection
configuration, automatic unlock, actual Entry decryption, worker restart and
manual lock/logout. The fixture API used its already declared localhost:5000
permission. Earlier attempts stopped at optional-port permission and the newly
added Privacy dialog; the driver now uses the declared port and saves the
synthetic account's default-OFF privacy choice through the normal UI. This does
not prove optional-permission prompt UX, remote HTTP or staging. Do not release
this editor as complete remote HTTP support until those consumers and actual
Identity/Entry acceptance pass. Firefox/Safari builds are not runtime acceptance.
The original staging artifact additionally needs an ID matching the panel's
independently configured distribution ID; changing routing alone cannot fix that.
