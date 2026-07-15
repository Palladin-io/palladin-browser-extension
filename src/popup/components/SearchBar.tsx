/**
 * Search field for the unlocked list. Stays visible while the list below it
 * loads (skeleton is scoped to the list region, per the app-wide rule). Matches
 * on name + domain only — see the popup filter for why username is excluded.
 */
export interface SearchBarProps {
  value: string;
  onChange(value: string): void;
}

export function SearchBar({ value, onChange }: SearchBarProps): React.JSX.Element {
  return (
    <div className="search-bar">
      <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true" width="16" height="16">
        <path
          fill="currentColor"
          d="M8.5 3a5.5 5.5 0 0 1 4.38 8.83l3.65 3.64a.9.9 0 0 1-1.28 1.28l-3.64-3.65A5.5 5.5 0 1 1 8.5 3Zm0 1.8a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"
        />
      </svg>
      <input
        type="text"
        className="search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search entries"
        aria-label="Search entries"
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}
