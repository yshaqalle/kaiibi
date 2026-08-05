import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

// The product a scan just landed on, pinned above the list.
//
// The list itself already filters down to the match, so this exists for what
// the list can't do: name the thing that was scanned (so a `+1` is obviously
// about THAT item, not whichever row sorted to the top) and put the two actions
// a stock count actually needs right next to it. Scanning a shelf of items to
// correct counts otherwise means opening a modal per item.
export function ScanResultBar({
  product,
  locationLabel,
  onAdjust,
  onEdit,
  onDismiss,
}: {
  product: Product;
  // Which store the count refers to. Omitted for single-store shops, where
  // saying it would be noise; shown otherwise, because "+1" without a store is
  // an ambiguous instruction in a multi-store business.
  locationLabel?: string;
  // Absent without `inventory.edit` -- the bar still reports, it just can't act.
  onAdjust?: (delta: number) => void;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.bar}>
      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {product.stock} in stock{locationLabel ? ` · ${locationLabel}` : ''} · {formatCents(product.priceCents)}
          {product.barcode ? ` · ${product.barcode}` : ''}
        </Text>
      </View>
      {onAdjust && (
        <View style={styles.actions}>
          <Pressable
            onPress={() => onAdjust(-1)}
            // Stock is constrained to be non-negative, so at zero there is
            // nothing to take away.
            disabled={product.stock <= 0}
            style={[styles.step, product.stock <= 0 && styles.stepDisabled]}
          >
            <Text style={[styles.stepText, product.stock <= 0 && styles.stepTextDisabled]}>−1</Text>
          </Pressable>
          <Pressable onPress={() => onAdjust(1)} style={styles.step}>
            <Text style={styles.stepText}>+1</Text>
          </Pressable>
        </View>
      )}
      {onEdit && (
        <Pressable onPress={onEdit} style={styles.edit}>
          <Text style={styles.editText}>Edit</Text>
        </Pressable>
      )}
      <Pressable onPress={onDismiss} style={styles.dismiss} accessibilityLabel="Dismiss scan result">
        <Text style={styles.dismissText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    backgroundColor: '#F2F2F2', borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10, marginBottom: 14,
  },
  details: { flex: 1, minWidth: 160 },
  name: { color: '#111111', fontSize: 13, fontWeight: '800' },
  meta: { color: '#777777', fontSize: 11, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 6 },
  step: { backgroundColor: '#FFFFFF', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, minWidth: 40, alignItems: 'center' },
  stepDisabled: { backgroundColor: '#E8E8E8' },
  stepText: { color: '#111111', fontSize: 13, fontWeight: '800' },
  stepTextDisabled: { color: '#AAAAAA' },
  edit: { backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  editText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  dismiss: { paddingHorizontal: 6, paddingVertical: 4 },
  dismissText: { color: '#999999', fontSize: 13, fontWeight: '800' },
});
