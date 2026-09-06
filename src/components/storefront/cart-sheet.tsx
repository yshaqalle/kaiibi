import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { AppModal } from '@/components/ui/app-modal';
import { SHEET_MAX_WIDTH, SPACE, TABULAR } from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import { cartSubtotalCents, type StorefrontCart } from '@/lib/storefront-cart';
import { CHECKOUT_BLUE, CHECKOUT_INK, type PaletteColors } from '@/lib/storefront-catalog';

type Props = {
  visible: boolean;
  onClose: () => void;
  cart: StorefrontCart;
  colors: PaletteColors;
  // Fires with the target quantity, already computed -- this component does
  // not know or care that zero means "remove the line"; that is
  // storefront-cart.ts's setQuantity, one call away in the theme that owns
  // the cart's state.
  onChangeQuantity: (productId: string, quantity: number) => void;
  // B7: opening this sheet used to be a dead end -- a customer reviewing
  // their cart had no way onward except closing it again and finding the
  // theme's own sticky bar underneath. The caller decides what "go to
  // checkout" means (every theme both closes this sheet and opens its own
  // checkout stage), this component only has to offer the action.
  onCheckout: () => void;
};

// What a stranger's cart has to say, and just as importantly what it must
// never say:
//
//   * No delivery line, no total -- only a subtotal. Delivery is not knowable
//     until an area is chosen at checkout (place_storefront_order recomputes
//     it server-side), so showing a number here that changes at checkout
//     would read as a broken price, not an estimate.
//   * "Nothing is charged now" is stated plainly, not implied by the absence
//     of a pay button. This is a stranger's first contact with the fact that
//     a kaiibi storefront takes an ORDER, not a payment -- checkout happens
//     on collection or delivery.
export function CartSheet({ visible, onClose, cart, colors, onChangeQuantity, onCheckout }: Props) {
  return (
    <AppModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.ground }]}>
          <View style={styles.head}>
            <Text style={[styles.title, { color: colors.ink }]}>Your cart</Text>
            <Pressable
              testID="cart-sheet-close"
              accessibilityRole="button"
              accessibilityLabel="Close cart"
              onPress={onClose}
              style={pressable([styles.close, { backgroundColor: colors.soft }])}
            >
              <Text style={[styles.closeText, { color: colors.ink }]}>Close</Text>
            </Pressable>
          </View>

          {cart.lines.length === 0 ? (
            <Text style={[styles.empty, { color: colors.muted }]}>Your cart is empty.</Text>
          ) : (
            <>
              {/* THE LINES SCROLL; THE MONEY AND THE WAY ONWARD DO NOT.
                  This sheet had no scroller at all: a cart of a dozen lines
                  simply grew past `maxHeight` and took Subtotal and Checkout
                  off the bottom of the screen with it -- the customer with the
                  fullest basket being the one who could not pay for it. The
                  same split ProductSheet makes, for the same reason: what you
                  are reading may be any length, what you are deciding with
                  must always be on screen. */}
              <ScrollView testID="cart-sheet-lines" style={styles.lines}>
              {cart.lines.map((line) => (
                <View key={line.productId} style={[styles.line, { borderBottomColor: colors.hairline }]}>
                  <View style={styles.lineName}>
                    <Text style={[styles.name, { color: colors.ink }]} numberOfLines={2}>
                      {line.name}
                    </Text>
                    <Text style={[styles.lineAmount, { color: colors.muted }]}>
                      {formatCents(line.unitPriceCents * line.quantity)}
                    </Text>
                  </View>

                  <View style={[styles.stepper, { backgroundColor: colors.soft }]}>
                    <Pressable
                      testID={`cart-line-decrease-${line.productId}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Reduce ${line.name} quantity`}
                      hitSlop={6}
                      onPress={() => onChangeQuantity(line.productId, line.quantity - 1)}
                      style={pressable([styles.stepButton, { backgroundColor: colors.ground }])}
                    >
                      <Text style={[styles.stepButtonText, { color: colors.ink }]}>−</Text>
                    </Pressable>
                    <Text style={[styles.qty, { color: colors.ink }]}>{line.quantity}</Text>
                    <Pressable
                      testID={`cart-line-increase-${line.productId}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Increase ${line.name} quantity`}
                      hitSlop={6}
                      onPress={() => onChangeQuantity(line.productId, line.quantity + 1)}
                      style={pressable([styles.stepButton, { backgroundColor: colors.ground }])}
                    >
                      <Text style={[styles.stepButtonText, { color: colors.ink }]}>+</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
              </ScrollView>

              <View style={styles.subtotalRow}>
                <Text style={[styles.subtotalLabel, { color: colors.ink }]}>Subtotal</Text>
                <Text style={[styles.subtotalValue, { color: colors.ink }]}>{formatCents(cartSubtotalCents(cart))}</Text>
              </View>

              <Text style={[styles.caveat, { color: colors.muted }]}>
                Delivery isn&apos;t shown here — it depends on the area you choose at checkout.
              </Text>
              <Text style={[styles.caveat, { color: colors.muted }]}>
                Nothing is charged now. You pay on collection or delivery.
              </Text>

              {/* B7: the way onward, from right here -- reviewing the cart
                  used to be a dead end that only closing this sheet and
                  finding the theme's own sticky bar could get past. */}
              <Pressable
                testID="cart-sheet-checkout"
                accessibilityRole="button"
                onPress={onCheckout}
                style={pressable([styles.checkout, { backgroundColor: CHECKOUT_BLUE }])}
              >
                <Text style={[styles.checkoutText, { color: CHECKOUT_INK }]}>Checkout</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  // The same inset ProductSheet's overlay carries, and for the same reason
  // written out there: flush against the window's bottom edge, Checkout is the
  // first thing a dock or a download bar covers. The bottom is larger than the
  // sides because it has more to clear.
  overlay: {
    flex: 1, backgroundColor: 'rgba(11,11,13,0.45)',
    justifyContent: 'flex-end', alignItems: 'center',
    padding: SPACE.cardGap,
    paddingBottom: SPACE.cardGap + SPACE.card,
  },
  // Bounded and centred like the product sheet: a cart of three lines stretched
  // across a 1,500px window is a receipt printed on a bedsheet. Four rounded
  // corners because it now floats clear of the edge rather than growing out of
  // it.
  sheet: {
    borderRadius: 24, padding: 18, maxHeight: '85%',
    width: '100%', maxWidth: SHEET_MAX_WIDTH,
  },
  // `flexShrink: 1`, never `flex: 1` -- the lines list must be free to be
  // shorter than the sheet (a one-line cart should not stretch), and only
  // gives way when the sheet's own maxHeight would otherwise be exceeded.
  // RN Views default to flexShrink 0, so without this the list would push the
  // subtotal and Checkout out through the bottom instead of scrolling.
  lines: { flexShrink: 1 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  close: { borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14 },
  closeText: { fontSize: 12.5, fontWeight: '700' },
  empty: { fontSize: 14, fontWeight: '700', paddingVertical: 24, textAlign: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  lineName: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '700' },
  lineAmount: { fontSize: 12.5, marginTop: 2, ...TABULAR },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 6 },
  stepButton: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stepButtonText: { fontSize: 16, fontWeight: '800' },
  qty: { minWidth: 18, textAlign: 'center', fontSize: 14, fontWeight: '800', ...TABULAR },
  subtotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 14 },
  subtotalLabel: { fontSize: 14, fontWeight: '800' },
  subtotalValue: { fontSize: 16, fontWeight: '800', ...TABULAR },
  caveat: { fontSize: 12, marginTop: 8, lineHeight: 16 },
  checkout: { marginTop: 16, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  checkoutText: { fontSize: 14, fontWeight: '800' },
});
