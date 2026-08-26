import { Image, StyleSheet, Text, View } from 'react-native';

import { ProductActions } from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

type Props = {
  product: StorefrontProduct;
  colors: PaletteColors;
  // The shop context Ask needs to prefill a wa.me message. Optional because
  // this tile is used from theme-market.tsx / theme-window.tsx, which do not
  // forward storefront context yet -- a later task wires that in. Without a
  // number Ask does not render at all (commit 302630a) -- the same "offer
  // nothing rather than a dead chat" rule WhatsAppButton applies by hiding
  // itself. An Ask that renders and silently does nothing is the worse half
  // of both options: the customer taps and the app shrugs.
  shopName?: string;
  whatsappE164?: string | null;
  // Deliberately a callback, not an import of storefront-cart.ts: a basket
  // held in a stranger's browser has no business living inside a display
  // component, and every other storefront component reaches its data this
  // same prop-driven way (see ThemeProps).
  onAdd?: (product: StorefrontProduct) => void;
};

// The no-photo branch is not an error state.
//
// products.image_url is nullable and most shops fill in a handful at best, so a
// grey box with a broken-image glyph would be the majority case and would make a
// working shop look abandoned. Setting the product name large on the soft tone
// instead gives a tile that reads like a price label -- deliberate at a glance,
// and legible on a phone, which is where nearly all of this traffic will be.
export function ProductTile({ product, colors, shopName, whatsappE164, onAdd }: Props) {
  const outOfStock = product.stock <= 0;

  return (
    <View style={[styles.tile, { borderColor: colors.soft }]}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} style={styles.image} resizeMode="cover" />
      ) : (
        <View style={[styles.image, styles.fallback, { backgroundColor: colors.soft }]}>
          <Text style={[styles.fallbackText, { color: colors.ink }]} numberOfLines={3}>
            {product.name}
          </Text>
        </View>
      )}

      <View style={styles.body}>
        {product.imageUrl ? (
          <Text style={[styles.name, { color: colors.ink }]} numberOfLines={2}>
            {product.name}
          </Text>
        ) : null}
        <Text style={[styles.price, { color: colors.ink }]}>{formatCents(product.priceCents)}</Text>
        <Text style={[styles.stock, { color: outOfStock ? '#8a5a05' : '#1f7a4d' }]}>
          {outOfStock ? 'Out of stock — ask us' : 'In stock'}
        </Text>

        <View style={styles.actions}>
          <ProductActions product={product} colors={colors} shopName={shopName} whatsappE164={whatsappE164} onAdd={onAdd} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  image: { aspectRatio: 1, width: '100%' },
  fallback: { justifyContent: 'flex-end', padding: 10 },
  fallbackText: { fontSize: 16, fontWeight: '800', lineHeight: 20 },
  body: { paddingHorizontal: 10, paddingTop: 9, paddingBottom: 11 },
  name: { fontSize: 12.5, fontWeight: '700', lineHeight: 16, minHeight: 32 },
  price: { fontSize: 15, fontWeight: '800', marginTop: 5 },
  stock: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  actions: { marginTop: 8 },
});
