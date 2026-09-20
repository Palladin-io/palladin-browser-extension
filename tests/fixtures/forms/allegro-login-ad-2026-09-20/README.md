# Observed Allegro login and separate advertising frame

Observed by the root agent in connected Chrome on 2026-09-20 at the public
Allegro login page (`https://allegro.pl/logowanie`). The supplied sanitized export
preserves the production auth-form subtree and a separately observed advertising
iframe outside that form. It does not preserve the full page, ancestor layout,
iframe contents, or production JavaScript.

Input values, hidden inputs, URLs, SVG and scripts were removed before export.
Only allowlisted attributes and observed display/visibility/opacity styles remain.
The document-level arrangement establishes outside-form membership; it is not a
full-layout reproduction. Test submission handlers and credentials are synthetic.

Expected: the top-frame username/password form can be prepared despite the
unrelated advertising frame. The frame is never traversed or operated.
