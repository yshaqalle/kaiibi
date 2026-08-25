import { DarkTheme, DefaultTheme, Redirect, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/hooks/use-auth';
import { LocaleProvider } from '@/hooks/use-locale';
import { useUnlockedOrientation } from '@/hooks/use-orientation';
import { slugFromHostname } from '@/lib/storefront-host';
import { TillKeypad } from '@/components/till-keypad';

SplashScreen.preventAutoHideAsync();

// Web ships as one SPA behind a catch-all rewrite, so `xamdi.kaiibi.com` and
// the app itself load the same bundle. The hostname is the only thing that
// tells them apart. Read during the render pass itself -- NOT in a
// post-mount effect -- so a shop's storefront is what the browser paints
// first: a post-mount redirect means the marketing Stack.Screen paints once
// before the effect fires, and a customer's first impression of a shop
// becomes kaiibi's own advert. slugFromHostname fails closed, so localhost
// and preview hosts always resolve to the normal app.
function storefrontRedirect(): string | null {
  if (Platform.OS !== 'web') return null;
  const slug = slugFromHostname(window.location.hostname);
  if (slug && !window.location.pathname.startsWith('/s/')) {
    return `/s/${slug}`;
  }
  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useUnlockedOrientation();
  const redirectHref = storefrontRedirect();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Above AuthProvider deliberately: language doesn't depend on a
          session, and the public language bar has to render in the right
          language while auth is still resolving. */}
      <LocaleProvider>
        <AuthProvider>
          <AnimatedSplashOverlay />
          {redirectHref ? (
            <Redirect href={redirectHref as never} />
          ) : (
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
          )}
          {/* Once, at the root, because a keyboard is not a feature of one
              screen. It renders nothing unless the platform is withholding the
              system keyboard AND a field is focused -- see `TillKeypad`. */}
          <TillKeypad />
        </AuthProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
