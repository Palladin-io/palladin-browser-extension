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
its ciphertext. The web page never receives a trusted save receipt from the
extension: page messages are observable/spoofable by page scripts, so success is
shown only in extension-owned UI.

Unsupported snapshots fail as a whole. In particular, this extension writer
cannot yet persist a Key URL; a received `key.url` is rejected instead of
silently dropping it. The web-account save path remains available as fallback.

This is a draft feature branch, not a merged or browser-accepted release.
