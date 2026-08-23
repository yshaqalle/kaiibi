import { Pressable, StyleSheet, Text } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

// The one row every non-hub ledger view shows above the title.
//
// A back affordance rather than a second pill row: seven pills across the top
// and six more beneath them is two navigations competing for the same glance,
// and on a phone the second row would push the first thing worth reading off
// the screen.
export function LedgerCrumb({ onBack }: { onBack: () => void }) {
  return (
    <Pressable onPress={onBack} style={styles.row} role="link" accessibilityLabel="Back to Accounting">
      <Text style={styles.text}>← Accounting</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'flex-start', paddingVertical: 4, marginBottom: 6 },
  text: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
});
