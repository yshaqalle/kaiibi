import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { signOut } from '@/lib/auth';

export default function OwnerTabs() {
  const { width } = useWindowDimensions();
  const compact = width < 640;

  return (
    <Tabs>
      <TabSlot style={[styles.slot, compact && styles.slotCompact]} />
      <TabList asChild>
        <Header compact={compact}>
          <TabTrigger name="dashboard" href="/dashboard" asChild><NavButton compact={compact} position={0}>Dashboard</NavButton></TabTrigger>
          <TabTrigger name="sell" href="/sell" asChild><NavButton compact={compact} position={1}>Sell</NavButton></TabTrigger>
          <TabTrigger name="inventory" href="/inventory" asChild><NavButton compact={compact} position={2}>Inventory</NavButton></TabTrigger>
          <TabTrigger name="sales" href="/sales" asChild><NavButton compact={compact} position={3}>Sales</NavButton></TabTrigger>
        </Header>
      </TabList>
    </Tabs>
  );
}

function Header({ compact, children, style, ...props }: TabListProps & { compact: boolean }) {
  const router = useRouter();
  return <View {...props} style={[styles.header, style]}>
    <View style={styles.topbar}>
      <Text style={styles.brand}>Ka Iibi · Owner</Text>
      {children}
      <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}><Text style={styles.signOut}>Sign out</Text></Pressable>
    </View>
  </View>;
}

function NavButton({ children, isFocused, compact, position, style: _style, ...props }: TabTriggerSlotProps & { compact: boolean; position: number }) {
  return <Pressable {...props} style={({ pressed }) => [styles.navButton, isFocused && styles.navButtonFocused, pressed && styles.pressed]}><Text style={[styles.navText, isFocused && styles.navTextFocused]}>{children}</Text></Pressable>;
}

const styles = StyleSheet.create({
  slot: { height: '100%', paddingTop: 62 },
  slotCompact: { paddingTop: 62 },
  header: { position: 'absolute', top: 0, width: '100%', zIndex: 20, backgroundColor: '#17261F' },
  topbar: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 26, gap: 18, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  brand: { color: '#FFFFFF', fontSize: 20, fontWeight: '900', letterSpacing: -1 },
  navButton: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7 },
  navButtonFocused: { backgroundColor: '#E6EFE4' },
  pressed: { opacity: 0.75 },
  navText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  navTextFocused: { color: '#17261F' },
  signOut: { color: '#DDE6DA', fontSize: 12, fontWeight: '700', marginLeft: 'auto' },
});
