import type { CartLine, Discount, Product, Promotion } from '@/types/models';

// Cents a `Discount` knocks off a given base amount, capped so a line/total
// never goes negative — a 100%-off or an oversized fixed discount just
// zeroes it out rather than producing a negative charge.
export function discountAmountCents(baseCents: number, discount: Discount | null | undefined): number {
  if (!discount || baseCents <= 0) return 0;
  const raw = discount.type === 'percentage' ? Math.round((baseCents * discount.value) / 100) : discount.value;
  return Math.max(0, Math.min(raw, baseCents));
}

// Among all active promotions matching a product's brand/category (or a
// store-wide one), picks whichever yields the single largest discount for
// this line — no stacking, and no scope-precedence rules to reason about,
// just "best deal wins". Returns null if nothing matches.
export function bestPromotionForProduct(product: Product, promotions: Promotion[], lineGrossCents: number): Promotion | null {
  const matching = promotions.filter((p) => {
    if (!p.active) return false;
    if (p.scope === 'store') return true;
    if (p.scope === 'brand') return Boolean(product.brand) && product.brand === p.scopeValue;
    if (p.scope === 'category') return Boolean(product.category) && product.category === p.scopeValue;
    return false;
  });
  if (matching.length === 0) return null;

  let best: Promotion | null = null;
  let bestCents = -1;
  for (const promo of matching) {
    const cents = discountAmountCents(lineGrossCents, { type: promo.discountType, value: promo.discountValue });
    if (cents > bestCents) {
      best = promo;
      bestCents = cents;
    }
  }
  return best;
}

export function lineGrossCents(line: CartLine): number {
  return line.product.priceCents * line.quantity;
}

// A manual discount entered directly on the cart line always wins over an
// auto-applied promotion for that same line — cashier discretion overrides
// a standing store-wide/brand/category sale.
export function lineDiscountCents(line: CartLine, promotions: Promotion[]): number {
  const gross = lineGrossCents(line);
  if (line.manualDiscount) return discountAmountCents(gross, line.manualDiscount);
  const promo = bestPromotionForProduct(line.product, promotions, gross);
  return promo ? discountAmountCents(gross, { type: promo.discountType, value: promo.discountValue }) : 0;
}

export function appliedPromotionForLine(line: CartLine, promotions: Promotion[]): Promotion | null {
  if (line.manualDiscount) return null;
  return bestPromotionForProduct(line.product, promotions, lineGrossCents(line));
}

export function lineNetCents(line: CartLine, promotions: Promotion[]): number {
  return lineGrossCents(line) - lineDiscountCents(line, promotions);
}

// Sum of each line's net (post-line-discount) total — this is the subtotal
// a transaction-level discount then applies on top of.
export function cartSubtotalCents(lines: CartLine[], promotions: Promotion[]): number {
  return lines.reduce((sum, line) => sum + lineNetCents(line, promotions), 0);
}

export function cartLineDiscountTotalCents(lines: CartLine[], promotions: Promotion[]): number {
  return lines.reduce((sum, line) => sum + lineDiscountCents(line, promotions), 0);
}
