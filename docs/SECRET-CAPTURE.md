# API key and payment card capture

The extension offers explicit creation of a new encrypted Key or Credit Card Entry
from a visible HTTPS page. Detection uses HTML structure and standards first,
local context and recognizable provider formats second. A match is a heuristic;
it does not prove that a key is new or usable, or that a card is valid.

The optional closed-shadow notice contains no inputs or secret values. Review
expands that same notification into a capture-only extension-origin iframe with
the existing Entry form, browser-derived source origin, explicit destination Vault
and concealed key/PAN fields. Review and Vault selection never write; only the
explicit Save key/Save card action creates an encrypted canonical Entry.
Unlock remains in the native toolbar popup. Clicking the Entry thumbnail opens
the pending native draft before saving or the saved Entry detail afterward.
An already-open side panel/native toolbar editor remains supported; capture
never forces a side panel open. An ordinary extension tab cannot authorize a save.
A captured card
matching a full normalized PAN offers an explicit update of the matching Entry.
One eligible card is preselected; multiple matches require an autocomplete choice.
The worker rechecks the complete PAN, frozen revision, scope, permissions and
document/session before updating. Merchant, network and last four digits never
authorize a match. Existing unrelated fields and delivery policy are preserved.

## What is observed

- API keys in visible fields, readonly results and bounded local DOM snapshots.
  A trusted generation action followed by a changed local result can admit a
  known provider format without English labels. Values keep their exact token
  bytes; masked values, documentation/examples, hidden content, UUIDs, password,
  OTP and CSRF fields are excluded.
- Cards after trusted input/change, or blur after a trusted local edit. PAN
  normalization and Luhn are detection signals. HTML `cc-*` attributes are
  preferred; a local expiry/month structure can support missing autocomplete.
  Synthetic autofill events cannot authorize card capture. A single visible
  standard `cc-csc` field in the same local card group supplies a 3–4 digit CVV.
  Ambiguous, hidden, unrelated and malformed security-code fields are excluded.
  CVV is initially populated and concealed in the capture review editor.
- Accessible frame documents and discovered open Shadow DOM. Frames remain
  independent. A standalone `cc-number` field can offer a partial PAN for trusted
  completion without collecting unrelated document-level fields. Explicit HTML
  form ownership also includes externally associated controls, collected only
  within the existing traversal/work limits.

A memory-only opaque identity distinguishes local card groups. Repeated edits to
the same group and PAN enrich one pending candidate until the person explicitly
clicks Review in the trusted UI. Automatic preview reads and polling continue
to receive updates without selecting it. The explicit action obtains the latest
authorized candidate and freezes that draft, so further page changes cannot replace
the user's choice. Different forms or PANs remain separate candidates. Nothing is
assembled across unrelated forms or frames.

## Review presentation

The inline and native review use the extension Entry identity, buttons and custom controls.
Review expands editable fields; Additional details and Additional fields start
collapsed. Text, multiline, concealed and authenticator custom fields are supported
for all captured editable Entry types. Card names default to a recognized card
network or the generic payment-card label, never the merchant hostname. A successful
save removes the editor and retains a compact, safe summary until Done.

Child-frame capture notices are relayed value-free to the bound top document for
top-right placement. The original payment-frame source remains authoritative for
review/save; cross-frame card-field assembly is not supported.

## Lifecycle and boundaries

Candidates and same-document suppression live only in worker memory: at most eight
pending/suppressed items, with a fixed three-minute expiry that observations do
not extend. Lock/logout and session/account/config changes invalidate all drafts.
Tab navigation/removal and document disconnect invalidate only the affected
source's opaque candidate IDs. Unrelated tab/frame navigation preserves the open
editor's unsaved name, fields and destination Vault. Both preview and explicit
Review responses are fenced against invalidation arriving before their completion.
A worker restart requires a fresh unlock.
Browser-authored tab/frame/document, HTTPS origin, active source and current
account generation are rechecked before review and save.

While locked, bounded local detection may display value-free unlock/re-capture
guidance. The synchronous result is discarded without sending the candidate to
the worker or retaining it through unlock. Unlock performs a fresh observation;
results needing generation intent must be generated again. Account/site mute
preferences and EN/PL UI settings reuse the existing extension preferences.

Exact same-type entries in the selected Vault are compared locally after
decryption. Duplicate saves perform no mutation. Card creation uses canonical
`injectOnly` delivery policy. Persisted extension caches contain ciphertext, not
capture drafts, plaintext secrets or Vault keys. There is no capture telemetry,
network interception, clipboard monitoring, new permission or remote detection
service.

The embedded surface uses private capability handoff and browser-authenticated
Ports, with source/candidate/session authorization repeated before mutation.
Top-layer, ancestry/style and interference guards mitigate page overlays; they
do not guarantee browser-authenticated visibility at the exact click. The
capture-only residual-risk exception in `AGENTS.md` does not extend to generic
Vault APIs, unlock, approvals or reveal.

## Synthetic Chromium acceptance

Run from the extension repository with installed dependencies and Playwright
Chromium:

```sh
npm run test:browser:secret-capture
```

This native-editor corpus builds a production Chromium artifact into a disposable profile,
uses routed HTTPS `*.example.test` pages and a loopback synthetic provider, and
uses the real shared crypto package. The fixture-only loopback host grant does
not change the shipped manifest. Trusted mouse/keyboard events drive observation,
the actual closed notice, native side panel/action popup and explicit save.
Provider-side decryption verifies exact Key/Card content, destination Vault,
captured and concealed CVV and card `injectOnly` policy. The harness waits for the
real content controller's startup status request before interacting; it never
inserts a privileged candidate or save message.

The corpus covers arbitrary Unicode generation labels, EN/PL UI, readonly and
SPA-replaced results, open shadows, PAN-first field enrichment with closed and already-open native UI,
PAN-first external form controls with trusted expiry-select changes, standalone PAN in
an accessible cross-origin frame, missing autocomplete, two card forms, multiple
keys, duplicate/dismiss suppression, synthetic/hidden/documentation negatives,
lock, unrelated tab/frame navigation preserving edits, and own tab/frame navigation
removing the editor before the five-second repair poll. It checks the tested synthetic values against extension
`chrome.storage.local/session/sync`, IndexedDB and native local/session web
storage. The native-popup screenshot at
`test-results/secret-capture/native-key-editor-masked.png` keeps the input
concealed. Only synthetic data is used.

Current same-notification review/save is covered separately by the Chromium
inline capture matrix, including key/card creation and card update. Historical
native-route results above remain native-editor evidence, not proof that page
Review still opens a popup. Firefox installed login evidence and the cancelled
Safari acceptance follow-up are scoped in [browser compatibility](BROWSER-COMPATIBILITY.md).

This is a bounded synthetic corpus, not an internet-wide accuracy percentage or
real-provider acceptance. Full Firefox platform and store/distributed artifact acceptance remain separate.
Native Safari 16.4 remains unverified; the user cancelled further Safari acceptance
work, so it is not a blocker for this task. Closed shadows, canvas, inaccessible frames,
unobservable page state, ambiguous split-frame card assembly and trees beyond
the traversal budget are unsupported. An open shadow attached without an
observable event is discovered on a later scoped scan or interaction. Card
production release gates remain unchanged; see [status](STATUS.md) and
[browser compatibility](BROWSER-COMPATIBILITY.md).

TOTP setup capture has a separate synthetic Chromium acceptance harness:

```sh
npm run test:browser:totp-capture
```

The current harness exercises inline setup review/save from a synthetic setup link, local QR pixel decoding, encrypted Credential
creation and confirmed replacement, manual no-result and ambiguous-result copy,
and extension storage exclusion. The fixture does not establish real-site
compatibility. Destination selection uses the extension autocomplete/custom select; save and
replacement confirmation require native browser input. Cross-origin tainted
images, inaccessible frames, camera and clipboard are outside this flow. When
multiple distinct setups are visible, isolate the intended one and scan again.

After the content script receives a dismissal response, passive TOTP detection is
paused for that document, including changed configurations. The user can scan
again explicitly or navigate to a new document to resume detection. The separate
site-mute action under the Dismiss arrow persists across documents in the active
profile and also suppresses other automatic capture suggestions for that
registrable domain. Explicit Entry-scoped scans remain available. Both the initial
notice and inline Review bind mute to the current worker-owned candidate; lock,
navigation or revoked frame authority prevent preference changes.

Manual QR scanning is an action in a Credential's Entry detail, not in the global
search toolbar. The scan review is scoped to that Entry's worker-approved target
using both Vault and Entry IDs. A manually selected writable Credential may receive
TOTP from a different HTTPS host or without a saved domain after an explicit native
warning confirmation. The worker enforces that confirmation and the Entry revision;
the writer changes only TOTP, never the saved domain. Passive suggestions remain
exact-host, and autofill origin rules are unchanged. Existing TOTP replacement
still requires confirmation. Passive detection offers same-notification inline review
without a permanently visible global scan button.
