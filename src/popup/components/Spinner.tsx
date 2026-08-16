/** Tiny inline spinner for in-flight buttons. Inherits `currentColor`. */
export function Spinner(): React.JSX.Element {
  return (
    <svg className="spinner" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
