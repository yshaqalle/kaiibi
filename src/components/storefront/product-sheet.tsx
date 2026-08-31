import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { TABULAR, TYPE } from '@/components/storefront/scale';
import { ProductActions } from '@/components/storefront/theme-shared';
import { AppModal } from '@/components/ui/app-modal';
import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

type Props = {
  product: StorefrontProduct | null;
  colors: PaletteColors;
  shopName: string;
  whatsappE164: string | null;
  onClose: () => void;
  onAdd: (product: StorefrontProduct) => void;
};

// The one place `products.description` has ever had somewhere to live.
//
// The column has been selected by get_public_storefront_products since the
// storefront shipped and mapped in storefront.ts, and no theme rendered it.
// Shopkeepers typed it and no customer ever saw a word -- data paid for on
// every page load and thrown away on arrival.
//
// It also gives the product tile a reason to be pressable, which is what a
// customer's thumb tries first on any shop page and which did nothing at all
// until now.
//
// WHAT THIS IS NOT: a route. Browsing, cart, checkout and confirmation all
// happen on one screen precisely so a flaky connection mid-order never loses
// the cart (see theme-market.tsx). A product detail PAGE would be the first
// thing on this page to break that rule, and a modal costs nothing by
// comparison -- back/Escape closes it, and the grid underneath keeps its
// scroll position.
export function ProductSheet({ product, colors, shopName, whatsappE164, onClose, onAdd }: Props) {
  // Driven by `product` rather than a separate `visible` flag: two sources of
  // truth for "is the sheet open" is how a sheet ends up open with nothing in
  // it after the list refreshes.
  if (!product) return null;

  const outOfStock = product.stock <= 0;

  return (
    <AppModal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.ground }]}>
          <View style={styles.head}>
            {/* The grab handle is decorative -- the Close button below is the
                real affordance, because a drag-to-dismiss a customer has to
                discover is not one. */}
            <View style={[styles.grab, { backgroundColor: colors.soft }]} />
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {/* NO placeholder when there is no photo, which is the opposite of
                what ProductTile does -- and deliberately so.

                A tile is mostly picture, so its no-photo branch has to fill
                that space with something intentional (the name, set large on
                `soft`). A sheet is mostly WORDS: it already leads with the
                name at 22px, then the price, then the description. A 4:3 block
                here would repeat the name it sits directly above and push the
                description -- the entire reason this component exists -- below
                the fold on a phone.

                Verified in a browser at 400x880, which is where both of those
                problems were visible and neither was in jest. */}
            {product.imageUrl ? (
              <Image source={{ uri: product.imageUrl }} style={styles.photo} resizeMode="cover" />
            ) : null}

            <Text style={[styles.name, { color: colors.ink }]}>{product.name}</Text>

            <View style={styles.priceRow}>
              <Text style={[styles.price, { color: colors.ink }]}>{formatCents(product.priceCents)}</Text>
              {outOfStock ? (
                <View style={[styles.stockPill, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.stockPillText, { color: colors.stockOut }]}>Out of stock</Text>
                </View>
              ) : (
                <Text style={[styles.stock, { color: colors.ink }]}>In stock</Text>
              )}
            </View>

            {/* The point of the whole component. Rendered only when there is
                one -- an empty paragraph gap under the price would read as a
                loading state that never resolves. */}
            {product.description ? (
              <Text testID="product-sheet-description" style={[styles.description, { color: colors.muted }]}>
                {product.description}
              </Text>
            ) : null}

            {product.category ? (
              <Text style={[styles.category, { color: colors.muted }]}>{product.category.toUpperCase()}</Text>
            ) : null}

            <View style={styles.actions}>
              <ProductActions
                product={product}
                colors={colors}
                shopName={shopName}
                whatsappE164={whatsappE164}
                // Add, then close: leaving the sheet open over a grid whose
                // cart button has just changed hides the only feedback the
                // action gives.
                onAdd={(p) => {
                  onAdd(p);
                  onClose();
                }}
              />
            </View>

            <Pressable
              testID="product-sheet-close"
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={pressable([styles.close, { backgroundColor: colors.soft }])}
            >
              <Text style={[styles.closeText, { color: colors.ink }]}>Close</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', overflow: 'hidden' },
  head: { alignItems: 'center', paddingTop: 9, paddingBottom: 4 },
  grab: { width: 38, height: 4, borderRadius: 999 },
  body: { paddingHorizontal: 18, paddingBottom: 22, paddingTop: 6 },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 14, marginBottom: 14 },
  name: { fontSize: TYPE.headline, fontWeight: '800', letterSpacing: -0.4, lineHeight: 27 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 9 },
  price: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, ...TABULAR },
  stock: { fontSize: TYPE.meta, fontWeight: '700' },
  stockPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  stockPillText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.2 },
  description: { fontSize: TYPE.body, lineHeight: 20, marginTop: 12 },
  category: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 1, marginTop: 14 },
  actions: { marginTop: 16 },
  close: { borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  closeText: { fontSize: 13.5, fontWeight: '800' },
});
