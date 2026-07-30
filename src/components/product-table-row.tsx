import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

export type SortField = 'name' | 'brand' | 'category' | 'price' | 'stock';
export type SortDirection = 'asc' | 'desc';

// Column widths as plain inline objects (not StyleSheet.create entries):
// each is reused across both Text and View cells, and RN's StyleSheet.create
// typing can't cleanly infer a shape valid for both (TextStyle/ViewStyle
// disagree on `userSelect`) — inline objects sidestep that ambiguity since
// they're contextually typed at each call site instead.
const colProduct = { flexBasis: '24%', flexGrow: 0, flexShrink: 0 } as const;
const colBrand = { flexBasis: '13%', flexGrow: 0, flexShrink: 0 } as const;
const colCategory = { flexBasis: '13%', flexGrow: 0, flexShrink: 0 } as const;
const colTags = { flexBasis: '18%', flexGrow: 0, flexShrink: 0 } as const;
const colPrice = { flexBasis: '10%', flexGrow: 0, flexShrink: 0 } as const;
const colStock = { flexBasis: '22%', flexGrow: 0, flexShrink: 0 } as const;

// The desktop Inventory list — a real, sortable column table (PRODUCT /
// BRAND / CATEGORY / TAGS / PRICE / STOCK). Narrow screens use
// `ProductTile` instead (see inventory.tsx), which stacks the same info
// into two lines rather than fighting for space across six columns.
export function ProductTableHeader({
  sortField,
  sortDirection,
  onSort,
}: {
  sortField: SortField | null;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const HeaderCell = ({ field, label, style }: { field: SortField; label: string; style: object }) => (
    <Pressable onPress={() => onSort(field)} style={[styles.headerCell, style]}>
      <Text style={styles.headerLabel}>{label}</Text>
      {sortField === field && <Text style={styles.sortArrow}>{sortDirection === 'asc' ? '▲' : '▼'}</Text>}
    </Pressable>
  );

  return (
    <View style={styles.headerRow}>
      <View style={styles.dataCols}>
        <HeaderCell field="name" label="PRODUCT" style={colProduct} />
        <HeaderCell field="brand" label="BRAND" style={colBrand} />
        <HeaderCell field="category" label="CATEGORY" style={colCategory} />
        <Text style={[styles.headerLabel, colTags]}>TAGS</Text>
        <HeaderCell field="price" label="PRICE" style={colPrice} />
        <HeaderCell field="stock" label="STOCK" style={colStock} />
      </View>
      <View style={styles.colEdit} />
    </View>
  );
}

export function ProductTableRow({
  product,
  onEdit,
  onStockChange,
}: {
  product: Product;
  // Both omitted for a read-only viewer (a role with `inventory.view` but not
  // `inventory.edit`) — same contract as ProductTile.
  onEdit?: () => void;
  onStockChange?: (nextStock: number) => void;
}) {
  const lowStock = product.stock <= (product.reorderLevel ?? 5);
  const outOfStock = product.stock <= 0;
  const visibleTags = product.tags.slice(0, 2);
  const hiddenTagCount = product.tags.length - visibleTags.length;

  return (
    <View style={styles.row}>
      <View style={styles.dataCols}>
        <View style={[styles.cell, colProduct]}>
          {product.imageUrl ? (
            <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.thumbPlaceholder]} />
          )}
          <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        </View>

        <Text style={[styles.cellText, styles.muted, colBrand]} numberOfLines={1}>{product.brand || '—'}</Text>
        <Text style={[styles.cellText, colCategory]} numberOfLines={1}>{product.category || '—'}</Text>

        <View style={[styles.cell, colTags]}>
          {product.tags.length === 0 ? (
            <Text style={[styles.cellText, styles.muted]}>—</Text>
          ) : (
            <>
              {visibleTags.map((tag) => (
                <View key={tag} style={styles.tagChip}>
                  <Text style={styles.tagChipText} numberOfLines={1}>{tag}</Text>
                </View>
              ))}
              {hiddenTagCount > 0 && <Text style={[styles.cellText, styles.muted]}>{`+${hiddenTagCount}`}</Text>}
            </>
          )}
        </View>

        <Text style={[styles.cellText, styles.price, colPrice]}>{formatCents(product.priceCents)}</Text>

        <View style={[styles.cell, colStock]}>
          {onStockChange && (
            <Pressable onPress={() => onStockChange(Math.max(0, product.stock - 1))} style={styles.stepperButton}>
              <Text style={styles.stepperButtonText}>−</Text>
            </Pressable>
          )}
          {outOfStock ? (
            <Text style={styles.stockPill}>⚠ Out of stock</Text>
          ) : (
            <View style={styles.stockWithBadge}>
              <Text style={styles.stockCount}>{product.stock}</Text>
              {lowStock && <Text style={styles.stockPill}>⚠ Low stock</Text>}
            </View>
          )}
          {onStockChange && (
            <Pressable onPress={() => onStockChange(product.stock + 1)} style={styles.stepperButton}>
              <Text style={styles.stepperButtonText}>+</Text>
            </Pressable>
          )}
        </View>
      </View>

      {onEdit ? (
        <Pressable onPress={onEdit} style={styles.colEdit}>
          <Text style={styles.editIcon}>✎</Text>
        </Pressable>
      ) : (
        <View style={styles.colEdit} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  headerCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerLabel: { fontSize: 10, fontWeight: '900', color: '#555555', letterSpacing: 0.6 },
  sortArrow: { fontSize: 8, color: '#555555' },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  // The six data columns' percentage widths are relative to this flex:1
  // wrapper's own resolved width, not the whole row — so the fixed-width
  // edit button (a sibling, not one of the percentage columns) gets its
  // 28px + gap first and the percentages divide up whatever's left. When
  // this used to be one flat row, the columns' percentages already summed
  // to 100% of the FULL row width, leaving no room for the edit button —
  // it rendered past the row's clipped edge and was invisible.
  dataCols: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  cell: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  cellText: { fontSize: 13, color: '#111111' },
  muted: { color: '#999999' },
  price: { fontWeight: '800' },

  colEdit: { width: 28, alignItems: 'flex-end' },

  thumb: { width: 40, height: 40, borderRadius: 9, marginRight: 12 },
  thumbPlaceholder: { backgroundColor: '#F2F2F2' },
  name: { flexShrink: 1, fontSize: 14, fontWeight: '700', color: '#111111' },

  tagChip: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingVertical: 3, paddingHorizontal: 8, maxWidth: '100%' },
  tagChipText: { fontSize: 11, fontWeight: '600', color: '#555555' },

  stepperButton: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { color: '#111111', fontSize: 14, fontWeight: '800' },
  stockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 10 },
  stockCount: { fontSize: 13, color: '#111111' },
  stockPill: { fontSize: 11, fontWeight: '700', color: '#555555', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D8D8D8', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12 },

  editIcon: { color: '#111111', fontSize: 20 },
});
