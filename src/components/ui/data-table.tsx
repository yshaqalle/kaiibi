import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Rows you COMPARE, as opposed to rows you read.
//
// Five low-stock products judged on "units left vs. reorder level vs. how fast
// it sells" is a comparison: the eye needs to run down a column. Rendering
// them as five separate tiles forces each to be read on its own, which is why
// the dashboard's stock lists were hard to act on.
//
// Money columns are right-aligned and tabular so digits stack. Headers are
// small and quiet — they are scaffolding, and should never compete with the
// data. A name cell takes two lines: the thing on top, its qualifier
// (`category · store`) beneath in grey.
//
// Horizontal scrolling is INSIDE the card, never on the page: a table that
// makes the whole screen slide sideways loses the nav along with it.

export type Column<T> = {
  key: string;
  header: string;
  /** Right-align. Use for every money and count column. */
  numeric?: boolean;
  /** Fixed width; otherwise the column takes an even share of the rest. */
  width?: number;
  render: (row: T) => ReactNode;
};

export function DataTable<T>({
  columns,
  rows,
  keyExtractor,
  onRowPress,
  emptyLabel,
  minWidth = 560,
}: {
  columns: Column<T>[];
  rows: T[];
  keyExtractor: (row: T) => string;
  onRowPress?: (row: T) => void;
  emptyLabel: string;
  /** Below this the table scrolls sideways rather than crushing its columns. */
  minWidth?: number;
}) {
  if (rows.length === 0) {
    return <Text style={styles.empty}>{emptyLabel}</Text>;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
      <View style={{ minWidth }}>
        <View style={styles.headerRow}>
          {columns.map((column) => (
            <View key={column.key} style={[styles.cell, cellWidth(column)]}>
              <Text style={[styles.headerText, column.numeric && styles.alignRight]} numberOfLines={1}>
                {column.header.toUpperCase()}
              </Text>
            </View>
          ))}
        </View>

        {rows.map((row) => {
          const content = columns.map((column) => (
            <View key={column.key} style={[styles.cell, cellWidth(column), column.numeric && styles.cellRight]}>
              {column.render(row)}
            </View>
          ));

          return onRowPress ? (
            <Pressable
              key={keyExtractor(row)}
              onPress={() => onRowPress(row)}
              style={({ hovered, pressed }) => [styles.row, (hovered || pressed) && styles.rowActive]}
            >
              {content}
            </Pressable>
          ) : (
            <View key={keyExtractor(row)} style={styles.row}>
              {content}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function cellWidth<T>(column: Column<T>) {
  return column.width ? { width: column.width, flexGrow: 0, flexShrink: 0 } : { flex: 1 };
}

/** The two-line name cell: the thing, then what qualifies it. */
export function NameCell({ title, meta }: { title: string; meta?: string }) {
  return (
    <View style={styles.nameCell}>
      <Text style={styles.nameTitle} numberOfLines={1}>
        {title}
      </Text>
      {/* Ternary, not `meta && …` — an empty string is a bare text node inside
          a View, which is a hard error on RN Web. */}
      {meta ? (
        <Text style={styles.nameMeta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

/** A figure. `tone` is for the value itself, not the row. */
export function ValueCell({
  value,
  tone = 'default',
  strong,
}: {
  value: string;
  tone?: 'default' | 'muted' | 'warning' | 'danger' | 'success';
  strong?: boolean;
}) {
  return (
    <Text style={[styles.value, TONE[tone], strong && styles.valueStrong]} numberOfLines={1}>
      {value}
    </Text>
  );
}

const TONE = StyleSheet.create({
  default: { color: theme.bentoInk },
  muted: { color: theme.bentoMuted },
  warning: { color: theme.bentoWarn },
  danger: { color: theme.bentoLoss },
  success: { color: theme.bentoProfit },
});

// Bento tokens throughout. This table only ever renders inside a bento card --
// the Dashboard's and now the Platform console's -- and it was still drawing
// its rules in the cream `border` (#EFEEE9), which is a warm hairline on a cool
// grey page. `bentoRule` is the divider weight, deliberately firmer than
// `bentoLine`; see the note on the token.
const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1 },
  headerRow: { flexDirection: 'row', paddingBottom: 9 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: 1, borderTopColor: theme.bentoRule },
  rowActive: { backgroundColor: theme.bentoSoft },
  cell: { paddingHorizontal: 8, minWidth: 0 },
  cellRight: { alignItems: 'flex-end' },

  headerText: {
    fontSize: 9.5,
    letterSpacing: 1.1,
    color: theme.bentoMuted,
    fontWeight: '700',
  },
  alignRight: { textAlign: 'right' },

  nameCell: { minWidth: 0 },
  nameTitle: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  nameMeta: { fontSize: 11, color: theme.bentoMuted, marginTop: 2 },

  value: { fontSize: 12.5, fontVariant: ['tabular-nums'], color: theme.bentoInk },
  valueStrong: { fontWeight: '800' },

  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 10 },
});
