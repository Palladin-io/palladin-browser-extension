# API key and payment card capture

The extension offers explicit creation of a new encrypted Key or Credit Card Entry
from a visible HTTPS page. Detection uses HTML structure and standards first,
local context and recognizable provider formats second. A match is a heuristic;
it does not prove that a key is new or usable, or that a card is valid.

The optional closed-shadow notice contains no inputs or secret values. Its Review
action opens the browser-owned side panel where supported. The browser action
popup is also a supported review surface and the fallback when the panel cannot
open. An ordinary extension tab cannot authorize the save. The trusted editor
shows the browser-derived source origin, an explicit destination Vault, concealed
key/PAN fields and the existing Entry form. Review and Vault selection never
write; only **Save entry** creates an encrypted canonical Entry. Capture never
updates or overwrites an existing Entry.

## What is observed

- API keys in visible fields, readonly results and bounded local DOM snapshots.
  A trusted generation action followed by a changed local result can admit a
  known provider format without English labels. Values keep their exact token
  bytes; masked values, documentation/examples, hidden content, UUIDs, password,
  OTP and CSRF fields are excluded.
- Cards after trusted input/change, or blur after a trusted local edit. PAN
  normalization and Luhn are detection signals. HTML `cc-*` attributes are
  preferred; a local expiry/month structure can support missing autocomplete.
  Synthetic autofill events cannot authorize card capture. CVV is not collected
  automatically; users may explicitly add it in the trusted editor.
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

## Synthetic Chromium acceptance

Run from the extension repository with installed dependencies and Playwright
Chromium:

```sh
npm run test:browser:secret-capture
```

The command builds a production Chromium artifact into a disposable profile,
uses routed HTTPS `*.example.test` pages and a loopback synthetic provider, and
uses the real shared crypto package. The fixture-only loopback host grant does
not change the shipped manifest. Trusted mouse/keyboard events drive observation,
the actual closed notice, native side panel/action popup and explicit save.
Provider-side decryption verifies exact Key/Card content, destination Vault,
omitted automatic CVV and card `injectOnly` policy. The harness waits for the
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

This is a bounded synthetic corpus, not an internet-wide accuracy percentage or
real-provider acceptance. Firefox/Safari runtime acceptance and store/distributed
artifact review remain separate. Closed shadows, canvas, inaccessible frames,
unobservable page state, ambiguous split-frame card assembly and trees beyond
the traversal budget are unsupported. An open shadow attached without an
observable event is discovered on a later scoped scan or interaction. Card
production release gates remain unchanged; see [status](STATUS.md) and
[browser compatibility](BROWSER-COMPATIBILITY.md).
