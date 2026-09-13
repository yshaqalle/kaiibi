// What was taken off a sale, item by item and as a whole, for Transactions.
//
// Everything is read off the sale as it was frozen at the till -- list price,
// line discount, the promotion's name, the whole-sale discount -- so a later
// price change or a paused promotion never rewrites what a past sale says.
//
// Percentages are of the LIST price, which is what a customer means by "10%
// off". The one exception is the whole-sale discount's own %, which is of what
// the items came to after their own discounts: that is the amount the cashier
// took it off, so it is the % they typed.
//
// Redeemed loyalty points are money off the total but not a price cut -- the
// customer paid for them with earlier purchases -- so they get their own line
// in the summary and stay out of "total off".

type DiscountLine = {
  unitPriceCents: number;
  quantity: number;
  discountCents: number;
  lineTotalCents: number;
  promotionName: string | null;
};

// Whole when the share rounds to a whole number at one decimal, one decimal
// otherwise: 100 off 999 is "10%", not "10.0%"; 42 off 1000 is "4.2%".
export function discountPercentLabel(offCents: number, baseCents: number): string | null {
  if (offCents <= 0 || baseCents <= 0) return null;
  const tenths = Math.round((offCents * 1000) / baseCents) / 10;
  return Number.isInteger(tenths) ? `${tenths}%` : `${tenths.toFixed(1)}%`;
}

export function lineDiscount(item: DiscountLine, cashierName: string | null): {
  listCents: number;
  offCents: number;
  paidCents: number;
  percent: string | null;
  reason: string | null;
} {
  const listCents = item.unitPriceCents * item.quantity;
  const offCents = Math.max(0, item.discountCents);
  return {
    listCents,
    offCents,
    paidCents: item.lineTotalCents,
    percent: discountPercentLabel(offCents, listCents),
    // No promotion behind a discount means someone typed the number in.
    reason: offCents === 0 ? null : item.promotionName ?? (cashierName ? `Manual discount by ${cashierName}` : 'Manual discount'),
  };
}

export type SaleDiscountSummary = {
  listCents: number;
  itemDiscountCents: number;
  discountedItemCount: number;
  itemDiscountPercent: string | null;
  saleDiscountCents: number;
  saleDiscountPercent: string | null;
  pointsRedeemedCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  totalOffCents: number;
  totalOffPercent: string | null;
  promotionNames: string[];
  // The one promotion that accounts for EVERYTHING taken off, or null -- a
  // typed-in discount or a whole-sale discount beside it means it did not.
  onlyPromotion: string | null;
};

export function saleDiscountSummary(sale: {
  items: DiscountLine[];
  discountCents: number;
  pointsRedeemedCents: number;
  taxCents: number;
  totalCents: number;
}): SaleDiscountSummary {
  const listCents = sale.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const discounted = sale.items.filter((item) => item.discountCents > 0);
  const itemDiscountCents = discounted.reduce((sum, item) => sum + item.discountCents, 0);
  const saleDiscountCents = Math.max(0, sale.discountCents);
  const pointsRedeemedCents = Math.max(0, sale.pointsRedeemedCents);
  const totalOffCents = itemDiscountCents + saleDiscountCents;
  const promotionNames = [...new Set(discounted.map((item) => item.promotionName).filter((name): name is string => Boolean(name)))];
  const allPromoted = discounted.length > 0 && discounted.every((item) => item.promotionName) && saleDiscountCents === 0;
  return {
    listCents,
    itemDiscountCents,
    discountedItemCount: discounted.length,
    itemDiscountPercent: discountPercentLabel(itemDiscountCents, listCents),
    saleDiscountCents,
    saleDiscountPercent: discountPercentLabel(saleDiscountCents, listCents - itemDiscountCents),
    pointsRedeemedCents,
    subtotalCents: listCents - totalOffCents - pointsRedeemedCents,
    taxCents: sale.taxCents,
    totalCents: sale.totalCents,
    totalOffCents,
    totalOffPercent: discountPercentLabel(totalOffCents, listCents),
    promotionNames,
    onlyPromotion: allPromoted && promotionNames.length === 1 ? promotionNames[0] : null,
  };
}
