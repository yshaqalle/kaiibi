import {
  isStale, orderStats, searchOrders, sortOrders, waitedMinutes, STALE_AFTER_MINUTES,
} from '@/lib/orders-reporting';
import type { ShopOrder } from '@/lib/storefront-admin';

const NOW = new Date('2026-08-29T12:00:00Z');

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    id: 'o1', number: 1, customerName: 'Amina Warsame', customerPhone: '0634412290',
    fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null, note: null,
    status: 'pending', cancellationReason: null, itemCount: 3,
    subtotalCents: 4450, deliveryFeeCents: 0, totalCents: 4450,
    saleId: null, createdAt: '2026-08-29T10:00:00Z', ...over,
  };
}

describe('waitedMinutes', () => {
  it('measures from createdAt to the now it is given', () => {
    expect(waitedMinutes(order({ createdAt: '2026-08-29T10:00:00Z' }), NOW)).toBe(120);
  });

  it('never returns a negative age for an order stamped in the future', () => {
    expect(waitedMinutes(order({ createdAt: '2026-08-29T13:00:00Z' }), NOW)).toBe(0);
  });
});

describe('isStale', () => {
  it('is false below the threshold', () => {
    expect(isStale(order({ createdAt: '2026-08-29T09:30:00Z' }), NOW)).toBe(false); // 150m
  });

  it('is true at and above the threshold', () => {
    expect(isStale(order({ createdAt: '2026-08-29T09:00:00Z' }), NOW)).toBe(true); // 180m
  });

  // A finished order is not "waiting" no matter how old it is -- otherwise every
  // completed order the shop has ever taken reads as overdue forever.
  it('is false for a completed or cancelled order however old', () => {
    expect(isStale(order({ status: 'completed', createdAt: '2026-01-01T00:00:00Z' }), NOW)).toBe(false);
    expect(isStale(order({ status: 'cancelled', createdAt: '2026-01-01T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('orderStats', () => {
  const orders = [
    order({ id: 'a', status: 'pending',   totalCents: 4750, createdAt: '2026-08-29T10:00:00Z' }), // 120m
    order({ id: 'b', status: 'pending',   totalCents: 1200, createdAt: '2026-08-29T08:00:00Z' }), // 240m
    order({ id: 'c', status: 'accepted',  totalCents: 12800 }),
    order({ id: 'd', status: 'ready',     totalCents: 19000 }),
    order({ id: 'e', status: 'completed', totalCents: 8600 }),
    order({ id: 'f', status: 'cancelled', totalCents: 2800 }),
    // g is accepted and 360m old -- older than b (240m) but not pending, so it
    // must NOT be the answer to "oldest pending". Without this, the test cannot
    // tell "oldest pending" from "oldest open" or "oldest anything".
    order({ id: 'g', status: 'accepted', totalCents: 5000, createdAt: '2026-08-29T06:00:00Z' }), // 360m
  ];

  it('counts only pending orders as needing attention', () => {
    expect(orderStats(orders, NOW).needsAttention).toBe(2);
  });

  it('reports the oldest pending wait, not the oldest order', () => {
    expect(orderStats(orders, NOW).oldestWaitingMinutes).toBe(240);
  });

  // Property 5: open value is what customers have ASKED for. A completed order's
  // money has already reached the books and a cancelled one never will, so
  // including either would make the caveat under this tile untrue.
  it('sums open orders only -- pending, accepted and ready', () => {
    const s = orderStats(orders, NOW);
    expect(s.openCount).toBe(5);
    expect(s.openCents).toBe(4750 + 1200 + 12800 + 19000 + 5000);
  });

  it('reports ready separately, since that is money sitting on a shelf', () => {
    const s = orderStats(orders, NOW);
    expect(s.readyCount).toBe(1);
    expect(s.readyCents).toBe(19000);
  });

  it('counts completed orders as converted, and never counts cancelled ones anywhere', () => {
    const s = orderStats(orders, NOW);
    expect(s.convertedCents).toBe(8600);
    // The cancelled order's 2800 must land in neither figure -- not folded into
    // open (it was never accepted) and not folded into converted (it never
    // shipped). A plain toContain on a number asserts nothing; these two
    // inequalities are what would actually catch a leak.
    expect(s.openCents).not.toBe(4750 + 1200 + 12800 + 19000 + 5000 + 2800);
    expect(s.convertedCents).not.toBe(8600 + 2800);
    expect(s.openCents + s.convertedCents).toBe(4750 + 1200 + 12800 + 19000 + 5000 + 8600);
  });

  it('has no oldest wait when nothing is pending', () => {
    expect(orderStats([order({ status: 'completed' })], NOW).oldestWaitingMinutes).toBeNull();
  });
});

describe('searchOrders', () => {
  const orders = [
    order({ id: 'a', number: 1042, customerName: 'Amina Warsame', customerPhone: '0634412290' }),
    order({ id: 'b', number: 1041, customerName: 'Khadra Ismail', customerPhone: '0637781140',
            fulfilment: 'deliver', deliveryArea: 'Koodbuur', deliveryLandmark: 'behind the fuel station' }),
  ];

  it('returns everything for a blank or whitespace query', () => {
    expect(searchOrders(orders, '')).toHaveLength(2);
    expect(searchOrders(orders, '   ')).toHaveLength(2);
  });

  it('matches an order number with or without the hash', () => {
    expect(searchOrders(orders, '1042').map((o) => o.id)).toEqual(['a']);
    expect(searchOrders(orders, '#1042').map((o) => o.id)).toEqual(['a']);
  });

  it('matches a customer name case-insensitively', () => {
    expect(searchOrders(orders, 'khadra').map((o) => o.id)).toEqual(['b']);
  });

  it('matches a phone number', () => {
    expect(searchOrders(orders, '4412290').map((o) => o.id)).toEqual(['a']);
  });

  // The landmark is what a driver actually searches by -- "the one behind the
  // fuel station" is how a shop remembers an order, not its number.
  it('matches a delivery landmark and area', () => {
    expect(searchOrders(orders, 'fuel station').map((o) => o.id)).toEqual(['b']);
    expect(searchOrders(orders, 'koodbuur').map((o) => o.id)).toEqual(['b']);
  });

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(searchOrders(orders, 'zzz')).toHaveLength(0);
  });
});

describe('sortOrders', () => {
  const orders = [
    order({ id: 'a', number: 2, customerName: 'Bashir', totalCents: 300, createdAt: '2026-08-29T11:00:00Z' }),
    order({ id: 'b', number: 1, customerName: 'Amina',  totalCents: 900, createdAt: '2026-08-29T09:00:00Z' }),
  ];

  it('does not mutate the array it is given', () => {
    const before = orders.map((o) => o.id);
    // Sort by a field whose correct order differs from the fixture's existing order,
    // so an in-place sort would visibly reorder the caller's array.
    sortOrders(orders, 'number', 'asc');
    expect(orders.map((o) => o.id)).toEqual(before);
  });

  it('sorts by number, total and customer in both directions', () => {
    expect(sortOrders(orders, 'number', 'asc').map((o) => o.number)).toEqual([1, 2]);
    expect(sortOrders(orders, 'total', 'desc').map((o) => o.totalCents)).toEqual([900, 300]);
    expect(sortOrders(orders, 'customer', 'asc').map((o) => o.customerName)).toEqual(['Amina', 'Bashir']);
  });

  // Waiting is age, so the OLDEST order is the one that has waited LONGEST --
  // sorting waiting 'desc' must put the oldest first, which is the opposite of
  // sorting createdAt 'desc'. Getting this backwards hides the urgent order.
  it('sorts waiting descending oldest-first', () => {
    expect(sortOrders(orders, 'waiting', 'desc').map((o) => o.id)).toEqual(['b', 'a']);
  });
});
