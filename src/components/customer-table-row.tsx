import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Customer } from '@/types/models';

export type SortField = 'name' | 'phone' | 'email';
export type SortDirection = 'asc' | 'desc';

// Column widths as plain inline objects (not StyleSheet.create entries) --
// same reasoning as product-table-row.tsx: reused across Text/View cells,
// and RN's StyleSheet typing can't cleanly infer a shape valid for both.
const colName = { flexBasis: '28%', flexGrow: 0, flexShrink: 0 } as const;
const colPhone = { flexBasis: '18%', flexGrow: 0, flexShrink: 0 } as const;
const colEmail = { flexBasis: '24%', flexGrow: 0, flexShrink: 0 } as const;
const colTags = { flexBasis: '30%', flexGrow: 0, flexShrink: 0 } as const;

// The desktop Customers list -- a real, sortable column table (NAME / PHONE
// / EMAIL / TAGS), mirroring ProductTableHeader/ProductTableRow's pattern
// from Inventory so the two admin list screens read as one system.
// Module scope, not inside the header below. Defined inline, this was a NEW
// component type on every render, so React threw the header away and rebuilt
// it rather than updating it -- on every keystroke in the search box and every
// sort. The cells hold no state, so nothing broke; it was pure churn in one of
// the two screens that render the most rows. (react-hooks/static-components.)
//
// It takes `active` rather than `field` + `sortField` because, hoisted, it can
// no longer close over the parent's sort state -- and the answer reads better
// at the call site than the inputs do.
function HeaderCell({
  label,
  style,
  active,
  direction,
  onPress,
}: {
  label: string;
  style: object;
  active: boolean;
  direction: SortDirection;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.headerCell, style]}>
      <Text style={styles.headerLabel}>{label}</Text>
      {active && <Text style={styles.sortArrow}>{direction === 'asc' ? '▲' : '▼'}</Text>}
    </Pressable>
  );
}

export function CustomerTableHeader({
  sortField,
  sortDirection,
  onSort,
}: {
  sortField: SortField | null;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const cell = (field: SortField, label: string, style: object) => (
    <HeaderCell
      label={label}
      style={style}
      active={sortField === field}
      direction={sortDirection}
      onPress={() => onSort(field)}
    />
  );

  return (
    <View style={styles.headerRow}>
      <View style={styles.dataCols}>
        {cell('name', 'NAME', colName)}
        {cell('phone', 'PHONE', colPhone)}
        {cell('email', 'EMAIL', colEmail)}
        <Text style={[styles.headerLabel, colTags]}>TAGS</Text>
      </View>
      <View style={styles.colEdit} />
    </View>
  );
}

export function CustomerTableRow({
  customer,
  onEdit,
}: {
  customer: Customer;
  // Omitted for a read-only viewer (`customers.view` without
  // `customers.edit`), which also drops the row's edit pencil.
  onEdit?: () => void;
}) {
  const visibleTags = customer.tags.slice(0, 3);
  const hiddenTagCount = customer.tags.length - visibleTags.length;

  return (
    <Pressable onPress={onEdit} disabled={!onEdit} style={styles.row}>
      <View style={styles.dataCols}>
        <Text style={[styles.cellText, styles.name, colName]} numberOfLines={1}>
          {customer.firstName} {customer.lastName ?? ''}
        </Text>
        <Text style={[styles.cellText, styles.muted, colPhone]} numberOfLines={1}>{customer.phone || '—'}</Text>
        <Text style={[styles.cellText, styles.muted, colEmail]} numberOfLines={1}>{customer.email || '—'}</Text>

        <View style={[styles.cell, colTags]}>
          {customer.tags.length === 0 ? (
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
      </View>

      <View style={styles.colEdit}>
        {onEdit && <Text style={styles.editIcon}>✎</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  headerCell: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerLabel: { fontSize: 10, fontWeight: '900', color: '#555555', letterSpacing: 0.6 },
  sortArrow: { fontSize: 8, color: '#555555' },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  dataCols: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  cell: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  cellText: { fontSize: 13, color: '#111111' },
  muted: { color: '#999999' },
  name: { fontWeight: '700' },

  colEdit: { width: 28, alignItems: 'flex-end' },

  tagChip: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingVertical: 3, paddingHorizontal: 8, maxWidth: '100%' },
  tagChipText: { fontSize: 11, fontWeight: '600', color: '#555555' },

  editIcon: { color: '#111111', fontSize: 20 },
});
