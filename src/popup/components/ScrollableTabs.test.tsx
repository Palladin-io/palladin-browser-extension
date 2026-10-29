// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrollableTabs } from './ScrollableTabs';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('shows direction controls only where more tabs exist and scrolls on request', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
  const { container } = render(<ScrollableTabs label="Views" activeKey="first"><button role="tab" aria-selected>First</button><button role="tab">Last</button></ScrollableTabs>);
  const list = screen.getByRole('tablist');
  const scrollBy = vi.fn();
  Object.defineProperty(list, 'scrollBy', { value: scrollBy });
  expect(screen.queryByRole('button', { name: 'Previous tabs' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More tabs' }));
  expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 210 }));
  list.scrollLeft = 200;
  fireEvent.scroll(list);
  expect(screen.queryByRole('button', { name: 'More tabs' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Previous tabs' })).toBeTruthy();
  expect(container.querySelector('.tabs-frame')?.getAttribute('data-overflow-left')).toBe('true');
});
it('does not show scroll controls when all tabs fit', () => {
  render(<ScrollableTabs label="Views" activeKey="first"><button role="tab">First</button></ScrollableTabs>);
  expect(screen.queryByRole('button', { name: 'More tabs' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous tabs' })).toBeNull();
});
