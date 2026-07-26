import { Image } from 'expo-image';
import { Slot, useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OwnerSidebar } from '@/components/owner-sidebar';
import { Colors } from '@/constants/theme';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

// The top header is deliberately always dark — matching the marketing site's
// black header brand treatment — regardless of the device's system color
// scheme. The screens it wraps stay on the light palette, so this isn't a
// dark-mode toggle, just fixed shell chrome.
//
// The bottom tab bar mirrors the mobile-web nav (see owner-tabs.web.tsx):
// white bar, gray unselected icons/labels, black selected label. It uses its
// own literal colors instead of the header's `Colors.dark` because those web
// nav colors (#999999 / #111111 / #FFFFFF) are a distinct grayscale from the
// green-tinted `Colors.light` theme palette, and matching the web nav pixel
// for pixel is the point.
const tabBarColors = {
  background: '#FFFFFF',
  iconDefault: '#999999',
  iconSelected: '#111111',
  labelDefault: '#999999',
  labelSelected: '#111111',
};

export default function OwnerTabs() {
  const colors = Colors.dark;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { shop } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const { width } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);

  // Tablets (iPad, Android tablets — unlocked to landscape via
  // use-tablet-orientation) get the same sidebar as web's desktop layout
  // instead of a phone-shaped bottom bar. Phones keep NativeTabs below.
  if (width >= TABLET_BREAKPOINT) {
    return (
      <OwnerSidebar>
        <Slot />
      </OwnerSidebar>
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 10, backgroundColor: colors.background, borderBottomColor: colors.backgroundElement }]}>
        <View style={styles.headerLeft}>
          <View style={[styles.avatar, { backgroundColor: colors.text }]}>
            {shop?.logoUrl ? <Image source={{ uri: shop.logoUrl }} contentFit="cover" style={styles.avatarImage} /> : <Text style={[styles.avatarText, { color: colors.background }]}>{initial}</Text>}
          </View>
          <Text style={[styles.shopName, { color: colors.text }]} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => setMenuOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.menuButton, { backgroundColor: colors.backgroundElement, opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.menuIcon, { color: colors.text }]}>☰</Text>
          </Pressable>
        </View>
      </View>
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menuSheet, { top: insets.top + 54, backgroundColor: colors.background, borderColor: colors.backgroundElement }]}>
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                router.push('/settings');
              }}
              style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.settingsIcon, { color: colors.text }]}>⚙</Text>
              <Text style={[styles.menuItemText, { color: colors.text }]}>Settings</Text>
            </Pressable>
            <View style={[styles.menuDivider, { backgroundColor: colors.backgroundElement }]} />
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                signOut().then(() => router.replace('/signup'));
              }}
              style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.menuItemText, { color: colors.text }]}>Sign out</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      <View style={styles.slot}>
        {/* blurEffect="none" stops iOS from compositing backgroundColor with a
            system blur material, which otherwise pulls in dark-mode tinting
            regardless of userInterfaceStyle and defeats the fixed white bar. */}
        <NativeTabs
          backgroundColor={tabBarColors.background}
          iconColor={{ default: tabBarColors.iconDefault, selected: tabBarColors.iconSelected }}
          disableTransparentOnScrollEdge
          blurEffect="none"
          labelStyle={{
            default: { color: tabBarColors.labelDefault, fontWeight: '600' },
            selected: { color: tabBarColors.labelSelected, fontWeight: '800' },
          }}>
          <NativeTabs.Trigger name="dashboard">
            <NativeTabs.Trigger.Label>Dashboard</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/home.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="pos">
            <NativeTabs.Trigger.Label>POS</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/cart.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="inventory">
            <NativeTabs.Trigger.Label>Inventory</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/grid.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales">
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/chart.png')} />
          </NativeTabs.Trigger>
        </NativeTabs>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 12 },
  avatar: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { fontSize: 14, fontWeight: '800' },
  shopName: { fontSize: 15, fontWeight: '800', flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuButton: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8 },
  menuIcon: { fontSize: 16 },
  settingsIcon: { fontSize: 15 },
  slot: { flex: 1 },
  menuBackdrop: { flex: 1 },
  menuSheet: { position: 'absolute', right: 16, minWidth: 160, borderRadius: 12, borderWidth: 1, paddingVertical: 6, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  menuItemText: { fontSize: 14, fontWeight: '700' },
  menuDivider: { height: StyleSheet.hairlineWidth },
});
