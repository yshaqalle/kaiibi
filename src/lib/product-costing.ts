import type { Product } from '@/types/models';

// A product nobody recorded a purchase cost for.
//
// NULL, not zero and not falsy. Zero is a real answer — a free sample, a gift
// with purchase, a promotional unit — and counting it as missing would send
// people off to "fix" a figure that is already correct. Only null means the
// question went unanswered. `costOfGoodsSold()` in sales-reporting.ts draws
// the same line when it reports items as uncosted rather than as costing zero.
export function isUncosted(product: Pick<Product, 'costCents'>): boolean {
  return product.costCents === null;
}

// Whether saving should stop and ask.
//
// Fires when a cost is BEING left out for the first time: a new product saved
// blank, or an edit that clears a cost which was previously set. It stays
// quiet when an already-uncosted product is saved still-uncosted, because the
// person is there for some other field and has made no decision about cost —
// warning them anyway is how a dialog becomes something people dismiss without
// reading.
//
// `initialCostCents` is undefined for a new product and null for an existing
// one with no cost; the two cases differ and the distinction is load-bearing.
export function needsCostConfirmation(
  costInput: string,
  initialCostCents: number | null | undefined
): boolean {
  if (costInput.trim() !== '') return false;
  return initialCostCents !== null;
}
