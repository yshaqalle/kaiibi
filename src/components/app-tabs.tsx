import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ color: colors.text }}>
      <NativeTabs.Trigger name="index" options={{ title: 'Discover', icon: { src: require('@/assets/images/tabIcons/home.png') } }} />
      <NativeTabs.Trigger name="explore" options={{ title: 'My Store', icon: { src: require('@/assets/images/tabIcons/explore.png') } }} />
      <NativeTabs.Trigger name="about" options={{ title: 'How it works', icon: { src: require('@/assets/images/tabIcons/explore.png') } }} />
      <NativeTabs.Trigger name="signup" options={{ title: 'Sign up', icon: { src: require('@/assets/images/tabIcons/home.png') } }} />
    </NativeTabs>
  );
}
