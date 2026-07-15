/**
 * Popup placeholder. The real popup (unlock, entry list, search, generator,
 * settings) lands with E1. For now it only shows the wordmark and the current
 * lock status, so the scaffold has a loadable, visible surface.
 *
 * Copy uses a plain hyphen (never an em dash) and no all-caps, per the product
 * copy conventions.
 */

export function App(): React.JSX.Element {
  return (
    <main className="popup">
      <h1 className="wordmark">Palladin</h1>
      <p className="tagline">Zero-knowledge password manager for you and your agents</p>
      <div className="status" role="status">
        <span className="status-dot" aria-hidden="true" />
        Locked
      </div>
    </main>
  );
}
