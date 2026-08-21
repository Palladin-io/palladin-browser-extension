import type { ReactNode } from "react";

export interface SettingsSectionProps {
  id: string;
  title: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}

/** A compact, keyboard-accessible settings disclosure row. */
export function SettingsSection({
  id,
  title,
  open,
  onToggle,
  children,
}: SettingsSectionProps): React.JSX.Element {
  const panelId = `${id}-panel`;
  return (
    <section className={`settings-section${open ? " settings-section--open" : ""}`}>
      <h2 className="settings-section-heading">
        <button
          type="button"
          className="settings-section-trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span>{title}</span>
          <svg
            className="settings-section-chevron"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h2>
      {open ? (
        <div id={panelId} className="settings-section-content">
          {children}
        </div>
      ) : null}
    </section>
  );
}
