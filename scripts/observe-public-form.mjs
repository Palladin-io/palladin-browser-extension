/** Read-only DOM projection. Invoke only on an inspected PUBLIC form, never an account page.
 * No live field values, URLs, handlers, scripts, or CSS resources are read.
 * Only input submit/button value attributes are retained as public action captions.
 * Computed layout is frozen for structural browser replay, not a pixel-perfect screenshot.
 */
export function observePublicForm(selector, options = {}) {
  const root = typeof selector === 'number' ? document.forms[selector] : document.querySelector(selector);
  if (!root) throw new Error('Observed form root not found');
  const contextRoot = options.contextSelector ? document.querySelector(options.contextSelector) : root;
  const parent = node => node.parentElement ?? node.getRootNode().host ?? null;
  const contains = (ancestor, node) => {
    for (let current = node; current; current = parent(current)) if (current === ancestor) return true;
    return false;
  };
  if (!contextRoot || !contains(contextRoot, root)) throw new Error('Observed context must contain the selected form');
  if (contextRoot === document.body || contextRoot === document.documentElement) {
    throw new Error('Select a reviewed public form context, not the whole document');
  }
  // Keep real ancestor shells, but never sweep unrelated page branches into a
  // fixture. The caller explicitly selects the wider public card/dialog to keep
  // headings, sibling forms and externally associated fields after inspection.
  const ancestors = new Set();
  let outer = contextRoot;
  while (parent(outer) && parent(outer) !== document.body && parent(outer) !== document.documentElement) {
    outer = parent(outer);
    ancestors.add(outer);
  }
  let omittedBranches = 0;
  const allowed = new Set(['id', 'class', 'name', 'type', 'autocomplete', 'role',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-invalid',
    'disabled', 'readonly', 'hidden', 'inert', 'form', 'for', 'required', 'minlength',
    'maxlength', 'pattern', 'tabindex', 'placeholder', 'data-testid', 'inputmode',
    'multiple', 'min', 'max', 'step', 'checked', 'selected', 'novalidate', 'formnovalidate', 'slot',
    'method', 'enctype', 'formmethod', 'formenctype']);
  const properties = ['display', 'visibility', 'opacity', 'pointer-events', 'position',
    'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'order', 'flex-grow', 'flex-shrink',
    'flex-basis', 'align-self', 'vertical-align', 'letter-spacing', 'appearance',
    'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'padding', 'margin', 'border-width', 'border-style', 'overflow', 'overflow-x',
    'overflow-y', 'clip', 'clip-path', 'transform', 'flex-direction', 'flex-wrap',
    'align-items', 'justify-content', 'gap', 'grid-template-columns', 'grid-template-rows',
    'font-size', 'line-height', 'font-weight', 'white-space', 'text-align'];
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const css = [];
  const fields = [];
  let index = 0;
  function walk(node) {
    if (node.nodeType === 3) return escape(node.textContent || '');
    if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.tagName)) return '';
    const id = String(index++);
    if (node.matches('input,select,textarea')) fields.push(node);
    const computed = getComputedStyle(node);
    css.push(`[data-form-specimen-node="${id}"] { ${properties.map(property => {
      const value = computed.getPropertyValue(property);
      return /url\s*\(/i.test(value) ? '' : `${property}:${value};`;
    }).join(' ')} }`);
    const tag = node.tagName.toLowerCase();
    const attrs = [...node.attributes].filter(attribute => allowed.has(attribute.name)
      || (attribute.name === 'value' && tag === 'input' && ['submit', 'button'].includes(node.type)))
      .map(attribute => ` ${attribute.name}="${escape(attribute.value)}"`).join('')
      // Preserve navigation-vs-action shape without reading a URL or query token.
      + (tag === 'a' && node.hasAttribute('href') ? ' href="#form-specimen-navigation"' : '');
    const selectedChildren = nodes => [...nodes].filter(child => {
      if (!ancestors.has(node) || child === contextRoot || ancestors.has(child)) return true;
      omittedBranches++;
      return false;
    });
    const children = ['TEXTAREA', 'SVG'].includes(node.tagName) ? '' : selectedChildren(node.childNodes).map(walk).join('');
    // Open roots are public DOM too. Preserve their boundary, slots and recorded
    // controls; replay hydrates only these inert templates. Closed roots stay opaque.
    const shadow = node.shadowRoot ? '<template data-form-specimen-shadow="open">'
      + selectedChildren(node.shadowRoot.childNodes).map(walk).join('') + '</template>' : '';
    return `<${tag}${attrs} data-form-specimen-node="${id}">` + children + shadow +
      (/^(input|br|hr|img|meta|area|base|col|param|source|track|wbr)$/.test(tag) ? '' : `</${tag}>`);
  }
  const html = walk(outer);
  return { html, css: css.join('\n'), viewport: { width: innerWidth, height: innerHeight },
    context: { mode: options.contextSelector ? 'explicit-public-context' : 'ancestor-shells',
      ancestorCount: ancestors.size, omittedBranches, wholePage: false },
    fields: fields.map(field => ({
      id: field.id, name: field.name, type: field.type, autocomplete: field.autocomplete,
      display: getComputedStyle(field).display, visibility: getComputedStyle(field).visibility,
      clientRectCount: field.getClientRects().length,
      hiddenAncestor: (() => {
        for (let node = field; node; node = node.assignedSlot ?? node.parentElement ?? node.getRootNode().host) {
          const style = getComputedStyle(node);
          if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
            || Number.parseFloat(style.opacity) === 0) return true;
        }
        return false;
      })(),
    })) };
}
