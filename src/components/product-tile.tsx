import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { isExpiringSoon } from '@/lib/products';
import type { Product } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
// Inventory is a bento screen, so this tile reads the bento tokens. Mapped
// under short names here rather than swapped at each of the ~20 inline style
// objects below, which keeps the render diff-free and the palette in one place.
const tile = {
  border: Colors.light.bentoRule,
  backgroundElement: Colors.light.bentoSoft,
  text: Colors.light.bentoInk,
  textSecondary: Colors.light.bentoMuted,
  surface: Colors.light.bentoSurface,
  // Warm on purpose: a low-stock or expiring flag is SUPPOSED to sit warmer
  // than the cool-grey around it, so cooling it to match would cost the
  // warning the alarm it carries.
  warning: '#8A530F',
};

export function ProductTile({
  product,
  onEdit,
  onStockChange,
  onOpenBreakdown,
  defaultLowStockLevel = 5,
  expiryWarningLeadDays,
}: {
  product: Product;
  onEdit?: () => void;
  onStockChange?: (nextStock: number) => void;
  // Combined multi-store view: the total opens a per-store breakdown instead of
  // a stepper that would silently change one store. Same reasoning as the table.
  onOpenBreakdown?: () => void;
  // Settings → Inventory alerts' "Default low stock level" — falls back to
  // 5 (the old hardcoded value) if the caller doesn't pass the shop's.
  defaultLowStockLevel?: number;
  // Settings → Inventory alerts' "Expiry warning lead time". Omitted (or the
  // shop has expiry tracking off) means no expiry badge is shown at all,
  // regardless of whether this product has an expiry date.
  expiryWarningLeadDays?: number;
}) {
  const lowStock = product.stock <= (product.reorderLevel ?? defaultLowStockLevel);
  const outOfStock = product.stock <= 0;
  const expiringSoon = expiryWarningLeadDays != null && product.expiryDate != null && isExpiringSoon(product.expiryDate, expiryWarningLeadDays);

  return (
    <View style={[styles.row, { borderBottomColor: tile.border }]}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, { backgroundColor: tile.backgroundElement }]} />
      )}

      <View style={styles.info}>
        {/* The listing, on the row rather than only behind the filter chip.
            The chips answer "which ones"; this answers "this one" while a
            shopkeeper reads the unfiltered list -- otherwise the only way to
            know is to open the product. A quiet outline, not the warm warning
            treatment below it: being on the page is a state, not a problem. */}
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: tile.text }]} numberOfLines={1}>{product.name}</Text>
          {product.isListedOnline && (
            <Text style={[styles.onlinePill, { color: tile.textSecondary, borderColor: tile.border }]}>Online</Text>
          )}
        </View>
        <Text style={[styles.meta, { color: tile.textSecondary }]} numberOfLines={1}>
          {product.brand ?? 'No brand'}{product.sku ? ` · ${product.sku}` : ''} · {product.category || 'Uncategorized'}
        </Text>
        {product.description ? (
          <Text style={[styles.description, { color: tile.textSecondary }]} numberOfLines={1}>{product.description}</Text>
        ) : null}

        <View style={styles.controlsRow}>
          <Text style={[styles.price, { color: tile.text }]}>{formatCents(product.priceCents)}</Text>

          {onOpenBreakdown ? (
            <Pressable onPress={onOpenBreakdown} style={[styles.breakdownButton, { backgroundColor: tile.backgroundElement }]}>
              <Text style={[styles.stockCount, { color: tile.text }]}>{product.stock}</Text>
              <Text style={styles.breakdownHint}>by store ▸</Text>
            </Pressable>
          ) : onStockChange ? (
            <View style={styles.stepper}>
              <Pressable onPress={() => onStockChange(Math.max(0, product.stock - 1))} style={[styles.stepperButton, { backgroundColor: tile.backgroundElement }]}><Text style={[styles.stepperButtonText, { color: tile.text }]}>−</Text></Pressable>
              {outOfStock ? (
                <Text style={[styles.outOfStockPill, { color: tile.surface, backgroundColor: tile.text }]}>Out of stock</Text>
              ) : (
                <View style={styles.stockWithBadge}>
                  <Text style={[styles.stockCount, { color: tile.text }]}>{product.stock}</Text>
                  {lowStock && <Text style={[styles.lowStockPill, { color: tile.warning, borderColor: tile.warning }]}>⚠ Low</Text>}
                  {expiringSoon && <Text style={[styles.lowStockPill, { color: tile.warning, borderColor: tile.warning }]}>⏳ Expiring</Text>}
                </View>
              )}
              <Pressable onPress={() => onStockChange(product.stock + 1)} style={[styles.stepperButton, { backgroundColor: tile.backgroundElement }]}><Text style={[styles.stepperButtonText, { color: tile.text }]}>+</Text></Pressable>
            </View>
          ) : outOfStock ? (
            <Text style={[styles.outOfStockPill, { color: tile.surface, backgroundColor: tile.text }]}>Out of stock</Text>
          ) : (
            <View style={styles.stockWithBadge}>
              <Text style={[styles.stockCount, { color: tile.text }]}>{product.stock} units</Text>
              {lowStock && <Text style={[styles.lowStockPill, { color: tile.warning, borderColor: tile.warning }]}>⚠ Low</Text>}
              {expiringSoon && <Text style={[styles.lowStockPill, { color: tile.warning, borderColor: tile.warning }]}>⏳ Expiring</Text>}
            </View>
          )}

          {onEdit && (
            <Pressable onPress={onEdit} style={styles.editButton}>
              <Text style={[styles.editIcon, { color: tile.text }]}>✎</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, borderBottomWidth: 1, gap: 10 },
  thumb: { width: 34, height: 34, borderRadius: 7 },
  info: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, fontSize: 12, fontWeight: '700' },
  onlinePill: { flexShrink: 0, fontSize: 9, fontWeight: '700', borderWidth: 1, paddingVertical: 2, paddingHorizontal: 7, borderRadius: 10 },
  meta: { fontSize: 10, marginTop: 2 },
  description: { fontSize: 10, marginTop: 2 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  price: { fontSize: 12, fontWeight: '700' },
  stockCount: { fontSize: 12 },
  stockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lowStockPill: { fontSize: 9, fontWeight: '700', borderWidth: 1, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  outOfStockPill: { fontSize: 9, fontWeight: '700', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  breakdownButton: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, alignSelf: 'flex-start' },
  breakdownHint: { fontSize: 11, fontWeight: '700', color: tile.textSecondary },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { fontSize: 13, fontWeight: '800' },
  editButton: { marginLeft: 'auto', width: 24, alignItems: 'center' },
  editIcon: { fontSize: 18 },
});
