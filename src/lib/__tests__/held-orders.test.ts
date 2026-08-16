import AsyncStorage from '@react-native-async-storage/async-storage';

import { holdOrder, readHeldOrders, resumeHeldOrder, type HeldOrder } from '@/lib/held-orders';
import type { CartLine, Product } from '@/types/models';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const TILL = '33333333-3333-4333-8333-333333333333';
const OTHER_TILL = '44444444-4444-4444-8444-444444444444';

// Must match the key inside held-orders.ts. Duplicated rather than exported,
// because the point of two of these tests is that one till cannot read
// another's parked baskets.
const keyFor = (userId: string, locationId: string | null) => `kaiibi.pos.held.${userId}.${locationId ?? 'shop'}`;

const product = { id: 'p1', name: 'Balanceful Cica Serum', priceCents: 2200 } as unknown as Product;
const cart: CartLine[] = [{ product, quantity: 2 }];

const sale: Omit<HeldOrder, 'id' | 'heldAt'> = {
  cart,
  customer: null,
  transactionDiscount: null,
  pointsRedeemed: 0,
  totalCents: 4400,
  itemCount: 2,
};

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('held orders', () => {
  it('starts with nothing parked', async () => {
    expect(await readHeldOrders(USER, TILL)).toEqual([]);
  });

  it('holds a sale and reads it back with what it came to', async () => {
    await holdOrder(USER, TILL, sale);
    const held = await readHeldOrders(USER, TILL);
    expect(held).toHaveLength(1);
    expect(held[0].totalCents).toBe(4400);
    expect(held[0].itemCount).toBe(2);
    expect(held[0].cart[0].product.name).toBe('Balanceful Cica Serum');
    expect(held[0].heldAt).toEqual(expect.any(String));
  });

  it('keeps one till separate from another', async () => {
    await holdOrder(USER, TILL, sale);
    expect(await readHeldOrders(USER, OTHER_TILL)).toEqual([]);
  });

  it('keeps one user separate from another', async () => {
    await holdOrder(USER, TILL, sale);
    expect(await readHeldOrders(OTHER_USER, TILL)).toEqual([]);
  });

  it('parks more than one, in the order they were held', async () => {
    await holdOrder(USER, TILL, sale);
    await holdOrder(USER, TILL, { ...sale, totalCents: 999, itemCount: 1 });
    const held = await readHeldOrders(USER, TILL);
    expect(held.map((order) => order.totalCents)).toEqual([4400, 999]);
  });

  it('resumes an order and removes it, so it cannot be sold twice', async () => {
    const [held] = await holdOrder(USER, TILL, sale);
    const { order, remaining } = await resumeHeldOrder(USER, TILL, held.id);
    expect(order?.id).toBe(held.id);
    expect(remaining).toEqual([]);
    expect(await readHeldOrders(USER, TILL)).toEqual([]);
  });

  it('returns nothing for an id that is not parked, and keeps the rest', async () => {
    await holdOrder(USER, TILL, sale);
    const { order, remaining } = await resumeHeldOrder(USER, TILL, 'not-a-hold');
    expect(order).toBeNull();
    expect(remaining).toHaveLength(1);
    expect(await readHeldOrders(USER, TILL)).toHaveLength(1);
  });

  it('survives a corrupt payload rather than throwing at the till', async () => {
    await AsyncStorage.setItem(keyFor(USER, TILL), 'not json');
    expect(await readHeldOrders(USER, TILL)).toEqual([]);
  });

  it('drops an entry that is not a hold, and keeps the ones that are', async () => {
    await AsyncStorage.setItem(
      keyFor(USER, TILL),
      JSON.stringify([{ id: 'h1', cart }, { nonsense: true }, { id: 'h2', cart: [] }])
    );
    const held = await readHeldOrders(USER, TILL);
    expect(held.map((order) => order.id)).toEqual(['h1']);
  });
});
