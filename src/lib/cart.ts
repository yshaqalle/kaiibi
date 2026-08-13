import { appliedPromotionForLine, lineDiscountCents } from '@/lib/discounts';
import type { CartLine, Promotion } from '@/types/models';

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
}

// `promotions` defaults to none so existing callers (and the test suite)
// that don't care about discounts keep getting a plain product_id/quantity
// payload with discount_cents simply 0 on every line.
//
// `promotion_name` rides along for readability of this payload only — the
// server (complete_sale/edit_sale) re-reads the name from the promotions row
// itself and ignores whatever is sent here, the same way it re-verifies
// promotion_id rather than trusting it. That re-read is what keeps a sale
// reading correctly after the promotion is renamed, archived or deleted — the
// same reason sale_items already stores product_name beside product_id.
export function buildSalePayload(
  lines: CartLine[],
  promotions: Promotion[] = [],
  now: number = Date.now()
): {
  product_id: string;
  quantity: number;
  discount_cents: number;
  promotion_id: string | null;
  promotion_name: string | null;
}[] {
  return lines.map((line) => {
    const promo = appliedPromotionForLine(line, promotions, now);
    return {
      product_id: line.product.id,
      quantity: line.quantity,
      discount_cents: lineDiscountCents(line, promotions, now),
      promotion_id: promo?.id ?? null,
      promotion_name: promo?.name ?? null,
    };
  });
}
