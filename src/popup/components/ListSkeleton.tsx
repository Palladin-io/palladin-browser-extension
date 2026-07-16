/**
 * Loading placeholder for the entry list. Scoped to the list region only — the
 * header and search bar stay live while the worker returns the cached metadata.
 */
export function ListSkeleton(): React.JSX.Element {
  return (
    <div className="list-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="skeleton-row">
          <span className="skeleton-icon" />
          <span className="skeleton-lines">
            <span className="skeleton-line skeleton-line--wide" />
            <span className="skeleton-line skeleton-line--narrow" />
          </span>
        </div>
      ))}
    </div>
  );
}
