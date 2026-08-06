import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

// A person's circular avatar: their photo when one exists, otherwise their
// initials on a soft tint. Shared by the roster row, the detail pane's
// identity row, and the add/edit form's preview — three places that would
// otherwise each hand-roll the same fallback.
export function Avatar({ photoUrl, name, size = 32 }: { photoUrl: string | null; name: string | null; size?: number }) {
  return (
    <View style={[styles.base, { width: size, height: size, borderRadius: 999 }]}>
      {photoUrl ? (
        <Image source={{ uri: photoUrl }} contentFit="cover" style={{ width: size, height: size, borderRadius: 999 }} />
      ) : (
        <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initialsOf(name)}</Text>
      )}
    </View>
  );
}

// First + last initial, matching how a name reads elsewhere on this screen
// (e.g. "Hodan Ali" → "HA"). A single name, or none at all, still needs an
// answer -- '?' rather than a blank circle that could pass for a loading
// state.
function initialsOf(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

const styles = StyleSheet.create({
  base: { backgroundColor: theme.bentoSoft, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontWeight: '800', color: theme.bentoInk2 },
});
