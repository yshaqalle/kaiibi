import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

export default function AppTabs() {
  const { width } = useWindowDimensions();
  const compact = width < 640;

  return (
    <Tabs>
      <TabSlot style={[styles.slot, compact && styles.slotCompact]} />
      <TabList asChild>
        <Header compact={compact}>
          <TabTrigger name="about" href="/about" asChild><NavButton compact={compact} variant="about">{compact ? 'Info' : 'How it works'}</NavButton></TabTrigger>
          <TabTrigger name="store" href="/explore" asChild><NavButton compact={compact} variant="store">{compact ? 'Shop' : 'My shop'}</NavButton></TabTrigger>
          <TabTrigger name="discover" href="/" asChild><NavButton compact={compact} variant="discover">Discover</NavButton></TabTrigger>
          <TabTrigger name="signup" href="/signup" asChild><NavButton compact={compact} variant="signup">Sign up</NavButton></TabTrigger>
        </Header>
      </TabList>
    </Tabs>
  );
}

function Header({ compact, children, style, ...props }: TabListProps & { compact: boolean }) {
  const router = useRouter();
  return <View {...props} style={[styles.header, style]}>
    <View style={styles.topbar}>
      <Pressable onPress={() => router.push('/')} accessibilityRole="link"><Text style={styles.brand}>kaiibi</Text></Pressable>
      {!compact && <Text style={styles.location}>⌖ Shop online in Hargeisa · compare local prices · choose delivery or pickup</Text>}
    </View>
    {children}
  </View>;
}

function NavButton({ children, isFocused, compact, variant, style: _style, ...props }: TabTriggerSlotProps & { compact: boolean; variant: 'about' | 'store' | 'discover' | 'signup' }) {
  const position = variant === 'signup' ? (compact ? styles.signUpLinkCompact : styles.signUpLink) : variant === 'about' ? (compact ? styles.aboutLinkCompact : styles.aboutLink) : variant === 'store' ? (compact ? styles.storeLinkCompact : styles.storeLink) : (compact ? styles.discoverLinkCompact : styles.discoverLink);
  return <Pressable {...props} style={({ pressed }) => [styles.navButton, position, variant === 'signup' && styles.signUpButton, isFocused && styles.navButtonFocused, pressed && styles.pressed]}><Text style={[styles.navText, variant === 'signup' && styles.signUpText, isFocused && styles.navTextFocused]}>{children}</Text></Pressable>;
}

const styles = StyleSheet.create({
  slot: { height: '100%', paddingTop: 62 },
  slotCompact: { paddingTop: 62 },
  header: { position: 'absolute', top: 0, width: '100%', zIndex: 20, backgroundColor: '#17261F' },
  topbar: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 26, gap: 30, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  brand: { color: '#FFFFFF', fontSize: 29, lineHeight: 33, fontWeight: '900', letterSpacing: -1.8 },
  location: { color: '#DDE6DA', fontSize: 13, fontWeight: '600', flex: 1 },
  navButton: { position: 'absolute', top: 14, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7 },
  aboutLink: { right: 303 },
  storeLink: { right: 209 },
  discoverLink: { right: 121 },
  signUpLink: { right: 26 },
  aboutLinkCompact: { display: 'none' },
  storeLinkCompact: { top: 11, right: 169 },
  discoverLinkCompact: { top: 11, right: 87 },
  signUpLinkCompact: { top: 11, right: 12 },
  signUpButton: { backgroundColor: '#E45B37' },
  signUpText: { color: '#FFFFFF' },
  pressed: { opacity: 0.75 },
  navButtonFocused: { backgroundColor: '#E6EFE4' },
  navText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  navTextFocused: { color: '#17261F' },
});
