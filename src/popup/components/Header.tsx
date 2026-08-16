import type { SessionStatus } from "../../background/session/types";

/**
 * Popup header: the wordmark plus a small status chip mirroring the lock state,
 * so the coarse session state is visible on every screen (matching the toolbar
 * badge). Hidden on the initial `loading` phase where the state isn't known yet.
 */
export interface HeaderProps {
  status?: SessionStatus | undefined;
}

const CHIP: Record<SessionStatus, { label: string; dot: string }> = {
  unlocked: { label: "Unlocked", dot: "status-dot--unlocked" },
  locked: { label: "Locked", dot: "status-dot--locked" },
  "signed-out": { label: "Signed out", dot: "" },
};

export function Header({ status }: HeaderProps): React.JSX.Element {
  const chip = status ? CHIP[status] : null;
  return (
    <header className="popup-header">
      <h1 className="wordmark">Palladin</h1>
      {chip ? (
        <span className="status-chip" role="status">
          <span className={`status-dot ${chip.dot}`.trim()} aria-hidden="true" />
          {chip.label}
        </span>
      ) : null}
    </header>
  );
}
