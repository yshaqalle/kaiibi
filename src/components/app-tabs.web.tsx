import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

export default function AppTabs() {
  const { width } = useWindowDimensions();
  const compact = width < 640;

  return (
    <Tabs>
      <TabSlot style={[styles.slot, compact && styles.slotCompact]} />
      <TabList asChild>
        <Header compact={compact}>
          <TabTrigger name="store" href="/explore" asChild><NavButton compact={compact} variant="store">My shop</NavButton></TabTrigger>
          <TabTrigger name="discover" href="/" asChild><NavButton compact={compact} variant="discover">Discover</NavButton></TabTrigger>
        </Header>
      </TabList>
    </Tabs>
  );
}

function Header({ compact, children, style, ...props }: TabListProps & { compact: boolean }) {
  return <View {...props} style={[styles.header, style]}>
    <View style={styles.topbar}>
      <Text style={styles.brand}>tukaanka</Text>
      {!compact && <Text style={styles.location}>⌖ Shopping local in Saint Paul</Text>}
      {!compact && <Text style={styles.actionText}>Sell with us</Text>}
    </View>
    {children}
  </View>;
}

function NavButton({ children, isFocused, compact, variant, style: _style, ...props }: TabTriggerSlotProps & { compact: boolean; variant: 'store' | 'discover' }) {
  const position = variant === 'store' ? (compact ? styles.storeLinkCompact : styles.storeLink) : (compact ? styles.discoverLinkCompact : styles.discoverLink);
  return <Pressable {...props} style={({ pressed }) => [styles.navButton, position, isFocused && styles.navButtonFocused, pressed && styles.pressed]}><Text style={[styles.navText, isFocused && styles.navTextFocused]}>{children}</Text></Pressable>;
}

const styles = StyleSheet.create({
  slot: { height: '100%', paddingTop: 62 },
  slotCompact: { paddingTop: 62 },
  header: { position: 'absolute', top: 0, width: '100%', zIndex: 20, backgroundColor: '#17261F' },
  topbar: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 26, gap: 30, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  brand: { color: '#FFFFFF', fontSize: 29, lineHeight: 33, fontWeight: '900', letterSpacing: -1.8 },
  location: { color: '#DDE6DA', fontSize: 13, fontWeight: '600', flex: 1 },
  actionText: { color: '#DDE6DA', fontSize: 13, fontWeight: '700', marginLeft: 'auto', marginRight: 190 },
  navButton: { position: 'absolute', top: 14, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7 },
  storeLink: { right: 111 },
  discoverLink: { right: 26 },
  storeLinkCompact: { top: 11, right: 93 },
  discoverLinkCompact: { top: 11, right: 12 },
  pressed: { opacity: 0.75 },
  navButtonFocused: { backgroundColor: '#E6EFE4' },
  navText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  navTextFocused: { color: '#17261F' },
});
