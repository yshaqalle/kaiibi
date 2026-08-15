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

  if (submitting) return { label: 'Completing…', hint: null, enabled: false };
  if (cartEmpty) return { label: 'Nothing to charge yet', hint: null, enabled: false };
  if (payments.length === 0) return { label: 'Take a payment', hint: null, enabled: false };

  const remaining = remainingCents(totalCents, payments);
  if (remaining > 0) {
    return { label: `Collect the remaining ${formatCents(remaining)}`, hint: null, enabled: false };
  }

  const how = payments.length === 1 ? methodLabel(payments[0].method) : `split ${payments.length} ways`;
  const receipt = customerName
    ? `Receipt saved to ${customerName}`
    : 'No customer — the receipt is printed, not saved';

  return {
    label: `Charge ${formatCents(totalCents)} · ${how}`,
    hint: secondaryTotal ? `${receipt} · ${secondaryTotal}` : receipt,
    enabled: true,
  };
}
