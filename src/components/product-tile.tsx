import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

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
    <View style={styles.row}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]} />
      )}

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {product.brand ?? 'No brand'}{product.sku ? ` · ${product.sku}` : ''} · {product.category || 'Uncategorized'}
        </Text>
      </View>

      <Text style={styles.price}>{formatCents(product.priceCents)}</Text>

      <View style={styles.stockSection}>
        {onStockChange ? (
          <View style={styles.stepper}>
            <Pressable onPress={() => onStockChange(Math.max(0, product.stock - 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>−</Text></Pressable>
            {outOfStock ? (
              <Text style={styles.outOfStockPill}>Out of stock</Text>
            ) : lowStock ? (
              <Text style={styles.lowStockPill}>⚠ Low stock</Text>
            ) : (
              <Text style={styles.stockCount}>{product.stock}</Text>
            )}
            <Pressable onPress={() => onStockChange(product.stock + 1)} style={styles.stepperButton}><Text style={styles.stepperButtonText}>+</Text></Pressable>
          </View>
        ) : outOfStock ? (
          <Text style={styles.outOfStockPill}>Out of stock</Text>
        ) : lowStock ? (
          <Text style={styles.lowStockPill}>⚠ Low stock</Text>
        ) : (
          <Text style={styles.stockCount}>{product.stock} units</Text>
        )}
      </View>

      {onEdit && (
        <Pressable onPress={onEdit} style={styles.editButton}>
          <Text style={styles.editIcon}>✎</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#F4F4F4', gap: 10 },
  thumb: { width: 34, height: 34, borderRadius: 7 },
  thumbPlaceholder: { backgroundColor: '#F2F2F2' },
  info: { flex: 2 },
  name: { color: '#111111', fontSize: 12, fontWeight: '700' },
  meta: { color: '#999999', fontSize: 10, marginTop: 2 },
  price: { flex: 1, color: '#111111', fontSize: 12, fontWeight: '700' },
  stockSection: { flex: 1.4, alignItems: 'flex-start' },
  stockCount: { color: '#111111', fontSize: 12 },
  lowStockPill: { fontSize: 9, fontWeight: '700', color: '#B5793A', borderWidth: 1, borderColor: '#E8C99B', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  outOfStockPill: { fontSize: 9, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#111111', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { color: '#111111', fontSize: 13, fontWeight: '800' },
  editButton: { width: 24, alignItems: 'center' },
  editIcon: { color: '#BBBBBB', fontSize: 14 },
});
