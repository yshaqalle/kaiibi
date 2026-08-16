import { Image } from 'expo-image';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DualAmount } from '@/components/pos/dual-amount';
import { QuantityStepper } from '@/components/quantity-stepper';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import type { CartLine, Currency, Discount } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// The steps a cashier actually gives. Anything else is Custom, which opens the
// editor with its own ceiling and its own record of why.
const PRESETS = [5, 10, 15, 20];

/**
 * One line of the sale, on two rows.
 *
 * One row cannot hold a name, a stepper, a total and a remove button at the
 * width the panel has on a phone -- the name ends up three words wide. So the
 * name and its tags own the first row, and the stepper and the money own the
 * second.
 *
 * The discount chip OPENS the presets; it does not cycle them. Cycling would
 * make a price change on a single mis-tap, with no confirmation and no undo,
 * and a cashier who overshoots would have to tap through the rest of the range
 * to get back.
 */
export function SaleLine({
  line,
  grossCents,
  netCents,
  offerName,
  currency,
  canDiscount,
  editing,
  onToggleEditing,
  onQuantity,
  onRemove,
  onDiscount,
  editor,
}: {
  line: CartLine;
  grossCents: number;
  netCents: number;
  offerName: string | null;
  currency: Currency | null;
  canDiscount: boolean;
  editing: boolean;
  onToggleEditing: () => void;
  onQuantity: (next: number) => void;
  onRemove: () => void;
  onDiscount: (discount: Discount | null) => void;
  // The custom-amount editor, passed in rather than imported: it reaches for
  // the signed-in user's permissions, and this component is otherwise pure
  // presentation that a test can render on its own.
  editor?: ReactNode;
}) {
  const discounted = netCents !== grossCents;
  const { product } = line;

  return (
    <View style={styles.line}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <View style={styles.thumbDrop} />
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
          <Pressable onPress={onRemove} accessibilityLabel={`Remove ${product.name}`} style={styles.remove}>
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.meta}>
          {discounted && <Text style={styles.struck}>{formatCents(grossCents)}</Text>}
          <Text style={styles.price}>{formatCents(netCents)}</Text>
          {/* The shop's price, not the cashier's decision -- so it is a label
              rather than a control, and cannot be tapped away by accident. */}
          {offerName && (
            <View style={styles.offer}>
              <Text style={styles.offerText}>{offerName}</Text>
            </View>
          )}
          {canDiscount && (
            <Pressable onPress={onToggleEditing} style={[styles.tag, line.manualDiscount && styles.tagSet]}>
              <Text style={[styles.tagText, line.manualDiscount && styles.tagTextSet]}>
                {line.manualDiscount ? 'Discount set' : 'Discount'}
              </Text>
            </Pressable>
          )}
        </View>

        {editing && canDiscount && (
          <View style={styles.presets}>
            {PRESETS.map((percent) => (
              <Pressable
                key={percent}
                onPress={() => onDiscount({ type: 'percentage', value: percent })}
                style={styles.preset}
              >
                <Text style={styles.presetText}>{percent}%</Text>
              </Pressable>
            ))}
            {line.manualDiscount && (
              <Pressable onPress={() => onDiscount(null)} style={styles.preset}>
                <Text style={styles.presetText}>Remove</Text>
              </Pressable>
            )}
            {editor && <View style={styles.editor}>{editor}</View>}
          </View>
        )}

        <View style={styles.bottomRow}>
          <QuantityStepper quantity={line.quantity} onChange={onQuantity} />
          <DualAmount cents={netCents} currency={currency} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  thumb: { width: 38, height: 38, borderRadius: 12, backgroundColor: theme.bentoSoft },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbDrop: { width: 14, height: 14, borderRadius: 7, backgroundColor: theme.bentoLine },
  // `minWidth: 0` or a long product name widens the row instead of wrapping in
  // it -- Yoga's default is `auto`, which measures the longest word.
  body: { flex: 1, minWidth: 0, gap: 6 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  name: { flex: 1, minWidth: 0, color: theme.bentoInk, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  remove: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: theme.bentoMuted2, fontSize: 13, fontWeight: '700' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  struck: { color: theme.bentoMuted2, fontSize: 11.5, textDecorationLine: 'line-through' },
  price: { color: theme.bentoMuted, fontSize: 11.5 },
  offer: { backgroundColor: theme.bentoUpWash, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 },
  offerText: { color: theme.bentoUpInk, fontSize: 10, fontWeight: '800' },
  tag: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 },
  tagSet: { backgroundColor: theme.bentoUpWash },
  tagText: { color: theme.bentoMuted, fontSize: 10, fontWeight: '800' },
  tagTextSet: { color: theme.bentoUpInk },
  presets: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  preset: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13 },
  presetText: { color: theme.bentoInk2, fontSize: 12, fontWeight: '700' },
  editor: { width: '100%' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
});
