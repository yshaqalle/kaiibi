import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

export default function OwnerTabs() {
  return (
    <Tabs style={styles.tabs}>
      <TabList asChild>
        <Sidebar>
          <TabTrigger name="dashboard" href="/dashboard" asChild><NavButton>Dashboard</NavButton></TabTrigger>
          <TabTrigger name="pos" href="/pos" asChild><NavButton>POS</NavButton></TabTrigger>
          <TabTrigger name="inventory" href="/inventory" asChild><NavButton>Inventory</NavButton></TabTrigger>
          <TabTrigger name="sales" href="/sales" asChild><NavButton>Sales</NavButton></TabTrigger>
        </Sidebar>
      </TabList>
      <TabSlot style={styles.slot} />
    </Tabs>
  );
}

function Sidebar({ children, style, ...props }: TabListProps) {
  const router = useRouter();
  const { shop } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const subtitle = shop?.categories?.[0];

  return (
    <View {...props} style={[styles.sidebar, style]}>
      <View style={styles.header}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initial}</Text></View>
        <View>
          <Text style={styles.shopName} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
          {subtitle && <Text style={styles.shopSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      <View style={styles.nav}>{children}</View>
      <View style={styles.footer}>
        <Text style={styles.poweredBy}>Powered by Ka Iibi</Text>
        <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

function NavButton({ children, isFocused, style: _style, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable {...props} style={({ pressed }) => [styles.navButton, isFocused && styles.navButtonFocused, pressed && styles.pressed]}>
      <Text style={[styles.navText, isFocused && styles.navTextFocused]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC', paddingVertical: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 24 },
  avatar: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  shopName: { color: '#111111', fontSize: 15, fontWeight: '800', maxWidth: 140 },
  shopSubtitle: { color: '#999999', fontSize: 11, marginTop: 1 },
  nav: { paddingHorizontal: 10, gap: 2 },
  navButton: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  navButtonFocused: { backgroundColor: '#F2F2F2' },
  pressed: { opacity: 0.75 },
  navText: { color: '#555555', fontSize: 13, fontWeight: '600' },
  navTextFocused: { color: '#111111', fontWeight: '800' },
  footer: { marginTop: 'auto', paddingHorizontal: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC', gap: 4 },
  poweredBy: { color: '#BBBBBB', fontSize: 10, fontWeight: '700' },
  signOut: { color: '#999999', fontSize: 11, fontWeight: '700' },
  slot: { flex: 1 },
});
