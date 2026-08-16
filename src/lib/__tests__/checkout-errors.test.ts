import { checkoutErrorMessage, extractErrorMessage, isClosedRegisterError } from '@/lib/checkout-errors';
import type { CartLine, Product } from '@/types/models';

const product = { id: 'p1', name: 'Balanceful Cica Serum', priceCents: 2200 } as unknown as Product;
const cart: CartLine[] = [{ product, quantity: 1 }];

// A Supabase error is a plain object, not an Error.
const rpcError = (message: string) => ({ code: 'P0001', details: null, hint: null, message });

describe('extractErrorMessage', () => {
  it('reads the reason off a Supabase error object', () => {
    expect(extractErrorMessage(rpcError('insufficient stock'))).toBe('insufficient stock');
  });

  it('reads the reason off a real Error', () => {
    expect(extractErrorMessage(new Error('network down'))).toBe('network down');
  });

  it('falls back to something a cashier can act on', () => {
    expect(extractErrorMessage(null)).toBe('Could not complete this sale.');
    expect(extractErrorMessage('a bare string')).toBe('Could not complete this sale.');
  });
});

describe('isClosedRegisterError', () => {
  it('recognises the server sentence, uuid and all', () => {
    expect(isClosedRegisterError('register session db0eaeff-5d17-404d-b714-8414b6ec755f is already closed')).toBe(true);
  });

  it('does not claim every refusal is a closed till', () => {
    expect(isClosedRegisterError('insufficient stock for Dr Althea: has 7, need 100')).toBe(false);
  });
});

describe('checkoutErrorMessage', () => {
  it('says a closed register in words, and keeps the basket', () => {
    const message = checkoutErrorMessage(
      rpcError('register session db0eaeff-5d17-404d-b714-8414b6ec755f is already closed'),
      cart,
      [],
      Date.now()
    );
    expect(message).toContain('This register was closed while you were ringing this up');
    expect(message).toContain('the basket is still here');
    // The cashier must never be shown the row id.
    expect(message).not.toContain('db0eaeff');
  });

  it('passes an unrelated refusal through as the server said it', () => {
    const message = checkoutErrorMessage(rpcError('insufficient stock for Dr Althea: has 7, need 100'), cart, [], Date.now());
    expect(message).toBe('insufficient stock for Dr Althea: has 7, need 100');
  });

  it('leaves a totals mismatch alone when the price really has not moved', () => {
    const message = checkoutErrorMessage(rpcError('payments total 1440 does not match sale total 1800'), cart, [], Date.now());
    expect(message).toBe('payments total 1440 does not match sale total 1800');
  });
});
