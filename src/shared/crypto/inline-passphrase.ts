import { generatePassphrase, type PassphraseOptions } from '@palladin/crypto';

export function generateInlinePassphrase(options: PassphraseOptions): string {
  // Inline capture explicitly offers three words; the shared generator has a
  // four-word floor. Each retained word still comes from its independent CSPRNG sample.
  if (options.words === 3) {
    return generatePassphrase({ ...options, words: 4 }).split(options.separator).slice(0, 3).join(options.separator);
  }
  return generatePassphrase(options);
}
