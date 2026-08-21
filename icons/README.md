# Palladin extension icons

`logo-source.png` is a byte-for-byte copy of the active web-panel asset
`react-web-panel/public/logo.png` (SHA-256
`f316115b354e523c138110f2d3ebaabe7331c966bd23af0c836ba495b4292ab1`).

The committed 16, 32, 48 and 128 px RGBA PNG files are high-quality scaled
derivatives used by every manifest target. The derivatives use the centered
`380x380+10+10` crop of the unchanged 400 px web asset, removing only its outer
transparent margin so the shield stays legible in Chromium's 16 px toolbar.
`scripts/check-icons.mjs` freezes the source, dimensions and reviewed output
checksums so a placeholder or accidental asset change cannot silently ship.

A future brand change must replace the source and all four derivatives together,
update the validator checksums, visually inspect the 16 px and 128 px results,
and pass all target builds.
