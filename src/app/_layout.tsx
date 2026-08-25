import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/hooks/use-auth';
import { LocaleProvider } from '@/hooks/use-locale';
import { useUnlockedOrientation } from '@/hooks/use-orientation';
import { slugFromHostname } from '@/lib/storefront-host';
import { TillKeypad } from '@/components/till-keypad';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useUnlockedOrientation();
  // Web ships as one SPA behind a catch-all rewrite, so `xamdi.kaiibi.com` and
  // the app itself load the same bundle. The hostname is the only thing that
  // tells them apart, and it is read once at boot. slugFromHostname fails
  // closed, so localhost and preview hosts always get the app.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const slug = slugFromHostname(window.location.hostname);
    if (slug && !window.location.pathname.startsWith('/s/')) {
      router.replace(`/s/${slug}`);
    }
  }, []);
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Above AuthProvider deliberately: language doesn't depend on a
          session, and the public language bar has to render in the right
          language while auth is still resolving. */}
      <LocaleProvider>
        <AuthProvider>
          <AnimatedSplashOverlay />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(public)" />
            <Stack.Screen name="(admin)" />
            {/* Kaiibi's own back office, not a shop's. Its layout refuses
                anything but an MFA-verified operator on web.

                A real path segment, NOT a `(platform)` route group: groups are
                stripped from the URL, so `(platform)/index.tsx` resolved to `/`
                and collided with the marketing home page — leaving the portal
                with no reachable address at all. */}
            <Stack.Screen name="platform" />
            <Stack.Screen name="marketplace-coming-soon" />
          </Stack>
          {/* Once, at the root, because a keyboard is not a feature of one
              screen. It renders nothing unless the platform is withholding the
              system keyboard AND a field is focused -- see `TillKeypad`. */}
          <TillKeypad />
        </AuthProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
