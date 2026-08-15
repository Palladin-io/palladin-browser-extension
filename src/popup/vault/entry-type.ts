/**
 * Entry type codes, redeclared locally for the popup so it can switch on the
 * kind (which copy/fill affordances to show) without importing the background
 * metadata module — that module pulls in the PSL library, which the popup does
 * not need. Values mirror the backend `EntryType` enum.
 */

export const ENTRY_KEY = 0;
export const ENTRY_CREDENTIAL = 1;
export const ENTRY_SCRIPT = 2;
export const ENTRY_CREDIT_CARD = 3;
