// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('preserves the observed ancestor chain and explicitly selected public context without collecting unrelated branches', () => {
  document.body.innerHTML = '<main id="page"><section id="card"><h1>Create account</h1><form id="signup"><input type="email" value="synthetic-secret"></form><form id="other"><input name="username"></form></section><aside>unselected-private-looking-copy</aside></main>';
  const source = readFileSync('scripts/observe-public-form.mjs', 'utf8').replace('export function', 'function');
  const observe = new Function(`${source}; return observePublicForm;`)() as (selector: string, options?: { contextSelector: string }) => { html: string; context: { omittedBranches: number } };
  const specimen = observe('#signup', { contextSelector: '#card' });
  expect(specimen.html).toContain('<main id="page"');
  expect(specimen.html).toContain('<section id="card"');
  expect(specimen.html).toContain('<h1');
  expect(specimen.html).toContain('id="other"');
  expect(specimen.html).not.toContain('synthetic-secret');
  expect(specimen.html).not.toContain('unselected-private-looking-copy');
  expect(specimen.context.omittedBranches).toBeGreaterThan(0);
  expect(() => observe('#signup', { contextSelector: 'aside' })).toThrow('must contain');
});

it('preserves anchor navigation presence without reading or retaining its target', () => {
  document.body.innerHTML = '<form><a href="https://site.test/?synthetic-token" class="button">Register</a><a class="button">Log in</a></form>';
  const source = readFileSync('scripts/observe-public-form.mjs', 'utf8').replace('export function', 'function');
  const observe = new Function(`${source}; return observePublicForm;`)() as (selector: number) => { html: string };
  const html = observe(0).html;
  expect(html).toContain('href="#form-specimen-navigation"');
  expect(html).not.toContain('synthetic-token');
  document.body.innerHTML = html;
  expect(document.querySelectorAll('a[href]')).toHaveLength(1);
  expect(document.querySelectorAll('a.button:not([href])')).toHaveLength(1);
});

it('preserves public shadow boundaries and slots while redacting nested field values and scripts', () => {
  document.body.innerHTML = '<form><public-field><span slot="caption">Email</span></public-field></form>';
  const host = document.querySelector('public-field')!;
  host.attachShadow({ mode: 'open' }).innerHTML = '<label><slot name="caption"></slot><input type="email" value="synthetic-secret"><script>synthetic-script</script><textarea>synthetic-text</textarea></label>';
  const source = readFileSync('scripts/observe-public-form.mjs', 'utf8').replace('export function', 'function');
  const observe = new Function(`${source}; return observePublicForm;`)() as (selector: number) => { html: string; css: string; fields: { type: string }[] };
  const specimen = observe(0);
  expect(specimen.html).toContain('data-form-specimen-shadow="open"');
  expect(specimen.html).toContain('slot="caption"');
  expect(specimen.html).not.toContain('synthetic-');
  expect(specimen.fields.map(field => field.type)).toEqual(['email', 'textarea']);
  document.body.innerHTML = specimen.html;
  const replay = readFileSync('scripts/replay-form-specimen.mjs', 'utf8').replaceAll('export function', 'function');
  const hydrate = new Function(`${replay}; return hydrateFormSpecimen;`)() as (root: Element, css: string) => void;
  hydrate(document.body, specimen.css);
  const restored = document.querySelector('public-field')!.shadowRoot!;
  expect(restored.querySelector('input')!.value).toBe('');
  expect(restored.querySelector('slot')!.assignedNodes()[0]?.textContent).toBe('Email');
});

it('retains public input-button captions without collecting editable, hidden or button payload values', () => {
  document.body.innerHTML = '<form><input name="email" value="synthetic-email"><input type="password" value="synthetic-password"><input type="hidden" value="synthetic-token"><textarea>synthetic-text</textarea><input type="submit" value="Next"><input type="button" value="Back"><button value="synthetic-payload">Continue</button></form>';
  // The capture snippet runs inside a browser via Playwright; use the exact same
  // source here, without requiring a TypeScript runtime contract for the helper.
  const source = readFileSync('scripts/observe-public-form.mjs', 'utf8').replace('export function', 'function');
  const observe = new Function(`${source}; return observePublicForm;`)() as (selector: number) => { html: string };
  const html = observe(0).html;
  expect(html).toContain('value="Next"');
  expect(html).toContain('value="Back"');
  expect(html).not.toContain('synthetic-');
});

it('preserves request method and encoding semantics while excluding action URLs', () => {
  document.body.innerHTML = '<form method="post" enctype="multipart/form-data" action="https://site.test/?synthetic-token"><input name="email"><button type="submit" formmethod="get" formenctype="application/x-www-form-urlencoded" formaction="https://site.test/?synthetic-action-token">Continue</button></form>';
  const source = readFileSync('scripts/observe-public-form.mjs', 'utf8').replace('export function', 'function');
  const observe = new Function(`${source}; return observePublicForm;`)() as (selector: number) => { html: string };
  const html = observe(0).html;
  expect(html).toContain('method="post"');
  expect(html).toContain('enctype="multipart/form-data"');
  expect(html).toContain('formmethod="get"');
  expect(html).toContain('formenctype="application/x-www-form-urlencoded"');
  expect(html).not.toContain('synthetic-token');
  expect(html).not.toContain('synthetic-action-token');
  expect(html).not.toContain('action=');
});
