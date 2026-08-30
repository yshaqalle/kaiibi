import type { OrderAmendmentLine, OrderPricing } from '@/lib/storefront-admin';

// What an amend would do, worked out before it is sent.
//
// This is where the amend sheet's arithmetic lives, and it lives here rather
// than in the sheet for the reason every sum in this feature does: a screen
// that adds up money cannot be tested without rendering it, and the one number
// a shop reads before agreeing to change what a customer owes is the last
// number that should only be provable through a component tree.
//
// It computes what the server WILL do, not what it did. amend_order is still
// the only writer and the only authority -- this exists so the shop can see
// the consequence first. The two must agree, and the pricing rule below is
// deliberately the same sentence as the migration's: 'agreed' keeps
// order_items.unit_price_cents, 'current' reads today's products.price_cents.

/** One line of the order as the sheet currently has it. */
export type AmendLineDraft = {
  /**
   * Null when the product has been deleted (`on delete set null`,
   * 20260926000050). Such a line cannot be kept at all -- amend_order refuses
   * it by name with `order_product_deleted` -- so it is always reported as
   * removed, whatever quantity the sheet is holding for it.
   */
  productId: string | null;
  productName: string;
  /** What the customer agreed to at checkout. */
  agreedUnitPriceCents: number;
  /** Today's shelf price, or null when there is no product left to read one from. */
  currentUnitPriceCents: number | null;
  originalQuantity: number;
  quantity: number;
};

export type AmendChange =
  | { kind: 'quantity'; productName: string; from: number; to: number }
  | { kind: 'removed'; productName: string; reason: 'dropped' | 'product_deleted' }
  | { kind: 'repriced'; productName: string; fromCents: number; toCents: number };

/**
 * Why an amend cannot be saved as it stands.
 *
 * `no_items` mirrors the server's own refusal. `price_unknown` has no server
 * equivalent and does not need one: it is the sheet refusing to send a
 * re-price it cannot show the shop the figures for, rather than falling back
 * to the agreed price and charging one price on a line the shop believes it
 * re-priced.
 */
export type AmendBlocker = 'no_items' | 'price_unknown';

export type AmendSummary = {
  previousTotalCents: number;
  nextSubtotalCents: number;
  deliveryFeeCents: number;
  nextTotalCents: number;
  /** Negative when the customer owes less than before. */
  differenceCents: number;
  changes: AmendChange[];
  hasChanges: boolean;
  blocker: AmendBlocker | null;
};

/** A line that has lost its product cannot survive an amend under any quantity. */
function isGone(line: AmendLineDraft): boolean {
  return line.productId === null;
}

function unitPriceFor(line: AmendLineDraft, pricing: OrderPricing): number | null {
  if (pricing === 'agreed') return line.agreedUnitPriceCents;
  return line.currentUnitPriceCents;
}

export function summariseAmendment(input: {
  lines: AmendLineDraft[];
  pricing: OrderPricing;
  deliveryFeeCents: number;
  previousTotalCents: number;
}): AmendSummary {
  const { lines, pricing, deliveryFeeCents, previousTotalCents } = input;

  const changes: AmendChange[] = [];
  let nextSubtotalCents = 0;
  let survivors = 0;
  let priceUnknown = false;

  for (const line of lines) {
    if (isGone(line)) {
      // Reported whatever the sheet's quantity says, because the shop did not
      // ask for this one to go and must be told that it is going.
      changes.push({ kind: 'removed', productName: line.productName, reason: 'product_deleted' });
      continue;
    }

    if (line.quantity <= 0) {
      // Only a change if it was ever on the order to begin with.
      if (line.originalQuantity > 0) {
        changes.push({ kind: 'removed', productName: line.productName, reason: 'dropped' });
      }
      continue;
    }

    survivors += 1;
    const unit = unitPriceFor(line, pricing);
    if (unit === null) {
      priceUnknown = true;
      continue;
    }

    nextSubtotalCents += unit * line.quantity;

    if (line.quantity !== line.originalQuantity) {
      changes.push({
        kind: 'quantity',
        productName: line.productName,
        from: line.originalQuantity,
        to: line.quantity,
      });
    }
    // Only an actual movement counts. A line whose shelf price still equals
    // the agreed one is not a re-price, and listing it would fill the panel
    // with every line on the order and say nothing.
    if (unit !== line.agreedUnitPriceCents) {
      changes.push({
        kind: 'repriced',
        productName: line.productName,
        fromCents: line.agreedUnitPriceCents,
        toCents: unit,
      });
    }
  }

  const nextTotalCents = nextSubtotalCents + deliveryFeeCents;

  return {
    previousTotalCents,
    nextSubtotalCents,
    deliveryFeeCents,
    nextTotalCents,
    differenceCents: nextTotalCents - previousTotalCents,
    changes,
    hasChanges: changes.length > 0,
    blocker: survivors === 0 ? 'no_items' : priceUnknown ? 'price_unknown' : null,
  };
}

/**
 * The `p_lines` payload for `amend_order`.
 *
 * A zero IS sent -- it is how the sheet says "drop this line", and the server
 * reads it as exactly that. A deleted-product line is OMITTED rather than sent
 * with a null id: naming one raises `order_product_deleted`, and omitting it
 * is the only way to remove it.
 */
export function amendmentLines(lines: AmendLineDraft[]): OrderAmendmentLine[] {
  return lines
    .filter((line): line is AmendLineDraft & { productId: string } => line.productId !== null)
    .map((line) => ({ productId: line.productId, quantity: Math.max(0, Math.trunc(line.quantity)) }));
}

/**
 * Has the shop changed this order without the customer having agreed yet?
 *
 * A FLAG, NOT A SIXTH STATUS. A new word in the status vocabulary would mean
 * touching the CHECK, the permitted-moves table in the transition trigger,
 * ORDERS_NEEDING_ACTION, the tabs and ORDER_STATUS_BADGE -- for something
 * ORTHOGONAL to where the order actually is. An order can be awaiting the
 * customer's agreement at pending, accepted OR ready.
 *
 * A COMPARISON, not a null check, and the difference is a real case: a shop
 * amends, the customer agrees, and then the shop amends AGAIN. The first
 * agreement does not cover the second change, so the flag has to come back.
 * Equal timestamps count as covering -- a customer cannot have agreed before
 * the change happened, so the pair belongs together.
 *
 * IT WARNS, IT DOES NOT BLOCK. Nothing gated on this may disable an action:
 * a shop that phoned and got a verbal yes must not be locked out because the
 * customer never tapped anything, and blocking only teaches people to route
 * around the feature.
 */
export function isAwaitingCustomer(input: {
  lastAmendedAt: string | null;
  confirmedAt: string | null;
}): boolean {
  if (!input.lastAmendedAt) return false;
  if (!input.confirmedAt) return true;
  return new Date(input.confirmedAt).getTime() < new Date(input.lastAmendedAt).getTime();
}
