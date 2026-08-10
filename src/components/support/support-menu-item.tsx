import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { listMyThreads, unreadCount } from '@/lib/support';

const theme = Colors.light;

// One component for a row that exists in three shells -- admin-sidebar.tsx
// (wide), admin-tabs.web.tsx (mobile web) and admin-tabs.tsx (native phone).
// Pasting it three times is how the three menus drift.
//
// Deliberately NOT gated. The Settings row beside it is wrapped in
// canEditShop; this one must never be, because a cashier who cannot ring up a
// sale is the person most likely to need it -- and today their whole menu is
// one item: Sign out.
export function SupportMenuItem({ onPress }: { onPress: () => void }) {
  const { count } = useSupportUnread();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={styles.icon}>✉</Text>
      <Text style={styles.label}>Help &amp; support</Text>
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count > 9 ? '9+' : String(count)}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function useSupportUnread() {
  const { session } = useAuth();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!session) {
      setCount(0);
      return;
    }
    try {
      setCount(unreadCount(await listMyThreads()));
    } catch {
      // A failed count must never break the menu it lives in. No badge is a
      // better outcome than no menu.
      setCount(0);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { count, refresh };
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  icon: { fontSize: 15, color: theme.bentoInk },
  label: { fontSize: 14, fontWeight: '700', color: theme.bentoInk, flex: 1 },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.bentoAccentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '800', color: theme.bentoAccentInk },
});
