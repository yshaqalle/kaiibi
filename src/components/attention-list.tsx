import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { Colors } from '@/constants/theme';
import { attentionCounts, type AttentionArea, type AttentionItem, type AttentionSeverity } from '@/lib/attention';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The Dashboard's primary surface.
//
// The screen's stated job is "what needs attention right now", but this list
// used to render as plain text under three charts — every row identical in
// weight, so a late supplier bill looked exactly like a customer who had not
// been in for a while. Severity is now carried by a colour stripe and an
// action pill, and every row says where it goes.
//
// The stripe is the ONLY thing colour is used for here. It is semantic
// (act/soon/info), which is why category hues from lib/category-colors.ts must
// never appear in this list — two colour systems in one component and neither
// reads.

const SEVERITY_COLOR: Record<AttentionSeverity, string> = {
  act: theme.danger,
  soon: theme.warning,
  info: theme.chartAccent,
};

const PILL_STYLE: Record<AttentionSeverity, { background: string; text: string }> = {
  act: { background: '#F7E1E2', text: '#B23B4E' },
  soon: { background: '#F8EEDA', text: '#9A6B0C' },
  info: { background: '#E7EEFB', text: '#1E4BCC' },
};

const AREA_LABEL: Record<AttentionArea, string> = {
  money: 'Money',
  team: 'Team',
  stock: 'Stock',
  customers: 'Customers',
  orders: 'Orders',
};

// Below this the chips are more chrome than help — a five-item list is read in
// one glance and does not need filtering.
const FILTER_THRESHOLD = 6;

export function AttentionList({
  items,
  onSelect,
}: {
  items: AttentionItem[];
  /** Where the row goes. Rows without a destination simply aren't pressable. */
  onSelect?: (item: AttentionItem) => void;
}) {
  const [filter, setFilter] = useState<AttentionArea | 'all'>('all');
  const counts = attentionCounts(items);
  const showFilters = items.length >= FILTER_THRESHOLD;
  const visible = filter === 'all' ? items : items.filter((item) => item.area === filter);

  if (items.length === 0) {
    return <Text style={styles.empty}>Nothing needs attention right now.</Text>;
  }

  return (
    <Card style={styles.card}>
      {showFilters && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
          // Without this the row stretches to the tallest thing in the parent.
          style={styles.filtersOuter}
        >
          <FilterChip label="All" count={counts.all} active={filter === 'all'} onPress={() => setFilter('all')} />
          {(Object.keys(AREA_LABEL) as AttentionArea[])
            .filter((area) => counts[area] > 0)
            .map((area) => (
              <FilterChip
                key={area}
                label={AREA_LABEL[area]}
                count={counts[area]}
                active={filter === area}
                onPress={() => setFilter(area)}
              />
            ))}
        </ScrollView>
      )}

      {visible.map((item, index) => {
        const row = (
          <>
            <View style={[styles.stripe, { backgroundColor: SEVERITY_COLOR[item.severity] }]} />
            <View style={styles.body}>
              <View style={styles.titleRow}>
                <Text style={styles.title}>{item.title}</Text>
                {item.action ? (
                  <View style={[styles.pill, { backgroundColor: PILL_STYLE[item.severity].background }]}>
                    <Text style={[styles.pillText, { color: PILL_STYLE[item.severity].text }]}>{item.action}</Text>
                  </View>
                ) : null}
              </View>
              {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}
            </View>
            {onSelect ? <Text style={styles.chevron}>→</Text> : null}
          </>
        );

        const rowStyle = [styles.row, index > 0 && styles.rowDivided];

        return onSelect ? (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item)}
            accessibilityRole="link"
            style={({ hovered, pressed }) => [...rowStyle, (hovered || pressed) && styles.rowActive]}
          >
            {row}
          </Pressable>
        ) : (
          <View key={item.key} style={rowStyle}>
            {row}
          </View>
        );
      })}
    </Card>
  );
}

function FilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label} {count}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden', marginBottom: 8 },

  filtersOuter: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.border },
  filters: { flexDirection: 'row', gap: 6, padding: 12 },
  chip: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: theme.text, borderColor: theme.text },
  chipText: { fontSize: 11.5, fontWeight: '700', color: theme.textSecondary },
  chipTextActive: { color: theme.background },

  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 13 },
  rowDivided: { borderTopWidth: 1, borderTopColor: theme.border },
  rowActive: { backgroundColor: theme.backgroundElement },
  stripe: { width: 3, borderRadius: 2, alignSelf: 'stretch' },
  body: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  title: { fontSize: 13, fontWeight: '700', color: theme.text },
  detail: { fontSize: 11.5, color: theme.textSecondary, marginTop: 3, lineHeight: 16 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3, textTransform: 'uppercase' },
  chevron: { fontSize: 13, color: theme.textSecondary, alignSelf: 'center', fontWeight: '700' },

  empty: { fontSize: 13, color: theme.textSecondary, marginBottom: 8 },
});
