import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import {
  addLine,
  cartItemCount,
  cartSubtotalCents,
  loadCart,
  saveCart,
  setQuantity,
  type StorefrontCart,
} from '@/lib/storefront-cart';

const SLUG = 'xamdi';
const OTHER_SLUG = 'baraf';

const soap = { productId: 'p1', name: 'Soap', unitPriceCents: 500 };
const oil = { productId: 'p2', name: 'Oil', unitPriceCents: 1200 };

function cart(slug: string, lines: StorefrontCart['lines'] = []): StorefrontCart {
  return { slug, lines };
}

describe('cart maths', () => {
  it('adds a new product as a new line', () => {
    const next = addLine(cart(SLUG), soap);
    expect(next.lines).toEqual([{ ...soap, quantity: 1 }]);
  });

  it('adds a given quantity rather than defaulting to one', () => {
    const next = addLine(cart(SLUG), soap, 3);
    expect(next.lines).toEqual([{ ...soap, quantity: 3 }]);
  });

  it('adding a product already in the cart increases its quantity instead of duplicating the line', () => {
    let next = addLine(cart(SLUG), soap, 2);
    next = addLine(next, soap, 1);
    expect(next.lines).toEqual([{ ...soap, quantity: 3 }]);
  });

  it('keeps two different products as two separate lines', () => {
    let next = addLine(cart(SLUG), soap);
    next = addLine(next, oil);
    expect(next.lines.map((l) => l.productId)).toEqual(['p1', 'p2']);
  });

  it('setQuantity updates an existing line', () => {
    const next = setQuantity(addLine(cart(SLUG), soap, 1), 'p1', 5);
    expect(next.lines).toEqual([{ ...soap, quantity: 5 }]);
  });

  it('setting a quantity to zero removes the line', () => {
    const withSoap = addLine(cart(SLUG), soap, 2);
    expect(setQuantity(withSoap, 'p1', 0).lines).toEqual([]);
  });

  it('quantity is never negative -- a negative target also removes the line', () => {
    const withSoap = addLine(cart(SLUG), soap, 2);
    expect(setQuantity(withSoap, 'p1', -4).lines).toEqual([]);
  });

  it('setQuantity on a product that is not in the cart is a no-op', () => {
    const empty = cart(SLUG);
    expect(setQuantity(empty, 'p1', 3)).toEqual(empty);
  });

  it('sums unit price times quantity across every line', () => {
    let next = addLine(cart(SLUG), soap, 2); // 1000
    next = addLine(next, oil, 3); // 3600
    expect(cartSubtotalCents(next)).toBe(4600);
  });

  it('an empty cart has a zero subtotal', () => {
    expect(cartSubtotalCents(cart(SLUG))).toBe(0);
  });

  it('counts items as total quantity, not number of lines', () => {
    let next = addLine(cart(SLUG), soap, 2);
    next = addLine(next, oil, 3);
    expect(cartItemCount(next)).toBe(5);
  });

  it('does not mutate the cart passed in', () => {
    const original = cart(SLUG);
    addLine(original, soap, 2);
    expect(original.lines).toEqual([]);
  });
});

// Jest's environment here is React Native's, which has a `window` but no real
// localStorage, so the web path needs a fake one to run against at all --
// same setup as src/lib/__tests__/support-draft.test.ts.
function onPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}
const originalOS = Platform.OS;

const webStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => webStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void webStorage.set(key, value),
  removeItem: (key: string) => void webStorage.delete(key),
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });

// The native path caches in memory and hydrates from AsyncStorage in the
// background (see storefront-cart.ts) -- so a test that wants to observe a
// value that was only ever written straight to AsyncStorage has to let that
// background read land before asserting on it.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const keyFor = (slug: string) => `kaiibi.storefront.cart.${slug}`;

// The native path's in-memory cache (see storefront-cart.ts) has no reset
// hook -- by design, nothing in production ever needs to evict it -- so
// `AsyncStorage.clear()` in beforeEach does not touch it. Each test below
// therefore gets its own slug rather than sharing one across a describe
// block, the same way held-orders.test.ts gives each scenario its own
// user/till rather than reusing one.
let slugCounter = 0;
function freshSlug(os: string): string {
  slugCounter += 1;
  return `${SLUG}-${os}-${slugCounter}`;
}

describe.each(['web', 'ios'] as const)('cart persistence on %s', (os) => {
  let slug: string;
  let otherSlug: string;

  beforeEach(async () => {
    onPlatform(os);
    webStorage.clear();
    await AsyncStorage.clear();
    slug = freshSlug(os);
    otherSlug = freshSlug(os);
  });

  afterAll(() => onPlatform(originalOS));

  it('starts empty for a shop that has never been shopped at', () => {
    expect(loadCart(slug)).toEqual({ slug, lines: [] });
  });

  it('round-trips what was saved', () => {
    const next = addLine(cart(slug), soap, 2);
    saveCart(next);
    expect(loadCart(slug)).toEqual(next);
  });

  // Property 1: the cart is keyed by shop slug. A customer browsing two shops
  // must not have their baskets merge.
  it('keeps two shops separate', () => {
    saveCart(addLine(cart(slug), soap, 2));
    saveCart(addLine(cart(otherSlug), oil, 1));

    expect(loadCart(slug).lines).toEqual([{ ...soap, quantity: 2 }]);
    expect(loadCart(otherSlug).lines).toEqual([{ ...oil, quantity: 1 }]);
  });

  // Property 5: persistence degrades safely. A corrupt stored value must
  // yield an empty cart, not a crash -- a customer in private-mode still has
  // to be able to shop.
  it('a corrupt stored value yields an empty cart rather than throwing', async () => {
    const key = keyFor(slug);
    if (os === 'web') {
      webStorage.set(key, 'not json{{{');
    } else {
      await AsyncStorage.setItem(key, 'not json{{{');
    }

    expect(() => loadCart(slug)).not.toThrow();
    if (os !== 'web') await settle();
    expect(() => loadCart(slug)).not.toThrow();
    expect(loadCart(slug)).toEqual({ slug, lines: [] });
  });

  it('a stored value that is not a cart at all yields an empty cart', async () => {
    const key = keyFor(slug);
    if (os === 'web') {
      webStorage.set(key, JSON.stringify({ nonsense: true }));
    } else {
      await AsyncStorage.setItem(key, JSON.stringify({ nonsense: true }));
    }

    if (os !== 'web') {
      loadCart(slug);
      await settle();
    }
    expect(loadCart(slug)).toEqual({ slug, lines: [] });
  });
});

describe('storage disabled entirely', () => {
  afterEach(() => onPlatform(originalOS));

  // Property 5, the sharpest case: getItem/setItem THROW synchronously,
  // which is what Safari private browsing does once its storage quota is
  // zero. A customer there must still be able to add to a cart.
  it('a browser with storage disabled still lets the customer shop', () => {
    onPlatform('web');
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError: storage disabled');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: throwing });

    try {
      expect(() => saveCart(addLine(cart(SLUG), soap))).not.toThrow();
      expect(() => loadCart(SLUG)).not.toThrow();
      expect(loadCart(SLUG)).toEqual({ slug: SLUG, lines: [] });
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });
    }
  });
});
