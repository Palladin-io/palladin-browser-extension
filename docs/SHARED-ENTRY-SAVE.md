# Save a received Entry through the extension (CVT-673)

The public `/share/{id}` page may offer an optional extension save after it has
already decrypted and displayed a received Entry. No second recipient delivery
occurs. The page and extension retain separate accounts and keys; an unlocked
extension never unlocks the web panel.

The page sends the whole `palladin.entry-share.v1` snapshot only after an
explicit Save click. The isolated content script validates the typed message
and forwards it. The worker independently checks the browser-issued top-frame
document ID, live document URL, configured web/API environment, unlocked session
identity and VaultManage presentation permission. Backend write authorization
remains authoritative. A pending snapshot stays in worker RAM for at most two
minutes; lock, session replacement, tab navigation, cancel, timeout and worker
restart discard it. No key or pending plaintext enters extension storage.

The popup/side panel shows only Entry identity and destination Vault names.
Saving requires an explicit extension-owned confirmation. The worker checks all
bindings again immediately before the encrypted create request. The canonical
writer creates a new independent Entry and the normal Member sync distributes
its ciphertext. The extension-owned UI shows the authoritative confirmation.
The page can ask the worker to reconcile the original handoff ID from the same
browser document: pending, explicitly cancelled, saved, or unknown. A confirmed
cancellation enables the alternate web-account save; unknown remains blocked
to avoid a duplicate. The page response is presentation-only and not a trusted
backend save receipt, because page messages are observable/spoofable by page scripts.

Unsupported snapshots fail as a whole. Received Key entries preserve an optional
`key.url` with its field-access policy in the current Vault plaintext model; the
extension uses the current canonical writer for shared copies and the current
reader for Entry reveal. Existing legacy Entry ciphertext remains readable. The
web-account save path remains available as fallback.

This is a draft feature branch, not a merged or browser-accepted release.
