# Strong password suggestions and local recovery

CVT-664 / CVT-665 / CVT-666; uses the reviewed `@palladin/crypto` 0.10.0
registry release (CVT-670).

On a top-frame HTTPS form explicitly marked `autocomplete="new-password"`,
focusing an empty new-password field offers a 20-character CSPRNG password with
letters, digits and symbols. A trusted action in the extension-owned closed
shadow surface requests generation. There is no automatic overwrite or submit.
An operation ID binds the response to that particular action; cancel, navigation,
typing or disabling suggestions invalidates it. The worker rechecks the sender,
browser document, active tab and exact origin. The isolated script checks the
candidate and empty fields again before writing, including rendered visibility
for inline operations. Confirmation receives the same value.

Unclassified password fields, nonstandard forms, iframes and HTTP pages are not
eligible. A conflicting minimum/maximum length or a nonempty `pattern` blocks
this initial inline flow. Use the popup to configure a password and copy it when
the site has a custom policy. This release does not parse arbitrary page regexes
or infer registration from localized labels.

Before any generator copy or fill, the background worker durably stores an
encrypted recovery copy. A storage/decryption failure prevents issuing a new
password. A later failed fill may leave an unused recovery copy, which is safer
than losing a password already exposed to a page. Saving a Credential to a Vault
remains an explicit, separate action in the existing capture flow.

History is local to the browser profile, account and API URL. The namespace is
`palladin.generator-history.v1:<encoded-api-url>:<account-id>`. Only the crypto
version and ciphertext are outside encryption; password, origin and timestamp
are inside. The key is derived by shared crypto from the unlocked user private
key and independently authenticated scope; no key is persisted. Lock and restart
require a fresh unlock before reveal. Changing the private key makes old history
unreadable; a master-password-only change does not. Clearing browser data removes
this local recovery copy. History is neither a synchronized backup nor an Entry.

The history tab requests metadata first, reveals values on explicit action and
supports copy and deletion. Capacity is 200 records; reaching it refuses a new
recovery copy instead of silently evicting the oldest password. Delete selected
records or explicitly confirm clearing history to free space. There is no timed
expiration. Disabling inline suggestions does not delete existing history.

Verification: `node tests/browser/generator.mjs` exercises a native Chromium
popup, a trusted inline click, both password fields, absence of automatic Vault
writes, ciphertext-only storage and reveal after browser restart. Unit tests
cover scope substitution, corrupt history, capacity, failed persistence,
concurrent writes, lock during read and cancellation/replay. Validation installs
the exact published registry dependency. Firefox/Safari device acceptance remains
separate.
