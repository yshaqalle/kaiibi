import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// A cart held in a STRANGER'S browser -- no account, no session, no
// register. This is deliberately not src/lib/cart.ts, which is the POS cart a
// signed-in cashier uses at a till (`cartTotalCents`, `buildSalePayload`).
// The two look alike and behave differently; do not merge them.
//
// `unitPriceCents` here is for DISPLAY ONLY. `place_storefront_order`
// recomputes every total server-side from the current `products` rows at
// checkout, so a price that has drifted since it was added to this cart is a
// display bug -- the number the customer sees is stale -- and never a
// pricing bug, because nothing here is ever charged.
export type CartLine = { productId: string; name: string; unitPriceCents: number; quantity: number };

// Keyed by shop slug (see StorefrontCart.slug) so a customer browsing two
// shops in the same tab never has their carts merge into one.
export type StorefrontCart = { slug: string; lines: CartLine[] };

function emptyCart(slug: string): StorefrontCart {
  return { slug, lines: [] };
}

// Truncates to a whole number and floors at zero -- quantity is never
// fractional and never negative. Also absorbs NaN/Infinity from a corrupt
// caller rather than letting it leak into the cart.
function clampQty(qty: number): number {
  const truncated = Math.trunc(qty);
  return Number.isFinite(truncated) && truncated > 0 ? truncated : 0;
}

// Adding a product already in the cart increases its quantity rather than
// adding a second line for the same product.
export function addLine(cart: StorefrontCart, line: Omit<CartLine, 'quantity'>, qty: number = 1): StorefrontCart {
  const existing = cart.lines.find((l) => l.productId === line.productId);
  const nextQty = (existing?.quantity ?? 0) + qty;
  const lines = existing ? cart.lines : [...cart.lines, { ...line, quantity: 0 }];
  return setQuantity({ ...cart, lines }, line.productId, nextQty);
}

// Setting a quantity to zero (or below) removes the line entirely. A
// productId that is not in the cart is a no-op -- this function has no name
// or price to create a line with, only addLine does.
export function setQuantity(cart: StorefrontCart, productId: string, qty: number): StorefrontCart {
  const clamped = clampQty(qty);
  if (clamped === 0) {
    return { ...cart, lines: cart.lines.filter((l) => l.productId !== productId) };
  }
  return { ...cart, lines: cart.lines.map((l) => (l.productId === productId ? { ...l, quantity: clamped } : l)) };
}

// Display-only, same caveat as CartLine.unitPriceCents above: the server is
// the only authority on what anything actually costs.
export function cartSubtotalCents(cart: StorefrontCart): number {
  return cart.lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
}

export function cartItemCount(cart: StorefrontCart): number {
  return cart.lines.reduce((sum, l) => sum + l.quantity, 0);
}

function storageKey(slug: string): string {
  return `kaiibi.storefront.cart.${slug}`;
}

// loadCart/saveCart are synchronous by contract -- the cart sheet reads and
// writes on every tap -- but AsyncStorage, native's only storage API, is not.
// Web is the primary case (the storefront route only ever resolves by
// hostname, see storefront-host.ts, which is a web concept), and there
// `window.localStorage` answers synchronously, so it is read and written
// directly, exactly like locale-storage.ts and held-orders.ts already do for
// the same reason.
//
// Native has no synchronous storage, so a synchronous call there is served
// from this in-memory cache instead, with AsyncStorage read/written
// best-effort underneath: a write updates the cache immediately and persists
// to AsyncStorage in the background (fire-and-forget, like
// locale-storage.ts's writeStoredLocale); a read that misses the cache kicks
// off a background AsyncStorage fetch so a LATER call in the same app
// session can find it, and answers empty for THIS call rather than blocking.
// A cold app start therefore begins with an empty native cart until that
// fetch lands -- an acceptable gap today because nothing serves this route
// natively yet, but worth revisiting if that changes.
const nativeCache = new Map<string, string>();

function readRaw(slug: string): string | null {
  const key = storageKey(slug);
  if (Platform.OS === 'web') {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Storage disabled (private browsing, cookies off) -- see property 5.
      return null;
    }
  }
  if (!nativeCache.has(key)) {
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (raw !== null) nativeCache.set(key, raw);
      })
      .catch(() => {
        // No durable storage available -- the cart still works for the rest
        // of this app session via nativeCache, it just started empty.
      });
  }
  return nativeCache.get(key) ?? null;
}

function writeRaw(slug: string, raw: string): void {
  const key = storageKey(slug);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(key, raw);
    } catch {
      // Storage disabled or full -- the cart still works for the rest of
      // this page's life, it just will not survive a reload. See property 5.
    }
    return;
  }
  nativeCache.set(key, raw);
  AsyncStorage.setItem(key, raw).catch(() => {});
}

function isCartLine(value: unknown): value is CartLine {
  if (!value || typeof value !== 'object') return false;
  const line = value as Partial<CartLine>;
  return (
    typeof line.productId === 'string' &&
    typeof line.name === 'string' &&
    typeof line.unitPriceCents === 'number' &&
    typeof line.quantity === 'number'
  );
}

// Never throws. A browser with storage disabled, a quota error mid-read, or
// a corrupt/foreign stored value all yield an empty cart -- a customer must
// still be able to shop. `slug` always comes from the caller, never from
// whatever happened to be stored, so a request for one shop's cart can never
// hand back another's.
export function loadCart(slug: string): StorefrontCart {
  const raw = readRaw(slug);
  if (!raw) return emptyCart(slug);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { lines?: unknown }).lines)) {
      return emptyCart(slug);
    }
    // Drops any line that doesn't look like a line rather than throwing over
    // the whole cart -- one corrupt entry should not cost the rest of the
    // cart, the same reasoning held-orders.ts applies to a parked sale.
    const lines = (parsed as { lines: unknown[] }).lines.filter(isCartLine);
    return { slug, lines };
  } catch {
    return emptyCart(slug);
  }
}

export function saveCart(cart: StorefrontCart): void {
  writeRaw(cart.slug, JSON.stringify(cart));
}
