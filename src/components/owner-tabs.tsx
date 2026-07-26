import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

// The top header and bottom tab bar are deliberately always dark — matching
// the marketing site's black header/footer brand treatment — regardless of
// the device's system color scheme. The screens they wrap stay on the light
// palette, so this isn't a dark-mode toggle, just fixed shell chrome.
export default function OwnerTabs() {
  const colors = Colors.dark;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { shop } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();

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
          <Pressable onPress={() => router.push('/settings')} hitSlop={8} style={styles.settingsButton}>
            <Text style={[styles.settingsIcon, { color: colors.text }]}>⚙</Text>
            <Text style={[styles.settingsLabel, { color: colors.text }]}>Settings</Text>
          </Pressable>
          <Pressable onPress={() => signOut().then(() => router.replace('/signup'))} hitSlop={8}>
            <Text style={[styles.signOut, { color: colors.textSecondary }]}>Sign out</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.slot}>
        <NativeTabs
          backgroundColor={colors.background}
          indicatorColor={colors.backgroundElement}
          iconColor={{ default: colors.textSecondary, selected: colors.text }}
          disableTransparentOnScrollEdge
          labelStyle={{
            default: { color: colors.textSecondary, fontWeight: '600' },
            selected: { color: colors.text, fontWeight: '800' },
          }}>
          <NativeTabs.Trigger name="dashboard">
            <NativeTabs.Trigger.Label>Dashboard</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/home.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="pos">
            <NativeTabs.Trigger.Label>POS</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/explore.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="inventory">
            <NativeTabs.Trigger.Label>Inventory</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/explore.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales">
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/home.png')} />
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
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  settingsButton: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 2 },
  settingsIcon: { fontSize: 18 },
  settingsLabel: { fontSize: 12, fontWeight: '700' },
  signOut: { fontSize: 12, fontWeight: '700' },
  slot: { flex: 1 },
});
