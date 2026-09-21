import { generateNonce } from '@shared/messaging';

/** Private worker->isolated provenance epoch. No key/identity material and no
 * persistence. Restart and lock have no epoch; every unlock rotates it. */
export class AutomaticFillSession {
  private marker: string | null = null;
  unlocked(): void { this.marker = generateNonce(); }
  locked(): void { this.marker = null; }
  current(): string | null { return this.marker; }
}
export const automaticFillSession = new AutomaticFillSession();
