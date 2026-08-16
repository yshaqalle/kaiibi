import { displayCurrency, secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

const currency = (over: Partial<Currency> = {}): Currency => ({
  id: 'cur-1',
  shopId: 'shop-1',
  code: 'SLSH',
  name: 'Somaliland Shilling',
  symbol: 'SLSH',
  rateToUsd: 8500,
  active: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('displayCurrency', () => {
  it('is nothing for a shop that keeps only dollars', () => {
    expect(displayCurrency([])).toBeNull();
  });

  it('is the first active currency', () => {
    const slsh = currency();
    expect(displayCurrency([slsh])).toBe(slsh);
  });

  it('skips an inactive one rather than pricing against a rate nobody maintains', () => {
    const retired = currency({ id: 'cur-0', code: 'ETB', active: false });
    const live = currency();
    expect(displayCurrency([retired, live])).toBe(live);
  });

  it('never picks USD, which is already the primary figure', () => {
    const usd = currency({ id: 'cur-usd', code: 'USD', symbol: '$', rateToUsd: 1 });
    expect(displayCurrency([usd])).toBeNull();
  });
});

describe('secondaryAmount', () => {
  it('is nothing without a second currency', () => {
    expect(secondaryAmount(8474, null)).toBeNull();
  });

  it('converts at the shop rate and prints whole units', () => {
    expect(secondaryAmount(8474, currency())).toBe('720,290 SLSH');
  });

  it('converts zero rather than hiding it', () => {
    expect(secondaryAmount(0, currency())).toBe('0 SLSH');
  });

  it('refuses a rate that cannot convert anything', () => {
    expect(secondaryAmount(8474, currency({ rateToUsd: 0 }))).toBeNull();
  });
});
