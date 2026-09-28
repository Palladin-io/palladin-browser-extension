# Strong password suggestions

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

Generated passwords are not stored in a separate local history. Copy and fill
remain transient operations; saving a Credential to a Vault is an explicit,
separate action in the existing capture flow. Password history belongs to the
Entry. The popup exposes Vault, Generator and Add entry tabs.

Legacy encrypted recovery records from older versions are not read or extended
by this version. This change does not delete existing browser storage.

Verification: `node tests/browser/generator.mjs` exercises a native Chromium
popup, a trusted inline click, both password fields, absence of automatic Vault
writes and absence of local generator history. Unit tests cover active-tab and
session changes before fill. Firefox/Safari device acceptance remains separate.
