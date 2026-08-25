import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { addLine, cartItemCount, loadCart, saveCart, setQuantity, type StorefrontCart } from '@/lib/storefront-cart';
import { WHATSAPP_BUTTON_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
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

  return { cart, addProduct, changeQuantity, itemCount: cartItemCount(cart) };
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
});
