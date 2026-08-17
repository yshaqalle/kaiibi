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

  it('takes part now and names what is left owing', () => {
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 5000)],
      customerName: 'Farah Hassan',
      restOwed: true,
    });
    expect(intent.label).toBe('Take $50.00 now · $34.74 owed');
    expect(intent.enabled).toBe(true);
  });

  it('refuses to leave a balance against nobody', () => {
    // A debt with no name on it is a loss to write off, not a receivable. The
    // server refuses this too (`a sale can only be left unpaid against a
    // customer`); the button says so before the cashier finds out the hard way.
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 5000)], restOwed: true });
    expect(intent.label).toBe('Attach a customer to carry the balance');
    expect(intent.enabled).toBe(false);
  });

  it('saves a sale nobody paid for', () => {
    const intent = checkoutIntent({ ...base, customerName: 'Farah Hassan', restOwed: true });
    expect(intent.label).toBe('Save as unpaid · $84.74 owed');
    expect(intent.enabled).toBe(true);
  });

  it('goes back to charging when the payments cover it after all', () => {
    // The choice is still on "pay later" but nothing is left to carry. Saying
    // "$0.00 owed" would be a sentence about nothing.
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 8474)],
      customerName: 'Farah Hassan',
      restOwed: true,
    });
    expect(intent.label).toBe('Charge $84.74 · Cash');
    expect(intent.enabled).toBe(true);
  });

  it('takes money off an older balance with no basket', () => {
    const intent = checkoutIntent({
      ...base,
      cartEmpty: true,
      totalCents: 0,
      settlingCents: 3474,
      payments: [payment('cash', 3474)],
      customerName: 'Farah Hassan',
    });
    expect(intent.label).toBe('Take $34.74 off the balance');
    expect(intent.enabled).toBe(true);
  });

  it('asks for the payment before settling an older balance', () => {
    const intent = checkoutIntent({ ...base, cartEmpty: true, totalCents: 0, settlingCents: 3474 });
    expect(intent.label).toBe('Take a payment');
    expect(intent.enabled).toBe(false);
  });

  it('counts an older balance into what is still to collect', () => {
    // $84.74 of goods plus $34.74 off the account: $50 does not cover it, and
    // the shortfall named has to be the whole of it.
    const intent = checkoutIntent({
      ...base,
      settlingCents: 3474,
      payments: [payment('cash', 5000)],
      customerName: 'Farah Hassan',
    });
    expect(intent.label).toBe('Collect the remaining $69.48');
    expect(intent.enabled).toBe(false);
  });

  it('says both halves when a sale settles an older balance too', () => {
    const intent = checkoutIntent({
      ...base,
      settlingCents: 3474,
      payments: [payment('cash', 11948)],
      customerName: 'Farah Hassan',
    });
    expect(intent.label).toBe('Charge $84.74 + $34.74 off the balance');
    expect(intent.enabled).toBe(true);
  });

  it('still refuses an empty till with nothing being settled', () => {
    const intent = checkoutIntent({ ...base, cartEmpty: true, totalCents: 0, settlingCents: 0 });
    expect(intent.label).toBe('Nothing to charge yet');
    expect(intent.enabled).toBe(false);
  });
});
