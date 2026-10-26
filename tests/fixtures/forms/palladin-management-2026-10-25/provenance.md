# Reduced Palladin management-field specimen

Observed on2026-10-25 in local Chrome, Entry Details: no owning form, text Login,
masked-text Password, one launcher beside Login in the installed extension.
That installed build was not identified; this does not claim its detector is the
current repository detector. The fixture reconstructs the observed structure
from the corresponding FormInput/SecretInput implementation, with IDs, labels,
field types, autocomplete and ignore attributes retained. No authenticated DOM
capture or input value was collected. Layout CSS is a reduced equivalent; the
masking font is named but not bundled. Surrounding navigation, other field
controls and React event handlers are omitted. Marker changes in tests are
synthetic transitions. This is not a complete production specimen or a new
production-form-corpus acceptance entry.

User expectations: marked fields have no shield and refuse generated-value fill;
normal native login fixture still proves launcher removal/rediscovery. With the
marker removed, this masked-text management pair is still not a login under the
current detector: do not fabricate a native password/form to make a shield appear.
Agent live-login expectation: no executable login plan, marked or unmarked.
No submit, origin-policy relaxation or Agent authorization is implied.

RED: restoring the pre-PR credential-form-analysis gate makes the marked-field
fillable/generated-value rejection assertions fail. GREEN: the PR gate rejects.
Unit assertions do not prove real-browser layout or installed-extension behavior;
those acceptance checks remain pending. The original synthetic native-form
contract tests remain separate and prove dynamic launcher teardown/rediscovery.
