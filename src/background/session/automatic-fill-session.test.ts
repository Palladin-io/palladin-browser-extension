import { expect, it } from 'vitest';
import { AutomaticFillSession } from './automatic-fill-session';
it('has no replacement epoch on startup/lock and never reuses it on unlock or worker restart', () => {
  const session = new AutomaticFillSession(); expect(session.current()).toBeNull();
  session.unlocked(); const first = session.current(); expect(first).toMatch(/^[a-f0-9]{32}$/);
  session.locked(); expect(session.current()).toBeNull();
  session.unlocked(); expect(session.current()).not.toBe(first);
  const restarted = new AutomaticFillSession(); expect(restarted.current()).toBeNull();
  restarted.unlocked(); expect(restarted.current()).not.toBe(session.current());
});
