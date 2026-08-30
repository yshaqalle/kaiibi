import { ORDERS_NEEDING_ACTION } from '@/lib/order-status';
import type { ShopOrder } from '@/lib/storefront-admin';

// Every number the Orders screen shows, in one place.
//
// The screen does no arithmetic of its own, on purpose: a component that sums
// its own rows is a second implementation of the same report, and the two
// drift the first time either changes. It is also the only way these sums get
// tested at all -- a pure module needs no renderer, no Supabase mock and no
// fake clock.
//
// `now` is a PARAMETER everywhere it is needed, never `new Date()` inside a
// function. A function that reads the clock cannot be tested without freezing
// time, and the screen wants one consistent `now` for a whole render anyway --
// otherwise two rows in the same table are measured against two clocks.

/**
 * How long an unfinished order may sit before the screen calls it out.
 *
 * Three hours, and it is a judgement rather than a measurement -- nobody has
 * asked a shop yet. ONE threshold, not one per fulfilment type: a collect
 * order that nobody has accepted is exactly as ignored as a delivery that
 * nobody has accepted, and the difference between them starts only once
 * someone has picked it up. Revisit with a real shop.
 */
export const STALE_AFTER_MINUTES = 180 as const;

export type OrderSortField = 'number' | 'customer' | 'total' | 'waiting';

export type OrderStats = {
  /** Orders nobody has looked at yet. The one number worth acting on within the hour. */
  needsAttention: number;
  /** How long the oldest of those has waited, or null when none are pending. */
  oldestWaitingMinutes: number | null;
  openCount: number;
  openCents: number;
  readyCount: number;
  readyCents: number;
  convertedCents: number;
};

const isOpen = (order: ShopOrder): boolean => ORDERS_NEEDING_ACTION.includes(order.status);

export function waitedMinutes(order: ShopOrder, now: Date): number {
  const ms = now.getTime() - new Date(order.createdAt).getTime();
  // Clamped at zero: a row stamped slightly in the future (clock skew between
  // the shop's phone and the database) must read "just now", never a negative
  // age that sorts to the top as the most urgent thing on the screen.
  return Math.max(0, Math.floor(ms / 60000));
}

export function isStale(order: ShopOrder, now: Date): boolean {
  // A finished order is not waiting for anything. Without this every completed
  // order a shop has ever taken reads as overdue, forever, and the signal dies.
  if (!isOpen(order)) return false;
  return waitedMinutes(order, now) >= STALE_AFTER_MINUTES;
}

export function orderStats(orders: ShopOrder[], now: Date): OrderStats {
  const pending = orders.filter((o) => o.status === 'pending');
  const open = orders.filter(isOpen);
  const ready = orders.filter((o) => o.status === 'ready');

  return {
    needsAttention: pending.length,
    oldestWaitingMinutes: pending.length
      ? Math.max(...pending.map((o) => waitedMinutes(o, now)))
      : null,
    openCount: open.length,
    // Property 5: this is what customers have ASKED for, not money taken. A
    // completed order's total already reached the books through
    // complete_storefront_order, and a cancelled one never will -- including
    // either would make the caveat printed under this figure untrue.
    openCents: open.reduce((sum, o) => sum + o.totalCents, 0),
    readyCount: ready.length,
    readyCents: ready.reduce((sum, o) => sum + o.totalCents, 0),
    convertedCents: orders
      .filter((o) => o.status === 'completed')
      .reduce((sum, o) => sum + o.totalCents, 0),
  };
}

export function searchOrders(orders: ShopOrder[], query: string): ShopOrder[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return orders;
  return orders.filter((o) =>
    String(o.number).includes(q) ||
    o.customerName.toLowerCase().includes(q) ||
    o.customerPhone.toLowerCase().includes(q) ||
    (o.deliveryArea ?? '').toLowerCase().includes(q) ||
    // The landmark is how a shop actually remembers a delivery -- "the one
    // behind the fuel station", not its number.
    (o.deliveryLandmark ?? '').toLowerCase().includes(q)
  );
}

export function sortOrders(orders: ShopOrder[], field: OrderSortField, dir: 'asc' | 'desc'): ShopOrder[] {
  const sign = dir === 'asc' ? 1 : -1;
  // Copied before sorting: Array.prototype.sort mutates, and the caller's array
  // is state that React compares by identity.
  return [...orders].sort((a, b) => {
    switch (field) {
      case 'number': return (a.number - b.number) * sign;
      case 'customer': return a.customerName.localeCompare(b.customerName) * sign;
      case 'total': return (a.totalCents - b.totalCents) * sign;
      // Waiting is AGE, so longest-waiting is oldest -- the reverse of sorting
      // by createdAt. 'desc' on this column must surface the order that has
      // been ignored longest, which is the whole reason the column exists.
      case 'waiting': return (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) * sign;
    }
  });
}
