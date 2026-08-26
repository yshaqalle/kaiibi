import { useRef, useState } from 'react';
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
  // Ask does not render without a number, the same rule WhatsAppButton
  // above follows: lose the button rather than render one that opens a
  // chat with nobody.
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
// B6: the bar itself is `position: absolute`, so it takes no space in the
// document flow it floats over -- nothing pushes the browsing view's own
// content up to make room for it. Each theme's scrollable container adds
// this much bottom padding of its own, but ONLY while `itemCount > 0` (the
// same condition CheckoutBar below uses to render at all): an empty basket
// must not carry dead space at the bottom of a page with no bar to clear.
// Sized to the bar's own layout -- paddingVertical 14 top and bottom plus a
// ~17px line of 14px/800-weight text is ~45px, plus the 14px gap the bar
// itself sits above the screen edge -- rounded up with headroom rather than
// tuned to the pixel, so a future tweak to the bar's own padding does not
// also require re-measuring this constant.
export const CHECKOUT_BAR_CLEARANCE = 76;

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

// place_storefront_order's own client-error vocabulary
// (20260927000000_place_order.sql's `c_client_errors`) exists precisely so a
// rejection tells the customer what they can fix -- property 9 of the
// checkout brief. supabase-js surfaces a rejected RPC as an error whose
// `message` IS that fixed code word (e.g. 'unavailable_item'), never prose,
// so this is a lookup table from code to a sentence a shopkeeper's customer
// can act on. Anything not in this table -- an unrecognised code, a network
// error with no `message` at all, `order_failed` itself (the fallback the
// RPC degrades an unanticipated server error to) -- keeps the old generic
// sentence, which is still honest for those cases: there really is nothing
// more specific to say.
const GENERIC_ORDER_ERROR = "We couldn't place your order. Check your connection and try again.";

const ORDER_ERROR_MESSAGES: Record<string, string> = {
  shop_unavailable: "This shop isn't taking orders right now.",
  rate_limited: "This shop has had a lot of orders in the last hour. Please try again shortly.",
  name_required: 'Add your name so the shop knows who is ordering.',
  invalid_name: "That name isn't valid. Check it and try again.",
  invalid_phone: "We couldn't recognise that phone number. Check it and try again.",
  invalid_fulfilment: 'Choose collection or delivery and try again.',
  invalid_landmark: 'Describe the landmark near you and try again.',
  invalid_note: 'Shorten your note and try again.',
  delivery_unavailable: "This shop doesn't offer delivery. Choose collection instead.",
  unknown_delivery_area: "That delivery area isn't available any more. Pick another one.",
  empty_cart: 'Your basket is empty. Add something before checking out.',
  cart_too_large: 'There are too many items in your basket. Remove a few and try again.',
  invalid_quantity: 'One of the quantities in your basket looks wrong. Adjust it and try again.',
  // The one code the brief calls out by name: the action is to remove the
  // item, not just be told about it -- CheckoutScreen below renders an
  // "Edit basket" action whenever this exact code comes back, wired to
  // reopen CartSheet on top of the same basket rather than merely saying so.
  unavailable_item: 'One of the items in your basket is no longer available. Remove it to continue.',
};

// The RPC's error surfaces as `error.message` set to the fixed code word
// itself (a thrown PostgrestError, never a plain string) -- this is the one
// place that assumption lives, so a change to how the RPC is called only
// has to update here.
function orderErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function orderErrorMessage(code: string | null): string {
  return (code && ORDER_ERROR_MESSAGES[code]) || GENERIC_ORDER_ERROR;
}

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
// Property 4: a shop with no WhatsApp number still takes orders -- and
// property 2: a shop WITH one offers a genuine choice, not a redirect. The
// choice between the two order functions is made by `via`, the argument
// CheckoutForm's onSubmit hands back to say which of its two controls the
// customer actually pressed -- never re-derived here from whether
// `opts.whatsappE164` merely exists. (It shipped once as exactly that
// re-derivation -- `opts.whatsappE164 ? viaWhatsApp : placeOrder` with no
// `via` at all -- which silently sent every order at a shop with a number
// through WhatsApp, because CheckoutForm only ever rendered the one button
// that could reach here. See submit() below for the fix.)
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
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // B1: a `submitting` STATE guard is not enough. React applies the
  // `setSubmitting(true)` from a first tap's handler on the next render; a
  // second tap landing before that render -- a double tap, not two separate
  // user decisions -- would still close over the pre-update `submitting`
  // value and sail through submit() a second time, placing two orders
  // against the same rate limit. A ref is written synchronously, before any
  // `await`, so a re-entrant call always sees it regardless of render timing.
  const submittingRef = useRef(false);

  function openCheckout() {
    setError(null);
    setErrorCode(null);
    setStage('checkout');
  }

  function backToBrowse() {
    setStage('browse');
  }

  async function submit(cart: StorefrontCart, details: CheckoutDetails, via: 'direct' | 'whatsapp') {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      // Branches on `via` -- what the customer pressed -- not on whether
      // `opts.whatsappE164` exists. The `&& opts.whatsappE164` here is only
      // a type narrow for placeOrderViaWhatsApp's required string param: the
      // WhatsApp control in CheckoutForm cannot render, and so `via` cannot
      // be 'whatsapp', unless a number is already present.
      const placed = via === 'whatsapp' && opts.whatsappE164
        ? await placeOrderViaWhatsApp(opts.slug, cart, details, opts.shopName, opts.whatsappE164)
        : await placeOrder(opts.slug, cart, details);
      opts.onOrderPlaced();
      setOrder(placed);
      setStage('confirmation');
    } catch (err) {
      // A rejected order (a stale product, a full basket, a rate limit)
      // leaves the cart exactly as placeOrder left it -- untouched, since
      // onOrderPlaced above is never reached -- and keeps the customer on
      // 'checkout' rather than bouncing them back to an empty-looking basket,
      // so what they typed is still on screen to retry with. B2: the message
      // itself is now the RPC's own client-error code translated into a
      // sentence the customer can act on (see ORDER_ERROR_MESSAGES above),
      // not a one-size-fits-all "check your connection".
      const code = orderErrorCode(err);
      setErrorCode(code);
      setError(orderErrorMessage(code));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return { stage, order, error, errorCode, submitting, openCheckout, backToBrowse, submit };
}

// Rendered by every theme in place of its own browsing UI once checkout
// begins. Deliberately theme-agnostic: collecting a name, phone and delivery
// address means the same thing on a photo grid or a price list, and only the
// palette should differ between them -- `colors` already carries that.
export function CheckoutScreen({
  storefront, cart, areas, colors, submitting, error, errorCode, onBack, onSubmit, onEditBasket,
}: {
  storefront: PublicStorefront;
  cart: StorefrontCart;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  submitting: boolean;
  error: string | null;
  // B2: which client-error code (if any) `error` was translated from -- only
  // 'unavailable_item' changes what renders below the message, everything
  // else is just the sentence.
  errorCode?: string | null;
  onBack: () => void;
  onSubmit: (details: CheckoutDetails, via: 'direct' | 'whatsapp') => void;
  // B2/B7: reopens the basket on 'unavailable_item' so removing the stale
  // line is one tap away, not a message the customer has to act on by
  // guessing where to go. Optional so a caller mid-migration (and every
  // existing test that predates this) still type-checks.
  onEditBasket?: () => void;
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
        {/* B2: "remove the item" is the action -- so make it possible from
            right here, not just say it and leave the customer to work out
            that the basket is back through the nav bar. */}
        {errorCode === 'unavailable_item' && onEditBasket ? (
          <Pressable
            testID="storefront-checkout-edit-basket"
            accessibilityRole="button"
            onPress={onEditBasket}
            style={[styles.editBasket, { borderColor: colors.danger }]}
          >
            <Text style={[styles.editBasketText, { color: colors.danger }]}>Edit basket</Text>
          </Pressable>
        ) : null}
        <CheckoutForm
          cart={cart}
          colors={colors}
          offersDelivery={storefront.offersDelivery}
          areas={areas}
          submitting={submitting}
          whatsappE164={storefront.whatsappE164}
          onSubmit={onSubmit}
        />
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
  editBasket: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginBottom: 14 },
  editBasketText: { fontSize: 12.5, fontWeight: '800' },
  screenHint: { fontSize: 12.5, marginTop: 10, textAlign: 'center' },
  continueButton: { marginTop: 16, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  continueText: { fontSize: 14, fontWeight: '800' },
});
