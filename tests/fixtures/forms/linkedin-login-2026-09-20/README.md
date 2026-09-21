# Observed LinkedIn login variants

Captured from the public Polish `https://www.linkedin.com/login/` page on
2026-09-20. Exact nesting and ordering of two formless variants is retained;
computed `display:none` of the hidden variant is encoded. Visible fields use
IDs «r3»/«r4», the hidden variant «r0»/«r1».

Capture never read input values. Classes, non-input IDs, scripts, SVG, iframe,
images and URL attributes were removed; links use `#fixture-navigation`.
Ancestors outside the nearest common two-variant container were omitted. This
is observed structural evidence, not production CSS or framework behavior.
Browser replay adds synthetic CSS, credentials and event handlers.
