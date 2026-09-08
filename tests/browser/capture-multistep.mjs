export function multistepPage(url) {
  const mode = url.searchParams.get('mode')
  const kind = url.searchParams.get('kind')
  const step = url.pathname.split('/').at(-1)
  const field = (step) => step === 'email'
    ? '<label>Email<input type="email" autocomplete="email" name="email"></label>'
    : step === 'code' ? '<label>Verification code<input autocomplete="one-time-code" name="code"></label>'
      : `<label>Password<input type="password" autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}" name="password"></label>`
  const next = { email: 'code', code: 'password', password: 'complete' }
  const form = (step) => `<form method="post" action="/multistep/${next[step]}?${url.searchParams}">${field(step)}<button>Continue</button></form>`
  // The same SPA form is reused; success need not include a role=status message.
  return `<!doctype html><html><body><h1>Multi-step account</h1>
    ${step === 'complete' ? '<h2>Welcome</h2>' : form(step)}
    ${mode === 'spa' && step !== 'complete' ? `<script>
      let step = 'email';
      const fields = ${JSON.stringify({ code: field('code'), password: field('password') })};
      document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        step = ({ email: 'code', code: 'password', password: 'complete' })[step];
        if (step === 'complete') document.querySelector('form').innerHTML = '<label>First name<input autocomplete="given-name"></label><button>Continue</button>';
        else document.querySelector('form').innerHTML = fields[step] + '<button>Continue</button>';
      });
    </script>` : ''}</body></html>`
}
