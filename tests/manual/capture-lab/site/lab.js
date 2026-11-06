const params = new URLSearchParams(location.search);
const field = (label, name, autocomplete, type = 'text') => `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" required></label>`;
const username = field('Username', 'username', 'username');
const password = (label = 'Password', name = 'password', autocomplete = 'current-password') => field(label, name, autocomplete, 'password');
const submit = text => `<button class="primary" type="submit">${text}</button>`;
const commonChecks = ['Notice appears in the top-right corner with the right site and item.', 'Review, additional fields, Vault selection and save work in Palladin.', 'Dismiss, site muting and opening the saved item work.'];
const scenarios = {
  login: {name:'Save login', title:'Sign in', description:'A normal login form followed by a local success state.', form:`<form>${username}${password()}${submit('Sign in')}</form>`, steps:['Type the username and password below.', 'Click Sign in and review the Palladin notification.', 'Save to a test Vault. Repeating identical credentials should not create another entry.'], values:[['Username','capture-user@example.test'],['Password','Lab-first-password-42!']], checks:commonChecks},
  update: {name:'Update password', title:'Change password', description:'Use the same username as a login you saved on this host.', form:`<form>${username}${password('Current password','old')}${password('New password','password','new-password')}${password('Confirm new password','confirm','new-password')}${submit('Change password')}</form>`, steps:['Save the login scenario first, then restart here.', 'Enter the same username, old password and a different new password.', 'Submit. Check the selected matching entry and update confirmation.'], values:[['Username','capture-user@example.test'],['Current password','Lab-first-password-42!'],['New password','Lab-updated-password-43!']], checks:['The matching login is suggested instead of an unrelated account.', 'Review preserves other fields and saves the new password.', 'Repeat with automatic update enabled in the entry, then verify the result there.']},
  card: {name:'Payment card', title:'Payment details', description:'Enter the card number last so the first capture includes the other fields.', form:`<form>${field('Cardholder name','cardholder','cc-name')}<div class="row">${field('Expiry month','month','cc-exp-month')}${field('Expiry year','year','cc-exp-year')}</div>${field('CVC / CVV','cvc','cc-csc','password')}${field('Card number','number','cc-number')}${submit('Continue')}</form>`, steps:['Type the cardholder, expiry and CVC first.', 'Type or paste the public test card number last, then leave the field.', 'Review the card, including CVC. Save, reload and change the expiry to test an update.'], values:[['Cardholder','Capture User'],['Month / year','12 / 2031'],['CVC','123'],['Visa','4242 4242 4242 4242'],['Mastercard','5555 5555 5555 4444'],['American Express','3782 822463 10005 (CVC: 1234)']], checks:['Brand and last digits identify the card; the name is editable.', 'Expiry and CVC are captured together in the same form.', 'Same-card update and additional fields work.']},
  key: {name:'API key', title:'API keys', description:'Create a local, non-functional token to exercise generated-key detection.', form:'<section><h3>Create API key</h3><button id="generate-key" class="primary" type="button">Generate API key</button><div id="key-result"></div></section>', steps:['Click Generate API key.', 'Review the actual Palladin notification.', 'Save with a name, URL and additional fields. Generate again to test another capture.'], values:[['Token','Generated locally; deliberately unusable.']], checks:commonChecks},
  generator: {name:'Strong password', title:'Create an account', description:'Focus the new-password field and use the inline Palladin suggestion.', form:`<form>${username}${password('New password','password','new-password')}${password('Confirm password','confirm','new-password')}${submit('Create account')}</form>`, steps:['Enter a fictional username.', 'Focus New password and open the Palladin control beside the input.', 'Check generation options, refresh, dismiss and Use strong password. Submit to test capture.'], values:[['Username','new-capture-user@example.test']], checks:['The suggestion stays beside the field.', 'Options animate and length/character choices affect the generated password.', 'Using a password fills the appropriate fields; it does not submit the form.']},
  totp: {name:'Authenticator', title:'Set up authenticator', description:'Reveal one setup method at a time. The QR and link use the same public fixture seed.', form:'<div class="provider-actions"><button id="show-link">Reveal setup link</button><button id="show-qr">Reveal QR code</button></div><div id="totp-result"></div>', steps:['Save a login on this host first to test matching-entry selection.', 'Reveal a setup link or QR and review the notification.', 'For manual scanning: open the existing login in Palladin and choose Scan authenticator QR code.'], values:[['Issuer / account','Synthetic / alice'],['Seed','Public browser-test fixture; never use it for a real account.']], checks:['An existing matching login is suggested.', 'Without a matching login, a new-login option is offered.', 'Replacement requires confirmation; a manual scan targets the selected entry.']},
  oauth: {name:'Login method', title:'Continue with a provider', description:'Available in the isolated Chromium launcher. The hosted lab never opens real provider authorization.', form:'<p id="oauth-status">Run npm run lab:capture in the extension repository. It opens a disposable browser with synthetic provider pages and a test Vault.</p><div class="provider-actions"><button id="google" disabled>Continue with Google</button><button id="github" disabled>Continue with GitHub</button></div>', steps:['Start the isolated launcher from the repository.', 'Choose Google or GitHub and Allow on the synthetic provider page.', 'Review the provider icon, account choice and matching existing entry. Repeat with Cancel.'], values:[['Provider accounts','Synthetic only, in the disposable browser.']], checks:['Provider and service are clearly distinguished.', 'Existing-entry autocomplete prioritizes this site.', 'Cancelled authorization produces no save prompt.']},
  frame: {name:'Embedded card', title:'Embedded checkout', description:'Same-origin payment frame. The isolated launcher also supports a separate payment origin.', form:'<iframe title="Payment details" src="?scenario=card&amp;embedded=1"></iframe>', steps:['Fill the embedded card form, number last.', 'Review the top-page notice and captured source.', 'Save, then reload before trying another card.'], values:[['Visa','4242 4242 4242 4242'],['Expiry / CVC','12 / 2031 / 123']], checks:['One top-level notification appears.', 'Only fields from this payment form are combined.', 'CVC remains available in the native review.']}
};
const selected = Object.hasOwn(scenarios, params.get('scenario')) ? params.get('scenario') : 'login';
const scenario = scenarios[selected];
if (params.get('embedded') === '1') document.body.classList.add('embedded');
document.querySelector('nav').innerHTML = Object.entries(scenarios).map(([id, s]) => `<a href="?scenario=${id}" ${id === selected ? 'aria-current="page"' : ''}>${s.name}</a>`).join('');
document.querySelector('#number').textContent = String(Object.keys(scenarios).indexOf(selected) + 1).padStart(2, '0');
document.querySelector('#title').textContent = scenario.title;
document.querySelector('#description').textContent = scenario.description;
document.querySelector('#fixture').innerHTML = scenario.form;
document.querySelector('#steps').innerHTML = scenario.steps.map(s => `<li>${s}</li>`).join('');
document.querySelector('#checks').innerHTML = scenario.checks.map(s => `<li>${s}</li>`).join('');
document.querySelector('#values').innerHTML = scenario.values.map(([label, value]) => `<p>${label}<br><code>${value}</code></p>`).join('');
// No form values are read, sent, logged or persisted. Remove the form only after
// the extension's trusted submit listener has observed it.
document.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  setTimeout(() => {
    const result = document.createElement('div');
    result.className = 'result';
    result.setAttribute('role', 'status');
    const status = selected === 'update' ? 'Password successfully changed' : selected === 'generator' ? 'Account created' : selected === 'login' ? 'Successfully signed in' : 'Payment details accepted';
    result.innerHTML = `<strong>${status}</strong><p>Local simulation only. Check Palladin for capture and save status.</p>`;
    form.replaceWith(result);
  }, 0);
});
let generation = 0;
document.querySelector('#generate-key')?.addEventListener('click', () => {
  const output = document.createElement('output');
  output.textContent = `sk_test_PalladinCaptureLabNotARealKey${String(++generation).padStart(8, '0')}`;
  document.querySelector('#key-result').replaceChildren(output);
});
document.querySelector('#show-link')?.addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = 'otpauth://totp/Synthetic:alice?secret=JBSWY3DPEHPK3PXP&issuer=Synthetic';
  link.textContent = 'Set up authenticator';
  link.addEventListener('click', event => event.preventDefault());
  document.querySelector('#totp-result').replaceChildren(link);
});
document.querySelector('#show-qr')?.addEventListener('click', () => {
  const qr = document.createElement('img');
  qr.id = 'qr'; qr.alt = 'Authenticator setup QR'; qr.src = 'totp.png';
  document.querySelector('#totp-result').replaceChildren(qr);
});
// This marker is injected only by the routed launcher, never accepted from URL parameters.
if (document.documentElement.dataset.isolatedLab === 'true') {
  const service = location.origin;
  for (const provider of ['google', 'github']) {
    const button = document.getElementById(provider);
    if (!button) continue;
    button.disabled = false;
    button.addEventListener('click', () => {
      const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', 'synthetic-capture-lab');
      url.searchParams.set('redirect_uri', `${service}/callback`);
      url.searchParams.set('state', 'synthetic-lab-state');
      location.assign(url.href);
    });
  }
  const status = document.querySelector('#oauth-status');
  if (status) status.textContent = 'Isolated mode: provider requests are intercepted locally. No real provider connection or account is used.';
  if (selected === 'frame') document.querySelector('iframe').src = 'https://payment.example.test/?scenario=card&embedded=1';
}
