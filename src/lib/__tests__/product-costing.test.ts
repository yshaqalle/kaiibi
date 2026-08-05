import { isUncosted, needsCostConfirmation } from '@/lib/product-costing';

describe('isUncosted', () => {
  // The distinction the whole feature rests on: a cost of zero is a real
  // answer someone recorded (a free sample, a gift with purchase), not an
  // absent one. Only null means nobody said. `costOfGoodsSold()` in
  // sales-reporting.ts already draws this line the same way.
  it('treats a null cost as uncosted', () => {
    expect(isUncosted({ costCents: null })).toBe(true);
  });

  it('does NOT treat a zero cost as uncosted', () => {
    expect(isUncosted({ costCents: 0 })).toBe(false);
  });

  it('does not treat a positive cost as uncosted', () => {
    expect(isUncosted({ costCents: 1250 })).toBe(false);
  });
});

describe('needsCostConfirmation', () => {
  it('confirms when a NEW product has a blank cost', () => {
    expect(needsCostConfirmation('', undefined)).toBe(true);
  });

  it('confirms when an edit CLEARS a cost that was set', () => {
    expect(needsCostConfirmation('', 1250)).toBe(true);
  });

  // The row that stops this becoming noise. Opening an already-uncosted
  // product to fix a typo in its name is not a decision about cost, and a
  // dialog there teaches people to dismiss the warning unread.
  it('does NOT confirm when an already-uncosted product stays uncosted', () => {
    expect(needsCostConfirmation('', null)).toBe(false);
  });

  it('does not confirm when a cost is present', () => {
    expect(needsCostConfirmation('12.50', null)).toBe(false);
    expect(needsCostConfirmation('12.50', undefined)).toBe(false);
    expect(needsCostConfirmation('12.50', 1250)).toBe(false);
  });

  // The field is a raw text input; whitespace is not a cost.
  it('treats a whitespace-only cost as blank', () => {
    expect(needsCostConfirmation('   ', undefined)).toBe(true);
  });
});
