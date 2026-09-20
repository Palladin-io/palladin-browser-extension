# Observed Proton login structure

Captured from `https://account.proton.me/login` on 2026-09-20 during the manual
Palladin acceptance test. `page.html` preserves the observed form, labels,
controls, ownership, autocomplete and button types. Values, scripts, SVGs, links
and non-structural attributes were removed. No credentials or session data are
included.

This fixture does not reproduce production CSS or Proton's event handlers.
Tests use synthetic credentials and explicitly synthetic framework handlers.
Passing them demonstrates Palladin's fill/submit behavior against the observed
structure, not successful authentication against the production service.
