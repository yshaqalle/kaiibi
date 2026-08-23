import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

export type LedgerView = 'hub' | 'accounts' | 'entry' | 'journals' | 'trial' | 'audit';

// The catalogue, in one place, because three things read it: the hub's cards,
// the shell's title row, and the shell's "is this a view I know" guard. Three
// copies of a list of six is how a seventh gets added to two of them.
//
// `group` is what the hub renders as a heading. A view with no group would
// appear nowhere and be reachable only by typing the URL.
export const LEDGER_VIEWS: { key: LedgerView; label: string; blurb: string; group: string | null }[] = [
  { key: 'hub', label: 'Accounting', blurb: 'The books themselves — accounts, entries and the trail behind them.', group: null },
  { key: 'accounts', label: 'Chart of Accounts', blurb: 'Every account the books can post to, and what is in each right now.', group: 'Ledger and journals' },
  { key: 'entry', label: 'General Journal Entry', blurb: "Record something the app can't post for you. It has to balance before it saves.", group: 'Ledger and journals' },
  { key: 'journals', label: 'Journals', blurb: 'Every entry that reached the books, newest first.', group: 'Ledger and journals' },
  { key: 'trial', label: 'Trial Balance', blurb: 'Proof the books balance, account by account.', group: 'Ledger and journals' },
  { key: 'audit', label: 'Audit Log', blurb: 'Who changed what, when — and what it looked like before.', group: 'Oversight' },
];

export function LedgerHub({ onOpen }: { onOpen: (view: LedgerView) => void }) {
  const groups = LEDGER_VIEWS.filter((v) => v.group).reduce<Record<string, typeof LEDGER_VIEWS>>((acc, view) => {
    const key = view.group as string;
    acc[key] = [...(acc[key] ?? []), view];
    return acc;
  }, {});

  return (
    <BentoCard>
      {Object.entries(groups).map(([group, views]) => (
        <View key={group}>
          <Text style={styles.group}>{group}</Text>
          <View style={styles.tiles}>
            {views.map((view) => (
              <Pressable key={view.key} style={styles.tile} onPress={() => onOpen(view.key)} role="button">
                <Text style={styles.tileTitle}>{view.label}</Text>
                <Text style={styles.tileBlurb}>{view.blurb}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  group: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 10, marginTop: 4 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
  // 260 rather than a fraction: the cards wrap to one column on a phone and to
  // as many as fit on a tablet, without the screen having to know which it is.
  tile: { flexGrow: 1, flexBasis: 260, backgroundColor: theme.bentoSoft, borderRadius: 18, padding: 14 },
  tileTitle: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  tileBlurb: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 4, lineHeight: 16 },
});
