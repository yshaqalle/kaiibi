import { Image } from 'expo-image';
import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';

const markWhite = require('@/assets/images/kaiibi-mark-white.png');

export default function AppTabs() {
  const { width } = useWindowDimensions();
  const compact = width < 640;
  const { session, shop } = useAuth();

  return (
    <Tabs>
      <TabSlot style={[styles.slot, compact && styles.slotCompact]} />
      <TabList asChild>
        <Header compact={compact}>
          <TabTrigger name="about" href="/about" asChild><NavButton compact={compact} variant="about">{compact ? 'Info' : 'How it works'}</NavButton></TabTrigger>
          <TabTrigger name="discover" href="/" asChild><NavButton compact={compact} variant="discover">Home</NavButton></TabTrigger>
          {session ? (
            <AccountButton compact={compact} label={shop?.name || 'My shop'} />
          ) : (
            <TabTrigger name="signup" href="/signup" asChild><NavButton compact={compact} variant="signup">Sign up</NavButton></TabTrigger>
          )}
        </Header>
      </TabList>
    </Tabs>
  );
}

function Header({ compact, children, style, ...props }: TabListProps & { compact: boolean }) {
  const router = useRouter();
  return <View {...props} style={[styles.header, style]}>
    <View style={styles.topbar}>
      <Pressable onPress={() => router.push('/')} accessibilityRole="link" style={styles.brandRow}>
        <Image source={markWhite} contentFit="contain" style={styles.brandMark} />
        <Text style={styles.brand}>Ka Iibi</Text>
      </Pressable>
      {!compact && <Text style={styles.location}>⌖ Simple, easy-to-use point of sale & inventory — for any shop, anywhere</Text>}
    </View>
    {children}
  </View>;
}

function NavButton({ children, isFocused, compact, variant, style: _style, ...props }: TabTriggerSlotProps & { compact: boolean; variant: 'about' | 'discover' | 'signup' }) {
  const position = variant === 'signup' ? (compact ? styles.signUpLinkCompact : styles.signUpLink) : variant === 'about' ? (compact ? styles.aboutLinkCompact : styles.aboutLink) : (compact ? styles.discoverLinkCompact : styles.discoverLink);
  return <Pressable {...props} style={({ pressed }) => [styles.navButton, position, variant === 'signup' && styles.signUpButton, isFocused && styles.navButtonFocused, pressed && styles.pressed]}><Text style={[styles.navText, variant === 'signup' && styles.signUpText, isFocused && styles.navTextFocused]}>{children}</Text></Pressable>;
}

// Not a `TabTrigger` — it targets `/dashboard`, which lives outside this
// Tabs group's own routes (`about`/`discover`/`signup`), so it can't be a
// sibling tab. It reuses the sign-up slot's position/styling so swapping
// between signed-out and signed-in states doesn't shift the layout.
function AccountButton({ compact, label }: { compact: boolean; label: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push('/dashboard')}
      style={({ pressed }) => [styles.navButton, compact ? styles.signUpLinkCompact : styles.signUpLink, styles.signUpButton, styles.accountButton, pressed && styles.pressed]}>
      <Text style={[styles.navText, styles.signUpText]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: { height: '100%', paddingTop: 62 },
  slotCompact: { paddingTop: 62 },
  header: { position: 'absolute', top: 0, width: '100%', zIndex: 20, backgroundColor: '#111111' },
  topbar: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 26, gap: 30, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandMark: { width: 27, height: 29 },
  brand: { color: '#FFFFFF', fontSize: 29, lineHeight: 33, fontWeight: '900', letterSpacing: -1.8 },
  location: { color: '#CCCCCC', fontSize: 13, fontWeight: '600', flex: 1 },
  navButton: { position: 'absolute', top: 14, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 7 },
  aboutLink: { right: 209 },
  discoverLink: { right: 121 },
  signUpLink: { right: 26 },
  aboutLinkCompact: { display: 'none' },
  discoverLinkCompact: { top: 11, right: 87 },
  signUpLinkCompact: { top: 11, right: 12 },
  signUpButton: { backgroundColor: '#FFFFFF' },
  accountButton: { maxWidth: 84 },
  signUpText: { color: '#111111' },
  pressed: { opacity: 0.75 },
  navButtonFocused: { backgroundColor: '#2A2A2A' },
  navText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  navTextFocused: { color: '#FFFFFF' },
});
