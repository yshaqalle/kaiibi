import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import {
  CartButton, EmptyState, ProductActions, WhatsAppButton, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import type { StorefrontProduct } from '@/types/models';

// A price list, grouped by products.category -- which already exists and is
// already filled in for most shops. This is the theme that makes a 200-line
// pharmacy catalogue readable, and the one that would have been impossible if
// every theme led with photography.
function groupByCategory(products: StorefrontProduct[]): [string, StorefrontProduct[]][] {
  const groups = new Map<string, StorefrontProduct[]>();
  for (const p of products) {
    const key = p.category ?? 'Other';
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()];
}

export function ThemeCounter({ storefront, products, colors }: ThemeProps) {
  // The basket is keyed by shop slug, not by theme (see theme-shared.tsx's
  // useStorefrontCart) -- a customer can still arrive here with items a
  // grid theme already put in it, or a shop can switch themes with a basket
  // still in progress. Either way this entry point has to be here too.
  const { cart, addProduct, changeQuantity, itemCount } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);

  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={[styles.nav, { borderBottomColor: colors.ink }]}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={[styles.sub, { color: colors.muted }]}>{storefront.city}</Text> : null}
        </View>
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
      </View>

      {/* A plain View never scrolls on native, and Expo Router's web reset sets
          `body { overflow: hidden }` -- either way, a catalogue longer than one
          viewport is unreachable without an explicit scroll container. This is
          the theme built for a long, photo-free price list, so it is the one
          most likely to overflow. */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {storefront.headline ? (
          <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
        ) : null}
        {storefront.about ? <Text style={[styles.about, { color: colors.muted }]}>{storefront.about}</Text> : null}

        {products.length === 0 ? (
          <EmptyState colors={colors} />
        ) : (
          groupByCategory(products).map(([category, items]) => (
            <View key={category} style={styles.section}>
              <Text style={[styles.sectionHead, { color: colors.accent }]}>{category.toUpperCase()}</Text>
              {items.map((p) => (
                <View key={p.id} style={[styles.row, { borderBottomColor: colors.soft }]}>
                  <View style={styles.rowName}>
                    <Text style={[styles.name, { color: colors.ink }]}>{p.name}</Text>
                    {/* Actions live inside this flex:1 column, not after
                        price -- price is a separate flex item that always
                        hugs its own content, so nothing added in here ever
                        shifts it and the price column keeps scanning down
                        the same as before this row grew an Add/Ask pair. */}
                    <View style={styles.stateRow}>
                      <Text style={[styles.state, { color: p.stock > 0 ? '#1f7a4d' : '#8a5a05' }]}>
                        {p.stock > 0 ? 'In stock' : 'Out of stock — ask us'}
                      </Text>
                      <ProductActions
                        product={p}
                        colors={colors}
                        shopName={storefront.shopName}
                        whatsappE164={storefront.whatsappE164}
                        onAdd={addProduct}
                        compact
                      />
                    </View>
                  </View>
                  <Text style={[styles.price, { color: colors.ink }]}>{formatCents(p.priceCents)}</Text>
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>

      <CartSheet
        visible={cartOpen}
        onClose={() => setCartOpen(false)}
        cart={cart}
        colors={colors}
        onChangeQuantity={changeQuantity}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 2 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  shopName: { fontSize: 18, fontWeight: '800', letterSpacing: 0.4 },
  sub: { fontSize: 11.5 },
  headline: { fontSize: 19, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12 },
  about: { fontSize: 13, paddingHorizontal: 14, paddingTop: 5 },
  section: { paddingHorizontal: 14, paddingTop: 14 },
  sectionHead: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1 },
  rowName: { flex: 1 },
  name: { fontSize: 13.5, fontWeight: '600' },
  stateRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  state: { fontSize: 11.5, fontWeight: '600' },
  price: { fontSize: 14.5, fontWeight: '800' },
});
