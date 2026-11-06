export function cardNetwork(number: string): 'Visa' | 'Mastercard' | 'American Express' | null {
  if (/^4(?:\d{12}|\d{15}|\d{18})$/.test(number)) return 'Visa';
  const prefix = Number(number.slice(0, 4));
  if (/^\d{16}$/.test(number) && (/^5[1-5]/.test(number) || prefix >= 2221 && prefix <= 2720)) return 'Mastercard';
  if (/^3[47]\d{13}$/.test(number)) return 'American Express';
  return null;
}

export function cardNetworkDomain(number: string): string | null {
  const network = cardNetwork(number);
  if (network === 'Visa') return 'visa.com';
  if (network === 'Mastercard') return 'mastercard.com';
  if (network === 'American Express') return 'americanexpress.com';
  return null;
}
