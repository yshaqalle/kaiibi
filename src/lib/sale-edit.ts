import { taxCentsFor } from '@/lib/tax';

// The sale editor's arithmetic, kept in step with edit_sale
// (20260908000650_post_sale_edit.sql). The server is the one that decides the
// total; the editor only has to agree with it, because Save enables on
// payments matching the total it shows. Before this lived here the editor
// summed price x quantity plus tax and nothing else, so any sale with a line
// discount, a whole-sale discount or redeemed points opened with a total its
// own payments could never match -- a Save button that never enabled.

// A line's discount through an edit. Kept as-is while the quantity holds or
// rises; shrunk in proportion when it falls, because edit_sale refuses a
// promotion discount larger than the offer gives on the NEW quantity. Floored
// so the shrunk figure never rounds past that cap, and never more than the
// line itself.
export function editedLineDiscountCents({
  discountCents,
  originalQuantity,
  quantity,
  unitPriceCents,
}: {
  discountCents: number;
  originalQuantity: number;
  quantity: number;
  unitPriceCents: number;
}): number {
  const scaled = originalQuantity > 0 && quantity < originalQuantity
    ? Math.floor((discountCents * quantity) / originalQuantity)
    : discountCents;
  return Math.max(0, Math.min(scaled, unitPriceCents * quantity));
}

export function editedSaleTotals({
  lines,
  saleDiscountCents,
  pointsRedeemedCents,
  taxRatePercent,
}: {
  lines: { unitPriceCents: number; quantity: number; discountCents: number }[];
  saleDiscountCents: number;
  pointsRedeemedCents: number;
  // null when the shop charges no tax.
  taxRatePercent: number | null;
}): { netCents: number; saleDiscountCents: number; taxCents: number; totalCents: number } {
  const linesCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity - line.discountCents, 0);
  // The redemption carries through untouched, as on the server. The sale
  // discount is what gives way when the basket shrinks under it -- edit_sale
  // refuses a discount bigger than the sale.
  const afterPoints = Math.max(0, linesCents - pointsRedeemedCents);
  const discount = Math.min(Math.max(saleDiscountCents, 0), afterPoints);
  const netCents = afterPoints - discount;
  const taxCents = taxRatePercent === null ? 0 : taxCentsFor(netCents, taxRatePercent);
  return { netCents, saleDiscountCents: discount, taxCents, totalCents: netCents + taxCents };
}
