import type { CartLine, Discount, Product, Promotion } from '@/types/models';

// Cents a `Discount` knocks off a given base amount, capped so a line/total
// never goes negative — a 100%-off or an oversized fixed discount just
// zeroes it out rather than producing a negative charge.
export function discountAmountCents(baseCents: number, discount: Discount | null | undefined): number {
  if (!discount || baseCents <= 0) return 0;
  const raw = discount.type === 'percentage' ? Math.round((baseCents * discount.value) / 100) : discount.value;
  return Math.max(0, Math.min(raw, baseCents));
}

// The one place "is this offer running right now" is decided. Everything that
// applies a discount goes through here, so the product tile badge, the cart
// line and the total can never disagree about whether an offer is live.
//
// Three separate ideas, deliberately not collapsed: `active` is the owner's
// hard off switch, the window is scheduling, and `archivedAt` is "kept only so
// old sales still read". A promotion has to clear all three.
export function isPromotionLive(promo: Promotion, now: number = Date.now()): boolean {
  if (!promo.active || promo.archivedAt) return false;
  if (promo.startsAt && Date.parse(promo.startsAt) > now) return false;
  // The end instant is the moment it stops, not the last moment it runs — an
  // offer "until 21:00" must not still apply at 21:00.
  if (promo.endsAt && Date.parse(promo.endsAt) <= now) return false;
  return true;
}

// The reason a promotion isPromotionLive just said no to, worded for a
// screen that has to SAY why rather than just disable a button. Null means
// the same thing isPromotionLive(promo, now) === true does -- there is
// nothing wrong with it.
//
// Exists for campaigns: a campaign advertises an offer by name over
// WhatsApp, long after the moment it was picked, so "is it still live"
// has to be re-asked right before every send -- see
// campaign-composer.tsx's checkPromotionStillLive for the first place this
// mattered, and send-queue.tsx / campaigns-tab.tsx for the second (a queue
// that outlives the offer it was built on).
export function promotionLiveIssue(promo: Promotion, now: number = Date.now()): string | null {
  if (promo.archivedAt) return `"${promo.name}" has been archived and no longer runs at the till.`;
  if (!promo.active) return `"${promo.name}" has been paused and no longer runs at the till.`;
  if (promo.endsAt && Date.parse(promo.endsAt) <= now) return `"${promo.name}" has ended.`;
  if (promo.startsAt && Date.parse(promo.startsAt) > now) return `"${promo.name}" hasn't started yet.`;
  return null;
}

// Among all promotions matching a product's brand/category (or a store-wide
// one), picks whichever yields the single largest discount for this line — no
// stacking, and no scope-precedence rules to reason about, just "best deal
// wins". Returns null if nothing matches.
//
// `autoApply === false` is excluded here on purpose: those offers exist only
// to be chosen by a cashier, and firing by themselves is exactly what they are
// defined not to do.
export function bestPromotionForProduct(
  product: Product,
  promotions: Promotion[],
  lineGrossCents: number,
  now: number = Date.now()
): Promotion | null {
  const matching = promotions.filter((p) => {
    if (!isPromotionLive(p, now)) return false;
    if (!p.autoApply) return false;
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
export function lineDiscountCents(line: CartLine, promotions: Promotion[], now: number = Date.now()): number {
  const gross = lineGrossCents(line);
  if (line.manualDiscount) return discountAmountCents(gross, line.manualDiscount);
  const promo = bestPromotionForProduct(line.product, promotions, gross, now);
  return promo ? discountAmountCents(gross, { type: promo.discountType, value: promo.discountValue }) : 0;
}

export function appliedPromotionForLine(line: CartLine, promotions: Promotion[], now: number = Date.now()): Promotion | null {
  if (line.manualDiscount) return null;
  return bestPromotionForProduct(line.product, promotions, lineGrossCents(line), now);
}

export function lineNetCents(line: CartLine, promotions: Promotion[], now: number = Date.now()): number {
  return lineGrossCents(line) - lineDiscountCents(line, promotions, now);
}

// Sum of each line's net (post-line-discount) total — this is the subtotal
// a transaction-level discount then applies on top of.
export function cartSubtotalCents(lines: CartLine[], promotions: Promotion[], now: number = Date.now()): number {
  return lines.reduce((sum, line) => sum + lineNetCents(line, promotions, now), 0);
}

export function cartLineDiscountTotalCents(lines: CartLine[], promotions: Promotion[], now: number = Date.now()): number {
  return lines.reduce((sum, line) => sum + lineDiscountCents(line, promotions, now), 0);
}
