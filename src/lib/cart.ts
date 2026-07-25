import { lineDiscountCents } from '@/lib/discounts';
import type { CartLine, Promotion } from '@/types/models';

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
}

// `promotions` defaults to none so existing callers (and the test suite)
// that don't care about discounts keep getting a plain product_id/quantity
// payload with discount_cents simply 0 on every line.
export function buildSalePayload(lines: CartLine[], promotions: Promotion[] = []): { product_id: string; quantity: number; discount_cents: number }[] {
  return lines.map((line) => ({
    product_id: line.product.id,
    quantity: line.quantity,
    discount_cents: lineDiscountCents(line, promotions),
  }));
}
