// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentInjectDomAccess } from './agent-inject';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() {
  document.body.innerHTML = '<form><span><input type="submit" aria-labelledby="caption" style="opacity:0.01"><span id="caption" aria-hidden="true">Continue</span></span><div id="cover"></div></form>';
  const input = document.querySelector('input')!, label = document.querySelector<HTMLElement>('#caption')!;
  const rect = { x: 10, y: 10, left: 10, top: 10, width: 100, height: 30, right: 110, bottom: 40, toJSON: () => ({}) };
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect);
  const labelRect = vi.spyOn(label, 'getBoundingClientRect').mockReturnValue(rect);
  Object.defineProperties(document.documentElement, { clientWidth: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 800 } });
  const hits = vi.fn((): Element[] => [input, label]);
  Object.defineProperties(document, { elementFromPoint: { configurable: true, value: () => input }, elementsFromPoint: { configurable: true, value: hits } });
  return { input, label, labelRect, rect, hits };
}

it('recognizes a native action painted by its co-located visible ARIA label', () => {
  const { input } = setup();
  expect(createAgentInjectDomAccess(document).isVisible(input)).toBe(true);
});

it.each(['password', 'zero-opacity', 'hidden-label', 'faded-label', 'different-parent', 'distant-label', 'missing-label', 'covered', 'empty-caption'])(
  'does not use the visible action label exception for %s', mutation => {
    const { input, label, labelRect, rect, hits } = setup();
    if (mutation === 'password') input.type = 'password';
    if (mutation === 'zero-opacity') input.style.opacity = '0';
    if (mutation === 'hidden-label') label.style.display = 'none';
    if (mutation === 'faded-label') label.style.opacity = '0.01';
    if (mutation === 'different-parent') document.body.append(label);
    if (mutation === 'distant-label') labelRect.mockReturnValue({ ...rect, left: 500, right: 600, x: 500 });
    if (mutation === 'missing-label') label.remove();
    if (mutation === 'covered') hits.mockReturnValue([document.querySelector('#cover')!, input]);
    if (mutation === 'empty-caption') label.replaceChildren();
    expect(createAgentInjectDomAccess(document).isVisible(input)).toBe(false);
  });
