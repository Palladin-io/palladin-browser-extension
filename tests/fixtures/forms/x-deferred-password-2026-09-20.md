# X password-stage specimen

Observed on 2026-09-20 in connected Chrome after Palladin submitted the identifier
stage. `x-deferred-password-2026-09-20.html` retains the observed native form
subtree, public labels, input semantics, disabled identity and computed
visibility/display/opacity. Values, URLs, classes, handlers, hidden inputs and
resource attributes were omitted before export. Empty SVG paths contain no
geometry or resources. Outer layout and the separate search form were omitted.
The disabled identity receives only synthetic data during local replay.

No post-password-input transition or production JavaScript was captured.
Tests that enable a native Continue button after an input event are explicitly
synthetic. This specimen demonstrates the initial structure, not a successful
production authentication or full-page detector coverage.

On base 37a7b00 the unchanged specimen produced no plan; the regression expected
an explicit deferred password plan with a comparison-only carried identity.
The same generic policy also covers password-only native forms. A separate
synthetic queued-state regression demonstrated that immediate synchronous
write-and-click submitted before a framework microtask/timer updated its state.
