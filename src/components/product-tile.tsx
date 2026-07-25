import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export function ProductTile({
  product,
  onEdit,
  onStockChange,
}: {
  product: Product;
  onEdit?: () => void;
  onStockChange?: (nextStock: number) => void;
}) {
  const lowStock = product.stock <= (product.reorderLevel ?? 5);
  const outOfStock = product.stock <= 0;

  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, { backgroundColor: theme.backgroundElement }]} />
      )}

      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{product.name}</Text>
        <Text style={[styles.meta, { color: theme.textSecondary }]} numberOfLines={1}>
          {product.brand ?? 'No brand'}{product.sku ? ` · ${product.sku}` : ''} · {product.category || 'Uncategorized'}
        </Text>
        {product.description ? (
          <Text style={[styles.description, { color: theme.textSecondary }]} numberOfLines={1}>{product.description}</Text>
        ) : null}

        <View style={styles.controlsRow}>
          <Text style={[styles.price, { color: theme.text }]}>{formatCents(product.priceCents)}</Text>

          {onStockChange ? (
            <View style={styles.stepper}>
              <Pressable onPress={() => onStockChange(Math.max(0, product.stock - 1))} style={[styles.stepperButton, { backgroundColor: theme.backgroundElement }]}><Text style={[styles.stepperButtonText, { color: theme.text }]}>−</Text></Pressable>
              {outOfStock ? (
                <Text style={[styles.outOfStockPill, { color: theme.surface, backgroundColor: theme.text }]}>Out of stock</Text>
              ) : (
                <View style={styles.stockWithBadge}>
                  <Text style={[styles.stockCount, { color: theme.text }]}>{product.stock}</Text>
                  {lowStock && <Text style={[styles.lowStockPill, { color: theme.warning, borderColor: theme.warning }]}>⚠ Low</Text>}
                </View>
              )}
              <Pressable onPress={() => onStockChange(product.stock + 1)} style={[styles.stepperButton, { backgroundColor: theme.backgroundElement }]}><Text style={[styles.stepperButtonText, { color: theme.text }]}>+</Text></Pressable>
            </View>
          ) : outOfStock ? (
            <Text style={[styles.outOfStockPill, { color: theme.surface, backgroundColor: theme.text }]}>Out of stock</Text>
          ) : (
            <View style={styles.stockWithBadge}>
              <Text style={[styles.stockCount, { color: theme.text }]}>{product.stock} units</Text>
              {lowStock && <Text style={[styles.lowStockPill, { color: theme.warning, borderColor: theme.warning }]}>⚠ Low</Text>}
            </View>
          )}

          {onEdit && (
            <Pressable onPress={onEdit} style={styles.editButton}>
              <Text style={[styles.editIcon, { color: theme.textSecondary }]}>✎</Text>
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
  name: { fontSize: 12, fontWeight: '700' },
  meta: { fontSize: 10, marginTop: 2 },
  description: { fontSize: 10, marginTop: 2 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  price: { fontSize: 12, fontWeight: '700' },
  stockCount: { fontSize: 12 },
  stockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lowStockPill: { fontSize: 9, fontWeight: '700', borderWidth: 1, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  outOfStockPill: { fontSize: 9, fontWeight: '700', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { fontSize: 13, fontWeight: '800' },
  editButton: { marginLeft: 'auto', width: 24, alignItems: 'center' },
  editIcon: { fontSize: 14 },
});
