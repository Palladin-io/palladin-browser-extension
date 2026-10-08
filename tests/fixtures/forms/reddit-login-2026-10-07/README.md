# Reddit login: reduced open-shadow fixture

Observed empty public controls on 2026-10-07 at https://www.reddit.com/login. Native username and password inputs live inside open `faceplate-text-input` roots and have no native form owner. Username metadata: text, name=username, autocomplete="username webauthn". Password metadata: password, name=password, autocomplete=current-password.

This reduction keeps the custom faceplate-form and fieldsets, inserts a synthetic outer shadow root, and omits unrelated navigation, tabs, CSS, and service scripts. The button caption and event handlers are synthetic. It verifies public DOM discovery and composed events; it is not a live Reddit authentication or layout result.

User expectation: detect one pair, automatic fill without overwriting or submitting, manual popup fill. Agent execution is not asserted: this fixture does not provide an authoritative execution action.
