import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Animate size without retaining plaintext fields during the saved-state transition. */
export function CaptureTransition({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = outer.current, content = inner.current;
    if (!container || !content || container.closest('.capture-frame') || typeof ResizeObserver === 'undefined') return;
    let height = content.getBoundingClientRect().height;
    let animation: Animation | undefined;
    const observer = new ResizeObserver(() => {
      const next = content.getBoundingClientRect().height;
      if (Math.abs(next - height) < 1) return;
      const previous = animation?.playState === 'running' ? container.getBoundingClientRect().height : height;
      height = next;
      animation?.cancel();
      if (previous > 0 && typeof container.animate === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        animation = container.animate([{ height: `${previous}px` }, { height: `${next}px` }], { duration: 240, easing: 'ease-out' });
      }
    });
    observer.observe(content);
    return () => { observer.disconnect(); animation?.cancel(); };
  }, []);
  return <div ref={outer} className="capture-transition"><div ref={inner}>{children}</div></div>;
}
