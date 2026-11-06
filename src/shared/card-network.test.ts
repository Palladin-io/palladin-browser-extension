import { expect, it } from 'vitest';
import { cardNetwork, cardNetworkDomain } from './card-network';
it.each([
 ['4111111111111','Visa'],['4111111111111111','Visa'],['4111111111111111111','Visa'],
 ['5100000000000000','Mastercard'],['5500000000000000','Mastercard'],
 ['2221000000000000','Mastercard'],['2720000000000000','Mastercard'],
 ['340000000000000','American Express'],['370000000000000','American Express'],
 ['2220000000000000',null],['2721000000000000',null],['5600000000000000',null],
 ['411111111111',null],['41111111111111',null],['510000000000000x',null],['6011000000000000',null],
] as const)('recognizes only approved network shapes: %s', (number, network) => {
 expect(cardNetwork(number)).toBe(network);
});
it('maps approved networks to fixed catalog domains, with no merchant fallback for unknown cards', () => {
 expect(cardNetworkDomain('4111111111111111')).toBe('visa.com');
 expect(cardNetworkDomain('5555555555554444')).toBe('mastercard.com');
 expect(cardNetworkDomain('378282246310005')).toBe('americanexpress.com');
 expect(cardNetworkDomain('6011000000000000')).toBeNull();
});
