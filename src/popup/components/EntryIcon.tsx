/**
 * Placeholder entry icon: the first letter of the name in a rounded square. A
 * real favicon/upload comes later; a letter tile is enough to anchor the row and
 * never leaks anything (the name is non-secret metadata). Optional `color` tints
 * the tile with the entry's own colour when the owner set one.
 */
export interface EntryIconProps {
  name: string;
  color?: string;
}

export function EntryIcon({ name, color }: EntryIconProps): React.JSX.Element {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  const style = color ? { backgroundColor: color, color: "#fff" } : undefined;
  return (
    <span className="entry-icon" style={style} aria-hidden="true">
      {letter}
    </span>
  );
}
