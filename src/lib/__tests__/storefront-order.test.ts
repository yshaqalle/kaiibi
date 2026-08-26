// place_storefront_order (supabase/migrations/20260927000000_place_order.sql)
// is the RPC under test here. See that file for the exact request/response
// shape this module builds and reads.
const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

const mockOpenExternalUrl = jest.fn();
jest.mock('@/lib/external-url', () => ({ openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args) }));

import { Platform } from 'react-native';

import type { CheckoutDetails } from '@/components/storefront/checkout-form';
import { addLine, loadCart, saveCart, type StorefrontCart } from '@/lib/storefront-cart';
import { buildOrderMessage, placeOrder, placeOrderViaWhatsApp, type PlacedOrder } from '@/lib/storefront-order';

const rpc = mockRpc;
const openExternalUrl = mockOpenExternalUrl;

// storefront-cart.ts persists via window.localStorage on web (this is RN's
// jest environment, which has a `window` but no real localStorage) -- same
// fake as storefront-cart.test.ts uses.
const webStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => webStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void webStorage.set(key, value),
  removeItem: (key: string) => void webStorage.delete(key),
};
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });

const SLUG = 'xamdi';

const soap = { productId: 'p1', name: 'Soap', unitPriceCents: 500 };
const oil = { productId: 'p2', name: 'Oil', unitPriceCents: 1200 };

function cartWithLines(): StorefrontCart {
  let cart: StorefrontCart = { slug: SLUG, lines: [] };
  cart = addLine(cart, soap, 2);
  cart = addLine(cart, oil, 1);
  return cart;
}

const details: CheckoutDetails = {
  name: 'Amina Warsame',
  phone: '+252634456789',
  fulfilment: 'collect',
  deliveryArea: null,
  deliveryLandmark: null,
  note: null,
};

const deliveryDetails: CheckoutDetails = {
  name: 'Amina Warsame',
  phone: '+252634456789',
  fulfilment: 'deliver',
  deliveryArea: "Ga'an Libaax",
  deliveryLandmark: 'Behind Maansoor Hotel, blue gate',
  note: null,
};

// The RPC's exact response shape, per 20260927000000_place_order.sql's
// jsonb_build_object at the end of place_storefront_order.
const collectResponse = {
  number: 7,
  status: 'pending',
  payment_mode: 'on_collection',
  fulfilment: 'collect',
  delivery_area: null,
  customer_phone: '+252634456789',
  subtotal_cents: 2200,
  delivery_fee_cents: 0,
  total_cents: 2200,
  items: [
    { product_id: 'p1', name: 'Soap', unit_price_cents: 500, quantity: 2, line_total_cents: 1000 },
    { product_id: 'p2', name: 'Oil', unit_price_cents: 1200, quantity: 1, line_total_cents: 1200 },
  ],
};

const deliverResponse = {
  ...collectResponse,
  fulfilment: 'deliver',
  delivery_area: "Ga'an Libaax",
  delivery_fee_cents: 200,
  total_cents: 2400,
};

beforeEach(() => {
  rpc.mockReset();
  openExternalUrl.mockReset();
  webStorage.clear();
});

describe('placeOrder', () => {
  it('calls place_storefront_order with the slug, customer and items shaped exactly as the RPC expects', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    saveCart(cartWithLines());

    await placeOrder(SLUG, cartWithLines(), details);

    expect(rpc).toHaveBeenCalledWith('place_storefront_order', {
      p_slug: SLUG,
      p_customer: {
        name: 'Amina Warsame',
        phone: '+252634456789',
        fulfilment: 'collect',
        delivery_area: null,
        delivery_landmark: null,
        note: null,
      },
      p_items: [
        { product_id: 'p1', quantity: 2 },
        { product_id: 'p2', quantity: 1 },
      ],
    });
  });

  // B5: orders.note is dead end to end until this ships -- the column exists,
  // the RPC reads p_customer->>'note' and has its own invalid_note code, and
  // checkout-form.tsx now collects it, but placeOrder is the one call site
  // that actually has to put it on the wire.
  it('forwards a customer note to the RPC', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });

    await placeOrder(SLUG, cartWithLines(), { ...details, note: 'Ring the bell, please' });

    expect(rpc).toHaveBeenCalledWith(
      'place_storefront_order',
      expect.objectContaining({ p_customer: expect.objectContaining({ note: 'Ring the bell, please' }) })
    );
  });

  // Property 1: the client never computes the total it displays.
  it('returns exactly what the server computed, never a locally-derived total', async () => {
    rpc.mockResolvedValue({ data: deliverResponse, error: null });

    const order = await placeOrder(SLUG, cartWithLines(), deliveryDetails);

    const expected: PlacedOrder = {
      number: 7,
      status: 'pending',
      paymentMode: 'on_collection',
      fulfilment: 'deliver',
      deliveryArea: "Ga'an Libaax",
      customerPhone: '+252634456789',
      subtotalCents: 2200,
      deliveryFeeCents: 200,
      totalCents: 2400,
      items: [
        { productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2, lineTotalCents: 1000 },
        { productId: 'p2', name: 'Oil', unitPriceCents: 1200, quantity: 1, lineTotalCents: 1200 },
      ],
    };
    expect(order).toEqual(expected);
  });

  // Property 4: cleared on success, and only on success.
  it('clears the cart for that slug on success', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    saveCart(cartWithLines());
    expect(loadCart(SLUG).lines).toHaveLength(2);

    await placeOrder(SLUG, cartWithLines(), details);

    expect(loadCart(SLUG)).toEqual({ slug: SLUG, lines: [] });
  });

  // Property 5: a failed placement keeps the basket.
  it('leaves the cart untouched when the RPC rejects the order', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'empty_cart' } });
    saveCart(cartWithLines());

    await expect(placeOrder(SLUG, cartWithLines(), details)).rejects.toBeTruthy();

    expect(loadCart(SLUG).lines).toHaveLength(2);
  });

  it("does not touch a different shop's cart", async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    const otherSlug = 'baraf';
    saveCart({ slug: otherSlug, lines: [{ ...soap, quantity: 1 }] });
    saveCart(cartWithLines());

    await placeOrder(SLUG, cartWithLines(), details);

    expect(loadCart(otherSlug).lines).toEqual([{ ...soap, quantity: 1 }]);
  });
});

describe('buildOrderMessage', () => {
  // Property 3: shop name, order number, each line (quantity and price), the
  // delivery line if any, the total, and how the customer pays -- asserted
  // as the whole string, not a substring.
  it('builds the exact message for a collect order', () => {
    const order: PlacedOrder = {
      number: 7,
      status: 'pending',
      paymentMode: 'on_collection',
      fulfilment: 'collect',
      deliveryArea: null,
      customerPhone: '+252634456789',
      subtotalCents: 2200,
      deliveryFeeCents: 0,
      totalCents: 2200,
      items: [
        { productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2, lineTotalCents: 1000 },
        { productId: 'p2', name: 'Oil', unitPriceCents: 1200, quantity: 1, lineTotalCents: 1200 },
      ],
    };

    expect(buildOrderMessage(order, 'Xamdi Grocers')).toBe(
      [
        'Order #7 — Xamdi Grocers',
        '',
        '2 x Soap — $10.00',
        '1 x Oil — $12.00',
        '',
        'Total: $22.00',
        '',
        'Pay $22.00 on collection.',
      ].join('\n')
    );
  });

  it('builds the exact message for a deliver order, with a delivery line', () => {
    const order: PlacedOrder = {
      number: 12,
      status: 'pending',
      paymentMode: 'on_collection',
      fulfilment: 'deliver',
      deliveryArea: "Ga'an Libaax",
      customerPhone: '+252634456789',
      subtotalCents: 2200,
      deliveryFeeCents: 200,
      totalCents: 2400,
      items: [
        { productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2, lineTotalCents: 1000 },
        { productId: 'p2', name: 'Oil', unitPriceCents: 1200, quantity: 1, lineTotalCents: 1200 },
      ],
    };

    expect(buildOrderMessage(order, 'Xamdi Grocers')).toBe(
      [
        "Order #12 — Xamdi Grocers",
        '',
        '2 x Soap — $10.00',
        '1 x Oil — $12.00',
        '',
        "Delivery (Ga'an Libaax) — $2.00",
        '',
        'Total: $24.00',
        '',
        'Pay $24.00 on delivery.',
      ].join('\n')
    );
  });
});

describe('placeOrderViaWhatsApp', () => {
  // Property 2, the sharpest one: both buttons write the same order, and the
  // order is written FIRST -- opening wa.me is a consequence of a write that
  // already happened, never a precondition for it.
  it('writes the order, then opens wa.me prefilled with the order number and every line', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    saveCart(cartWithLines());

    const callOrder: string[] = [];
    rpc.mockImplementation(async () => {
      callOrder.push('rpc');
      return { data: collectResponse, error: null };
    });
    openExternalUrl.mockImplementation(() => {
      callOrder.push('open');
    });

    const order = await placeOrderViaWhatsApp(SLUG, cartWithLines(), details, 'Xamdi Grocers', '+252634456789');

    expect(callOrder).toEqual(['rpc', 'open']);
    expect(order.number).toBe(7);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    const url = openExternalUrl.mock.calls[0][0] as string;
    expect(url).toContain('wa.me/252634456789');
    expect(url).toContain(encodeURIComponent('Order #7 — Xamdi Grocers'));
    expect(url).toContain(encodeURIComponent('2 x Soap — $10.00'));
  });

  // If the customer never sends the message, the order must still exist --
  // so the cart clears here too, exactly as it does for the plain button.
  it('clears the cart on success, same as the plain place-order path', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    saveCart(cartWithLines());

    await placeOrderViaWhatsApp(SLUG, cartWithLines(), details, 'Xamdi Grocers', '+252634456789');

    expect(loadCart(SLUG)).toEqual({ slug: SLUG, lines: [] });
  });

  // A blocked popup or any other failure opening the link must never
  // retroactively un-write the order that already landed.
  it('never opens WhatsApp when the order fails to place, and never throws from the open step masking that', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'empty_cart' } });
    saveCart(cartWithLines());

    await expect(
      placeOrderViaWhatsApp(SLUG, cartWithLines(), details, 'Xamdi Grocers', '+252634456789')
    ).rejects.toBeTruthy();

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(loadCart(SLUG).lines).toHaveLength(2);
  });

  // On web, openExternalUrl does synchronous DOM work (document.createElement,
  // a.click()) that a Trusted-Types CSP or similar can make throw. That throw
  // must never read back as "the order failed" -- the order already landed
  // and the cart is already cleared by the time it happens, so a caller must
  // still get the placed order back, not a rejected promise.
  it('still resolves with the placed order when opening the WhatsApp link throws', async () => {
    rpc.mockResolvedValue({ data: collectResponse, error: null });
    saveCart(cartWithLines());
    openExternalUrl.mockImplementation(() => {
      throw new Error('Trusted Types: assignment to href rejected');
    });

    const order = await placeOrderViaWhatsApp(SLUG, cartWithLines(), details, 'Xamdi Grocers', '+252634456789');

    expect(order.number).toBe(7);
    expect(loadCart(SLUG)).toEqual({ slug: SLUG, lines: [] });
  });
});
