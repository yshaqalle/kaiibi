import { StyleSheet, Text, View } from 'react-native';

import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';
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
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={[styles.nav, { borderBottomColor: colors.ink }]}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={styles.sub}>{storefront.city}</Text> : null}
        </View>
        <WhatsAppButton storefront={storefront} />
      </View>

      {storefront.headline ? (
        <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}

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
                  <Text style={[styles.state, { color: p.stock > 0 ? '#1f7a4d' : '#8a5a05' }]}>
                    {p.stock > 0 ? 'In stock' : 'Out of stock — ask us'}
                  </Text>
                </View>
                <Text style={[styles.price, { color: colors.ink }]}>{formatCents(p.priceCents)}</Text>
              </View>
            ))}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 2 },
  shopName: { fontSize: 18, fontWeight: '800', letterSpacing: 0.4 },
  sub: { fontSize: 11.5, color: '#6b675c' },
  headline: { fontSize: 19, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12 },
  section: { paddingHorizontal: 14, paddingTop: 14 },
  sectionHead: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1 },
  rowName: { flex: 1 },
  name: { fontSize: 13.5, fontWeight: '600' },
  state: { fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  price: { fontSize: 14.5, fontWeight: '800' },
});
