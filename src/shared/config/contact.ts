/** Explicit public contact destination; generic builds do not use Palladin's mailbox. */
export const contactEmail = (import.meta.env.VITE_CONTACT_EMAIL ?? '').trim();
