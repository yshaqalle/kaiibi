import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useSupportUnread } from '@/lib/support-unread';

// One component for a row that exists in three shells -- admin-sidebar.tsx
// (wide), admin-tabs.web.tsx (mobile web) and admin-tabs.tsx (native phone).
// Pasting it three times is how the three menus drift.
//
// Deliberately NOT gated. The Settings row beside it is wrapped in
// canEditShop; this one must never be, because a cashier who cannot ring up a
// sale is the person most likely to need it -- and today their whole menu is
// one item: Sign out.
//
// `tone` mirrors LocationSwitcher's own prop (see location-switcher.tsx):
// this component is dropped into a menu sheet it does not own, and that
// sheet's palette is the host's call, not this component's. admin-tabs.tsx
// paints its sheet with Colors.dark and overrides every other row's text to
// `colors.text` for that reason; without the same override here this row
// rendered `bentoInk` (near-black) on that dark sheet -- text at ~1:1
// contrast on the shell where this row is often a cashier's entire menu.
// Defaulting to 'light' keeps the two light shells (admin-sidebar.tsx,
// admin-tabs.web.tsx) unchanged.
export function SupportMenuItem({ onPress, tone = 'light' }: { onPress: () => void; tone?: 'light' | 'dark' }) {
  const { count } = useSupportUnread();
  const theme = tone === 'dark' ? Colors.dark : Colors.light;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
      accessibilityLabel={count > 0 ? `Help and support, ${count} unread message${count === 1 ? '' : 's'}` : 'Help and support'}
    >
      <Text style={[styles.icon, { color: theme.bentoInk }]}>✉</Text>
      <Text style={[styles.label, { color: theme.bentoInk }]}>Help &amp; support</Text>
      {count > 0 && (
        <View style={[styles.badge, { backgroundColor: theme.bentoAccentWash }]}>
          <Text style={[styles.badgeText, { color: theme.bentoAccentInk }]}>{count > 9 ? '9+' : String(count)}</Text>
        </View>
      )}
    </Pressable>
  );
}

// Colors live inline against `theme` at render time (see the component
// above), not here -- `tone` picks between Colors.light and Colors.dark, and
// a static StyleSheet can't hold two palettes at once.
const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  icon: { fontSize: 15 },
  label: { fontSize: 14, fontWeight: '700', flex: 1 },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '800' },
});
