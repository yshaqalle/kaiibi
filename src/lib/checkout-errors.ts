import { formatCents } from '@/lib/currency';
import { cartSubtotalCents } from '@/lib/discounts';
import { errorMessage } from '@/lib/error-message';
import type { CartLine, Promotion } from '@/types/models';

// Real `Error` instances have `.message`, but Supabase's `rpc()`/query errors
// (e.g. PostgrestError from the complete_sale RPC -- "insufficient stock for
// X: has 7, need 100") are plain `{code, details, hint, message}` objects that
// are never `instanceof Error`. The shape check lives in error-message.ts so
// that every screen shares one of it; the sentence below is this domain's, and
// is the only part that belongs here.
export function extractErrorMessage(err: unknown): string {
  return errorMessage(err, 'Could not complete this sale.');
}

// The till was closed underneath this sale -- from another device, by a
// supervisor, or by the same person on another tab. The server is right to
// refuse, but it says so as
// "register session db0eaeff-5d17-404d-b714-8414b6ec755f is already closed",
// which names a UUID at a cashier holding someone's money.
export function isClosedRegisterError(message: string): boolean {
  return /register session .* is already closed/i.test(message);
}

/**
 * The sentence a cashier reads when a sale is refused.
 *
 * complete_sale is right to refuse in each of these cases and wrong about how
 * it says so: every message below names a cause and a next step instead of a
 * row id or a pair of cent totals.
 */
export function checkoutErrorMessage(
  err: unknown,
  cart: CartLine[],
  promotions: Promotion[],
  pricedAt: number,
  now: number = Date.now()
): string {
  const message = extractErrorMessage(err);

  if (isClosedRegisterError(message)) {
    return 'This register was closed while you were ringing this up, so the sale cannot be filed against it. Open a register again — the basket is still here.';
  }

  // Two shapes, one cause. The server refuses an offer outside its window
  // ("promotion Eid weekend has ended"), and separately refuses a total that
  // the payments do not add up to. Pinning the cart's clock makes the second
  // rare, but a basket held open past the server's grace still hits the first,
  // and neither sentence tells a cashier what to do about it.
  const movedWindow = /promotion .* (has ended|has not started yet)/.test(message);
  const mismatch = /payments total \d+ does not match sale total \d+/.test(message);
  if (!movedWindow && !mismatch) return message;

  const wasCents = cartSubtotalCents(cart, promotions, pricedAt);
  const nowCents = cartSubtotalCents(cart, promotions, now);
  if (wasCents === nowCents) return message;

  const direction = nowCents > wasCents ? 'ended' : 'started';
  return `An offer ${direction} while you were ringing this up, so the price changed from ${formatCents(wasCents)} to ${formatCents(nowCents)}. Clear the payment and take it again at the new total.`;
}
