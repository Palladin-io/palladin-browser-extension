# CaptureLab masked CVC regression

Source: synthetic https://palladin-capture-lab.netlify.app/ card scenario, inspected 2026-11-08 in tests/manual/capture-lab/site/lab.js of the extension-capture-lab worktree. Expanded field()/submit() templates preserve form structure, labels, names, types, autocomplete and required attributes. CSS retains field visibility and row layout; surrounding navigation, instructional text and application result scripts are omitted. This is a synthetic lab specimen, not a production payment provider.

User automatic and explicit Credential fill must not select this form. The Agent shared login classifier must likewise find no login target. Card capture must include only a 3/4-digit CVC from the same form, including masked controls. Browser test uses real Chromium input/blur events, runs the isolated DOM adapters directly, and does not certify full worker authorization, encrypted save or deployed-site acceptance.

## Regression evidence

- Date/UI: 2026-11-08, English Payment details, headless Chromium, synthetic isolated DOM adapters; no installed extension unlock or real account used.
- Baseline: e7799d4, before the payment semantics correction.
- RED: `node tests/browser/capturelab-card.mjs` failed four behavioral assertions: automatic Credential fill wrote into CVC, explicit Credential fill accepted CVC, and masked three/four-digit CVC was missing after actual Chromium input/blur events. `npx vitest run src/content/isolated/capturelab-card.test.ts` also failed classifier and both capture assertions.
- GREEN: same browser command passes with the working-tree fix. Focused fill/inline/submission/secret detection tests and typecheck pass.
- Negative boundaries: malformed CVC is omitted, another form's numeric login password is never substituted, ordinary login remains discoverable, explicit card CVV filling remains supported.
- Shared User/Agent classifier: no login target for this specimen. Agent live-login regression suite passes; actual CLI delivery has not been exercised here.
- Deployed site, encrypted save/Vault result, shield positioning and full worker transport: not tested by this adapter fixture. No claim of deployed acceptance or timing metrics.
