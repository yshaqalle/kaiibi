import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/hooks/use-auth';
import { useTabletOrientation } from '@/hooks/use-tablet-orientation';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useTabletOrientation();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
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
    </ThemeProvider>
  );
}
