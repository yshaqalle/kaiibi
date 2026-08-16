import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import type { SelectedCustomer } from '@/components/customer-picker';
import type { CartLine, Discount } from '@/types/models';

// One key per user AND per till. A hold belongs to the counter it was parked
// at: two registers in the same shop serve two queues, and resuming someone
// else's basket at the wrong counter hands over the wrong goods. `shop` is the
// fallback for a shop that has never set a location up.
function keyFor(userId: string, locationId: string | null): string {
  return `kaiibi.pos.held.${userId}.${locationId ?? 'shop'}`;
}

export type HeldOrder = {
  id: string;
  heldAt: string;
  cart: CartLine[];
  customer: SelectedCustomer | null;
  transactionDiscount: Discount | null;
  pointsRedeemed: number;
  // Denormalised so the queue can list a sale without repricing it: the list is
  // read far more often than it is resumed, and repricing every parked basket
  // against live promotions to draw a menu would be a lot of work for a label.
  totalCents: number;
  itemCount: number;
};

// A parked sale has to survive a force-quit. The single in-progress sale in
// use-pos-session.ts lives in module state and dies with the app, which is
// tolerable for a basket someone is standing over and not tolerable for one
// they were told would be waiting.
//
// Web reads localStorage directly for the same reason support-draft.ts does --
// it is synchronous, so the queue is drawn already filled rather than filling
// a tick later.
function readSync(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): HeldOrder[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Anything that is not a recognisable hold is dropped rather than thrown
    // over: a corrupt payload must not take the till down mid-shift.
    return parsed.filter((entry): entry is HeldOrder => {
      if (!entry || typeof entry !== 'object') return false;
      const held = entry as Partial<HeldOrder>;
      return typeof held.id === 'string' && Array.isArray(held.cart) && held.cart.length > 0;
    });
  } catch {
    return [];
  }
}

async function write(key: string, orders: HeldOrder[]): Promise<void> {
  const raw = JSON.stringify(orders);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(key, raw);
      return;
    } catch {
      return;
    }
  }
  try {
    await AsyncStorage.setItem(key, raw);
  } catch {
    // A hold that failed to persist is still in the cashier's hands on screen;
    // failing loudly here would interrupt a queue for something they cannot fix.
  }
}

export async function readHeldOrders(userId: string, locationId: string | null): Promise<HeldOrder[]> {
  const key = keyFor(userId, locationId);
  let raw = readSync(key);
  if (raw === null && Platform.OS !== 'web') {
    try {
      raw = await AsyncStorage.getItem(key);
    } catch {
      return [];
    }
  }
  return parse(raw);
}

export async function holdOrder(
  userId: string,
  locationId: string | null,
  order: Omit<HeldOrder, 'id' | 'heldAt'>
): Promise<HeldOrder[]> {
  const key = keyFor(userId, locationId);
  const held: HeldOrder = {
    ...order,
    id: `h${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
    heldAt: new Date().toISOString(),
  };
  const next = [...(await readHeldOrders(userId, locationId)), held];
  await write(key, next);
  return next;
}

// Removes as it returns: a hold that could be resumed twice is a basket that
// could be sold twice.
export async function resumeHeldOrder(
  userId: string,
  locationId: string | null,
  id: string
): Promise<{ order: HeldOrder | null; remaining: HeldOrder[] }> {
  const key = keyFor(userId, locationId);
  const orders = await readHeldOrders(userId, locationId);
  const order = orders.find((held) => held.id === id) ?? null;
  const remaining = orders.filter((held) => held.id !== id);
  if (order) await write(key, remaining);
  return { order, remaining };
}
