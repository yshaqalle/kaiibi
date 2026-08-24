import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

export type LedgerView = 'hub' | 'accounts' | 'entry' | 'journals' | 'trial' | 'audit';

// The catalogue, in one place, because four things read it: the hub's cards,
// the shell's title row, the shell's "is this a view I know" guard, and the nav
// test. Four copies of a list of six is how a seventh gets added to two.
//
// `group` is what the hub renders as a heading. A view with no group would
// appear nowhere and be reachable only by typing the URL.
//
// `scope` and `action` are the card's footer row. The scope is the part that
// carries meaning rather than polish: Trial Balance is "as of today" and
// Journals is "7 days", and a reader who does not know which is which will
// misread one of them. A card whose action CREATES something gets the filled
// button and a plus; a card you only read gets the quiet one.
export const LEDGER_VIEWS: {
  key: LedgerView;
  label: string;
  blurb: string;
  group: string | null;
  icon: keyof typeof Ionicons.glyphMap;
  scope: string;
  action: string;
  creates: boolean;
}[] = [
  {
    key: 'hub',
    label: 'Accounting',
    blurb: 'The books themselves — accounts, entries and the trail behind them.',
    group: null,
    icon: 'book-outline',
    scope: '',
    action: '',
    creates: false,
  },
  {
    key: 'accounts',
    label: 'Chart of Accounts',
    blurb: 'Assets, liabilities, equity, revenue and expense accounts.',
    group: 'Ledger and journals',
    icon: 'list-outline',
    scope: 'As of today',
    action: 'View accounts',
    creates: false,
  },
  {
    key: 'entry',
    label: 'General Journal Entry',
    blurb: 'Post a manual debit/credit entry to the ledger.',
    group: 'Ledger and journals',
    icon: 'create-outline',
    scope: 'Manual entry',
    action: '+ New entry',
    creates: true,
  },
  {
    key: 'journals',
    label: 'Journals',
    blurb: 'Every journal entry recorded, in order.',
    group: 'Ledger and journals',
    icon: 'reader-outline',
    scope: '7 days',
    action: 'View list',
    creates: false,
  },
  {
    key: 'trial',
    label: 'Trial Balance',
    blurb: "Every account's debit and credit balance, side by side.",
    group: 'Ledger and journals',
    icon: 'swap-horizontal-outline',
    scope: 'As of today',
    action: 'Run report',
    creates: false,
  },
  {
    key: 'audit',
    label: 'Audit Log',
    blurb: 'Who changed what, and when.',
    group: 'Oversight',
    icon: 'time-outline',
    scope: 'All time',
    action: 'View log',
    creates: false,
  },
];

export function LedgerHub({
  onOpen,
  accountCount,
}: {
  onOpen: (view: LedgerView) => void;
  /** Null while the shell is still fetching. */
  accountCount: number | null;
}) {
  const groups = LEDGER_VIEWS.filter((v) => v.group).reduce<Record<string, typeof LEDGER_VIEWS>>((acc, view) => {
    const key = view.group as string;
    acc[key] = [...(acc[key] ?? []), view];
    return acc;
  }, {});

  return (
    <View style={styles.wrap}>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>{group}</Text>
          {/* BentoGrid, not a flex-wrap row. A wrapping row gives every card
              flexGrow, so a group holding ONE card stretched it across the
              whole band -- Audit Log rendered 1344px wide beside four 327px
              siblings. A cell takes its span and no more, however few there
              are in the row. */}
          <BentoGrid>
            {views.map((view) => (
              <BentoCell key={view.key} span={3}>
              <Pressable style={styles.cell} onPress={() => onOpen(view.key)} role="button">
                <Card variant="bento" style={styles.card}>
                  <View style={styles.iconTile}>
                    <Ionicons name={view.icon} size={15} color={theme.bentoInk2} />
                  </View>
                  <Text style={styles.title}>{view.label}</Text>
                  <Text style={styles.blurb}>{view.blurb}</Text>
                  <View style={styles.footer}>
                    {/* The live count where there is one, so the card says what
                        is behind it rather than only what it is. Falls back to
                        the static scope while the count is still null, rather
                        than flashing "0 accounts" at a shop that has 31. */}
                    <Text style={styles.scope} numberOfLines={1}>
                      {view.key === 'accounts' && accountCount !== null ? `${accountCount} accounts` : view.scope}
                    </Text>
                    <View style={[styles.action, view.creates && styles.actionSolid]}>
                      <Text style={[styles.actionText, view.creates && styles.actionTextSolid]}>{view.action}</Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
              </BentoCell>
            ))}
          </BentoGrid>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 18 },
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10 },
  // The cell owns the width now -- span={3} is a quarter of the band, widened
  // to a third, a half and then the full row as the screen narrows, which is
  // BentoCell's own rule. The Pressable just fills whatever it is given.
  cell: { width: '100%' },
  // The Pressable owns the width, the Card owns the surface. Full height so
  // cards in a row line up when one blurb wraps to three lines and another
  // takes two.
  card: { height: '100%' },
  iconTile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  title: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  blurb: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4, lineHeight: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 14 },
  scope: { fontSize: 11, color: theme.bentoMuted2, flexShrink: 1 },
  action: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.bentoSoft },
  actionSolid: { backgroundColor: theme.bentoInk },
  actionText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk2 },
  actionTextSolid: { color: theme.bentoSurface },
});
