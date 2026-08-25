import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { type CheckoutDetails, CheckoutForm } from '@/components/storefront/checkout-form';
import { OrderPlaced } from '@/components/storefront/order-placed';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import {
  addLine, cartItemCount, cartSubtotalCents, loadCart, saveCart, setQuantity, type StorefrontCart,
} from '@/lib/storefront-cart';
import { placeOrder, placeOrderViaWhatsApp, type PlacedOrder } from '@/lib/storefront-order';
import { WHATSAPP_BUTTON_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
//
// `areas` is optional so a caller that has none to offer (the theme-level
// component tests predate Task 8 and never pass it) still type-checks and
// renders a collection-only checkout -- CheckoutForm already treats an empty
// list the same as `offersDelivery: false`.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
  areas?: PublicDeliveryArea[];
};

// Returns null when the shop has no number. Publishing requires one, so this is
// the belt to that braces -- a page rendered from a row written before that rule
// existed should lose the button, not render one that opens a chat with nobody.
export function WhatsAppButton({ storefront }: { storefront: PublicStorefront }) {
  if (!storefront.whatsappE164) return null;
  const href = waLink(storefront.whatsappE164, `Hello ${storefront.shopName}, I have a question.`);
  return (
    <Pressable style={styles.wa} onPress={() => openExternalUrl(href)} accessibilityRole="link">
      <Text style={styles.waText}>Message on WhatsApp</Text>
    </Pressable>
  );
}

export function EmptyState({ colors }: { colors: PaletteColors }) {
  return <Text style={[styles.empty, { color: colors.ink }]}>Nothing listed yet.</Text>;
}

type ProductActionsProps = {
  product: StorefrontProduct;
  colors: PaletteColors;
  // See the identical comment on ProductTile's Props in product-tile.tsx --
  // Ask stays visible without a number (WhatsAppButton above hides itself
  // instead, because it's a single nav button; a per-product action can't
  // hide one of a pair without looking broken) and simply becomes inert.
  shopName?: string;
  whatsappE164?: string | null;
  onAdd?: (product: StorefrontProduct) => void;
  // ProductTile renders this pair full-width inside a grid tile; Counter
  // renders it inline in a dense price-list row, where a full-size button
  // pair would turn every row into a card. `compact` is the same two
  // buttons at row scale, not a different component.
  compact?: boolean;
};

// The Add/Ask pair every theme with per-product actions needs. Originally
// lived only in ProductTile (Market, Window); Counter has its own row layout
// and so cannot reuse ProductTile itself, only the two rules its actions
// follow. Extracted here rather than copied a third time, so those rules have
// exactly one place to drift out of sync.
//
// The rules: Add only in stock -- an out-of-stock product keeps Ask, because
// the shop may be restocking and that enquiry is a sale. And Ask only when
// there is a number to ask, for the reason WhatsAppButton above states: lose
// the button rather than render one that opens a chat with nobody. An earlier
// version rendered Ask always and made it silently do nothing, which is the
// worse half of both options -- the customer taps and the app shrugs.
export function ProductActions({ product, colors, shopName, whatsappE164, onAdd, compact }: ProductActionsProps) {
  const outOfStock = product.stock <= 0;

  function handleAsk() {
    // Unreachable now that Ask does not render without a number; kept as the
    // type narrow that lets waLink take a string.
    if (!whatsappE164) return;
    const message = shopName
      ? `Hi ${shopName}, is ${product.name} available?`
      : `Is ${product.name} available?`;
    openExternalUrl(waLink(whatsappE164, message));
  }

  return (
    <View style={[styles.actions, compact && styles.actionsCompact]}>
      {/* Add is only offered in stock -- accent is the palette's own
          "buttons and the active filter" colour, and ground stands in for
          the "always white on it" it's paired with, so this button needs no
          colour literal of its own. */}
      {outOfStock ? null : (
        <Pressable
          testID="product-tile-add"
          accessibilityRole="button"
          style={[styles.button, compact && styles.buttonCompact, { backgroundColor: colors.accent }]}
          onPress={() => onAdd?.(product)}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: colors.ground }]}>Add</Text>
        </Pressable>
      )}
      {/* WhatsApp's own fixed brand colours -- never the shop's palette. */}
      {whatsappE164 ? (
        <Pressable
          testID="product-tile-ask"
          accessibilityRole="button"
          style={[styles.button, compact && styles.buttonCompact, { backgroundColor: WHATSAPP_BUTTON_GREEN }]}
          onPress={handleAsk}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: WHATSAPP_INK }]}>Ask</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The cart entry point every theme needs -- including Counter, which has no
// product grid and so no Add button of its own. The basket is keyed by shop
// slug, not by theme (see storefront-cart.ts), so a customer who added items
// under Market and then lands on Counter -- or whose shop simply switched
// themes -- still needs a way to see and change what is already in it.
export function CartButton({ colors, count, onPress }: { colors: PaletteColors; count: number; onPress: () => void }) {
  return (
    <Pressable
      testID="storefront-cart-button"
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Open basket, ${count} item${count === 1 ? '' : 's'}` : 'Open basket'}
      onPress={onPress}
      style={[styles.cart, { backgroundColor: colors.accent }]}
    >
      <Text style={[styles.cartText, { color: colors.ground }]}>{count > 0 ? `Basket · ${count}` : 'Basket'}</Text>
    </Pressable>
  );
}

// A hardcoded numColumns=2 suits the 390px phone the plan was verified at,
// but leaves a 1280px laptop with a couple of oversized tiles and vast empty
// margins either side. Breakpoints roughly split phone / tablet / laptop --
// three columns is not "the" right answer for 768px so much as a deliberate
// one, same as the rest of the grid a theme renders through.
export function gridColumnsForWidth(width: number): number {
  if (width < 640) return 2;
  if (width < 1024) return 3;
  return 4;
}

// The basket lives in `storefront-cart.ts`, keyed by shop slug, and every
// theme needs to read it, add to it, and change a line's quantity the same
// way -- so that logic is a hook here rather than copied into Market, Window
// and Counter separately. Deliberately not exported as a class or a context:
// nothing here needs to be shared ACROSS components on the same screen, only
// reused across the three that each render their own tree.
export function useStorefrontCart(slug: string) {
  const [cart, setCart] = useState<StorefrontCart>(() => loadCart(slug));

  function addProduct(product: StorefrontProduct) {
    setCart((prev) => {
      const next = addLine(prev, { productId: product.id, name: product.name, unitPriceCents: product.priceCents });
      saveCart(next);
      return next;
    });
  }

  function changeQuantity(productId: string, quantity: number) {
    setCart((prev) => {
      const next = setQuantity(prev, productId, quantity);
      saveCart(next);
      return next;
    });
  }

  // placeOrder (storefront-order.ts) already clears the STORED cart the
  // moment an order is accepted -- this brings the in-memory copy every theme
  // reads back in sync with that, so a customer who places a second order
  // doesn't see the first one's lines still sitting in the basket. Never
  // called on a rejected order: the caller only reaches this after
  // placeOrder/placeOrderViaWhatsApp has resolved, never from a catch block.
  function clearCart() {
    setCart((prev) => {
      const next: StorefrontCart = { ...prev, lines: [] };
      saveCart(next);
      return next;
    });
  }

  return {
    cart,
    addProduct,
    changeQuantity,
    clearCart,
    itemCount: cartItemCount(cart),
    subtotalCents: cartSubtotalCents(cart),
  };
}

// The direct path from a non-empty basket to checkout. CartSheet (the basket
// review modal) has a fixed prop surface --
// visible/onClose/cart/colors/onChangeQuantity, see cart-sheet.tsx -- and
// gained no checkout affordance of its own, so this sticky bar is what every
// theme renders instead: named after the subtotal, gone the moment the
// basket is empty, so it can never invite a checkout with nothing in it.
export function CheckoutBar({
  colors, itemCount, subtotalCents, onPress,
}: { colors: PaletteColors; itemCount: number; subtotalCents: number; onPress: () => void }) {
  if (itemCount === 0) return null;
  return (
    <Pressable
      testID="storefront-checkout-bar"
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.checkoutBar, { backgroundColor: colors.accent }]}
    >
      <Text style={[styles.checkoutBarText, { color: colors.ground }]}>Checkout · {formatCents(subtotalCents)}</Text>
    </Pressable>
  );
}

export type CheckoutStage = 'browse' | 'checkout' | 'confirmation';

// Owns everything past "browsing" that every theme needs, and nothing a
// theme should have to get right on its own: filling in checkout, submitting
// through the right one of Task 7's two order functions, and landing on a
// confirmation. Kept out of any one theme for the same reason
// useStorefrontCart is -- Market, Window and Counter all need the identical
// sequencing (place the order, THEN clear the cart, THEN show the
// confirmation; never the other order, and never on a rejected order -- see
// storefront-order.ts's own comments on why that ordering is structural
// there, not just tested behaviour here).
//
// Property 4: a shop with no WhatsApp number still takes orders. The choice
// between the two order functions is made ONCE, here, from
// `whatsappE164` -- never from whether a customer happened to type
// something -- mirroring the same guard WhatsAppButton and ProductActions
// already apply to Ask.
export function useCheckoutFlow(opts: {
  slug: string;
  shopName: string;
  whatsappE164: string | null;
  // Called once an order has actually been accepted, never on a rejection --
  // wired to useStorefrontCart's clearCart above.
  onOrderPlaced: () => void;
}) {
  const [stage, setStage] = useState<CheckoutStage>('browse');
  const [order, setOrder] = useState<PlacedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function openCheckout() {
    setError(null);
    setStage('checkout');
  }

  function backToBrowse() {
    setStage('browse');
  }

  async function submit(cart: StorefrontCart, details: CheckoutDetails) {
    setSubmitting(true);
    setError(null);
    try {
      const placed = opts.whatsappE164
        ? await placeOrderViaWhatsApp(opts.slug, cart, details, opts.shopName, opts.whatsappE164)
        : await placeOrder(opts.slug, cart, details);
      opts.onOrderPlaced();
      setOrder(placed);
      setStage('confirmation');
    } catch {
      // A rejected order (a stale product, a full basket, a rate limit)
      // leaves the cart exactly as placeOrder left it -- untouched, since
      // onOrderPlaced above is never reached -- and keeps the customer on
      // 'checkout' rather than bouncing them back to an empty-looking basket,
      // so what they typed is still on screen to retry with.
      setError("We couldn't place your order. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return { stage, order, error, submitting, openCheckout, backToBrowse, submit };
}

// Rendered by every theme in place of its own browsing UI once checkout
// begins. Deliberately theme-agnostic: collecting a name, phone and delivery
// address means the same thing on a photo grid or a price list, and only the
// palette should differ between them -- `colors` already carries that.
export function CheckoutScreen({
  storefront, cart, areas, colors, submitting, error, onBack, onSubmit,
}: {
  storefront: PublicStorefront;
  cart: StorefrontCart;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (details: CheckoutDetails) => void;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <View style={styles.screenNav}>
        <Pressable testID="storefront-checkout-back" accessibilityRole="button" onPress={onBack} hitSlop={8}>
          <Text style={[styles.screenBack, { color: colors.ink }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.screenTitle, { color: colors.ink }]}>Checkout</Text>
      </View>
      <ScrollView contentContainerStyle={styles.screenBody}>
        {error ? <Text style={[styles.screenError, { color: colors.danger }]}>{error}</Text> : null}
        <CheckoutForm cart={cart} colors={colors} offersDelivery={storefront.offersDelivery} areas={areas} onSubmit={onSubmit} />
        {submitting ? <Text style={[styles.screenHint, { color: colors.muted }]}>Placing your order…</Text> : null}
      </ScrollView>
    </View>
  );
}

// The last screen a customer sees on this page. "Continue shopping" is the
// only way onward -- there is no order history and no account, per
// order-placed.tsx's own header comment on what this trade can honestly
// promise today.
export function ConfirmationScreen({
  order, shopName, colors, onDone,
}: { order: PlacedOrder; shopName: string; colors: PaletteColors; onDone: () => void }) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <ScrollView contentContainerStyle={styles.screenBody}>
        <OrderPlaced order={order} shopName={shopName} colors={colors} />
        <Pressable
          testID="storefront-continue-shopping"
          accessibilityRole="button"
          onPress={onDone}
          style={[styles.continueButton, { backgroundColor: colors.soft }]}
        >
          <Text style={[styles.continueText, { color: colors.ink }]}>Continue shopping</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Fixed green in every palette: a recognised affordance, not a brand colour.
  wa: { backgroundColor: WHATSAPP_BUTTON_GREEN, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  waText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  empty: { fontSize: 14, fontWeight: '700', padding: 24, textAlign: 'center' },
  cart: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  cartText: { fontSize: 12.5, fontWeight: '800' },
  // Full-size default: ProductTile's grid tile, where the pair fills the
  // tile's own width evenly.
  actions: { flexDirection: 'row', gap: 6 },
  button: { flex: 1, borderRadius: 9, paddingVertical: 6, alignItems: 'center' },
  buttonText: { fontSize: 12, fontWeight: '800' },
  // Row scale: Counter's dense price list, where the pair sits inline next
  // to the stock label rather than filling a row's width.
  actionsCompact: { gap: 4 },
  buttonCompact: { flex: 0, borderRadius: 7, paddingVertical: 3, paddingHorizontal: 9 },
  buttonTextCompact: { fontSize: 10.5 },
  // Floats over the browsing view's own content -- the parent View every
  // theme renders is flex:1 with no explicit `position`, which React Native
  // defaults to 'relative', so this anchors to that box rather than the
  // whole window.
  checkoutBar: {
    position: 'absolute', left: 14, right: 14, bottom: 14,
    borderRadius: 999, paddingVertical: 14, alignItems: 'center',
  },
  checkoutBarText: { fontSize: 14, fontWeight: '800' },
  screen: { flex: 1 },
  screenNav: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  screenBack: { fontSize: 14, fontWeight: '700' },
  screenTitle: { fontSize: 16, fontWeight: '800' },
  screenBody: { paddingHorizontal: 14, paddingBottom: 24 },
  screenError: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  screenHint: { fontSize: 12.5, marginTop: 10, textAlign: 'center' },
  continueButton: { marginTop: 16, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  continueText: { fontSize: 14, fontWeight: '800' },
});
