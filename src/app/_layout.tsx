import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/hooks/use-auth';
import { LocaleProvider } from '@/hooks/use-locale';
import { useUnlockedOrientation } from '@/hooks/use-orientation';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useUnlockedOrientation();
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
        </AuthProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
