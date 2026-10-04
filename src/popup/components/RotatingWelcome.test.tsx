// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { RotatingWelcome } from './RotatingWelcome';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('web welcome copy', () => {
  it('rotates the same four web lines and wraps to the first', () => {
    vi.useFakeTimers();
    const view = render(<RotatingWelcome />);
    expect(screen.getByText('Zero-knowledge by design.')).toBeInTheDocument();
    for (const line of ['Built for AI agents.', 'Your keys, your rules.', 'Always encrypted.', 'Zero-knowledge by design.']) {
      act(() => vi.advanceTimersByTime(3800));
      act(() => vi.advanceTimersByTime(350));
      expect(screen.getByText(line)).toBeInTheDocument();
    }
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the Polish web copy without rotating under reduced motion', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<I18nProvider locale="pl"><RotatingWelcome /></I18nProvider>);
    act(() => vi.advanceTimersByTime(12000));
    expect(screen.getByText('Zero-knowledge u podstaw.')).toBeInTheDocument();
  });
});
