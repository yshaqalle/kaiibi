import { formatCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import type { PaymentLine } from '@/types/models';

export type CheckoutIntent = {
  label: string;
  hint: string | null;
  enabled: boolean;
};

export type CheckoutIntentInput = {
  cartEmpty: boolean;
  totalCents: number;
  payments: PaymentLine[];
  customerName: string | null;
  submitting: boolean;
  // The same total in the shop's local currency, already formatted, or null
  // where the shop keeps no second currency.
  secondaryTotal: string | null;
  // The cashier has chosen to let whatever the payments do not cover be carried
  // as a balance. Optional so Phase 1's callers keep compiling unchanged.
  restOwed?: boolean;
  // Money in this transaction that is paying off an OLDER sale rather than this
  // basket. Only ever set with an EMPTY basket: settling is its own transaction,
  // because splitting one tender between a sale and a debt is ambiguous and
  // completing both takes two RPCs that cannot be made atomic. The till enforces
  // that by only offering "Collect it" on an empty till.
  settlingCents?: number;
};

export function collectedCents(payments: PaymentLine[]): number {
  return payments.reduce((sum, payment) => sum + payment.amountCents, 0);
}

// Clamped at zero rather than allowed to go negative: cash is tendered over the
// bill all day long, and `amountCents` is what was APPLIED, so a negative here
// would be a bug in the caller rather than change owed to the customer.
export function remainingCents(totalCents: number, payments: PaymentLine[]): number {
  return Math.max(0, totalCents - collectedCents(payments));
}

// The one sentence the panel and the sheet both read, so the two surfaces can
// never disagree about what the next tap does.
//
// "Checkout" is a door, not a commitment, and a disabled button with no reason
// on it is a dead end -- every branch that cannot fire says which decision is
// missing instead of going grey and silent.
export function checkoutIntent(input: CheckoutIntentInput): CheckoutIntent {
  const { cartEmpty, totalCents, payments, customerName, submitting, secondaryTotal } = input;
  const restOwed = input.restOwed ?? false;
  const settlingCents = Math.max(0, input.settlingCents ?? 0);

  // Goods plus any older debt being paid off in the same breath. Every check
  // below is against this rather than the basket, or a cashier settling an
  // account is told the till is empty.
  const dueCents = totalCents + settlingCents;
  const collected = collectedCents(payments);
  const remaining = Math.max(0, dueCents - collected);

  const receipt = customerName
    ? `Receipt saved to ${customerName}`
    : 'No customer — the receipt is printed, not saved';
  const hint = secondaryTotal ? `${receipt} · ${secondaryTotal}` : receipt;

  if (submitting) return { label: 'Completing…', hint: null, enabled: false };
  if (cartEmpty && settlingCents === 0) return { label: 'Nothing to charge yet', hint: null, enabled: false };
  // Nothing taken and nothing being carried: the next thing to do is take money,
  // whether that is for a basket or for an older account.
  if (payments.length === 0 && !restOwed) return { label: 'Take a payment', hint: null, enabled: false };

  // Leaving the rest owing. Only reachable while something IS still owing --
  // once the payments cover it, "$0.00 owed" is a sentence about nothing and
  // the ordinary charge branch below is the honest one.
  if (restOwed && remaining > 0) {
    if (!customerName) {
      // The server refuses this too ('a sale can only be left unpaid against a
      // customer'). Saying so here means the cashier finds out before the
      // customer is watching.
      return { label: 'Attach a customer to carry the balance', hint: null, enabled: false };
    }
    if (collected === 0) {
      return { label: `Save as unpaid · ${formatCents(remaining)} owed`, hint, enabled: true };
    }
    return { label: `Take ${formatCents(collected)} now · ${formatCents(remaining)} owed`, hint, enabled: true };
  }

  if (remaining > 0) {
    return { label: `Collect the remaining ${formatCents(remaining)}`, hint: null, enabled: false };
  }

  // Paying off an account with nothing in the basket. No method named: what
  // matters is which debt is shrinking, not what it was handed over in.
  if (cartEmpty) {
    return { label: `Take ${formatCents(settlingCents)} off the balance`, hint, enabled: true };
  }

  const how = payments.length === 1 ? methodLabel(payments[0].method) : `split ${payments.length} ways`;

  return {
    label: `Charge ${formatCents(totalCents)} · ${how}`,
    hint,
    enabled: true,
  };
}
