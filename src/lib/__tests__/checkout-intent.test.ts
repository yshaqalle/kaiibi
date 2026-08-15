import { checkoutIntent, collectedCents, remainingCents } from '@/lib/checkout-intent';
import type { PaymentLine } from '@/types/models';

const payment = (method: PaymentLine['method'], amountCents: number): PaymentLine => ({
  method,
  amountCents,
  tenderedCents: null,
  customerName: null,
  customerPhone: null,
  currencyCode: null,
  exchangeRate: null,
  foreignAmountCents: null,
  foreignChangeCents: null,
});

const base = {
  cartEmpty: false,
  totalCents: 8474,
  payments: [] as PaymentLine[],
  customerName: null,
  submitting: false,
  secondaryTotal: null,
};

describe('collectedCents', () => {
  it('is zero with no payments', () => {
    expect(collectedCents([])).toBe(0);
  });

  it('adds every payment, however it was tendered', () => {
    expect(collectedCents([payment('cash', 5000), payment('zaad', 3474)])).toBe(8474);
  });
});

describe('remainingCents', () => {
  it('is the whole total before anything is taken', () => {
    expect(remainingCents(8474, [])).toBe(8474);
  });

  it('never goes negative when a cash tender exceeds the bill', () => {
    expect(remainingCents(8474, [payment('cash', 9000)])).toBe(0);
  });
});

describe('checkoutIntent', () => {
  it('refuses an empty cart and says why', () => {
    expect(checkoutIntent({ ...base, cartEmpty: true, totalCents: 0 })).toEqual({
      label: 'Nothing to charge yet',
      hint: null,
      enabled: false,
    });
  });

  it('asks for a payment before one exists', () => {
    const intent = checkoutIntent(base);
    expect(intent.label).toBe('Take a payment');
    expect(intent.enabled).toBe(false);
  });

  it('names what is left when the payments do not cover the bill', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 5000)] });
    expect(intent.label).toBe('Collect the remaining $34.74');
    expect(intent.enabled).toBe(false);
  });

  it('names the amount and the method once it is covered', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)] });
    expect(intent.label).toBe('Charge $84.74 · Cash');
    expect(intent.enabled).toBe(true);
  });

  it('counts the ways instead of naming one method on a split', () => {
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 5000), payment('zaad', 3474)],
    });
    expect(intent.label).toBe('Charge $84.74 · split 2 ways');
  });

  it('says where the receipt goes, in both currencies when there is a second one', () => {
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 8474)],
      customerName: 'Amina Yusuf',
      secondaryTotal: 'SLSH 720,290',
    });
    expect(intent.hint).toBe('Receipt saved to Amina Yusuf · SLSH 720,290');
  });

  it('warns that a walk-in receipt is not saved to anyone', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)] });
    expect(intent.hint).toBe('No customer — the receipt is printed, not saved');
  });

  it('reports its own progress while the sale is being completed', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)], submitting: true });
    expect(intent).toEqual({ label: 'Completing…', hint: null, enabled: false });
  });
});
