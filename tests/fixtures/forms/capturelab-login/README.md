# CaptureLab extension-reload regression

Observed public source: https://palladin-capture-lab.netlify.app/, Save login,
English, 2026-11-18. The lab is synthetic, not a merchant or provider login.
Expanded lab.js field templates preserve labels, form, input names, types,
autocomplete and required attributes. Relevant form/label/input CSS is retained;
navigation, explanatory text and submit-result handlers are omitted. Article
position is reduced to a fixed visible test layout. No field values are captured.

`node tests/browser/inline-extension-reload.mjs` uses this offline specimen with
an installed Chromium extension and synthetic API/account. Add `--live` to use
the public Netlify DOM instead. Both grant only the lab host in the temporary
manifest to isolate full reload from activeTab-grant expiry. No production
permission changes. This exercises User UI and browser-authenticated worker
transport; Agent Inject and merchant sign-in are not asserted.

RED on 26099cb: working unlocked empty suggestions before reload; native reload
and re-unlock leave the old shield unavailable; page refresh restores it. The
assertion requires working suggestions without refreshing. Developer mode is
explicitly enabled in the disposable profile, and enabled extension state is
checked, so a browser-disabled extension cannot masquerade as this regression.
