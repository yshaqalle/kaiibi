import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useSupportUnread } from '@/lib/support-unread';

// A number on a menu nobody opened is not a delivery mechanism -- the ☰ badge
// only reaches someone who was already going to look. This is the one line over
// the content that reaches everyone else.
//
// Dismissal is component state, deliberately, and neither narrower nor wider
// than that. The shells stay mounted across every route, so it survives
// navigation -- a banner that reappears on each screen change is the thing
// people learn to swipe past without reading, which is worse than no banner.
// It does NOT survive a relaunch, because the next app open is the occasion the
// line exists for; persisting it would turn "dismissed once" into "never shown
// again".
//
// What is dismissed is a COUNT, not the banner. Remembering it as a boolean made
// ✕ a one-way latch for the whole session: a reply arriving afterwards raised
// the ☰ badge and left this line hidden, so the one surface that reaches
// somebody who was not already looking at the menu went quiet exactly when it
// had something new to say. Any change to the count is news -- a message
// arriving, or one being read while others remain -- so any change brings the
// line back.
//
// `tone` mirrors SupportMenuItem's, for the same reason: the shell owns the
// ground this is dropped onto, and admin-tabs.tsx's is fixed dark chrome. Each
// palette's `bentoAccentInk` is solved against its own `bentoAccentWash`, so
// the TEXT clears AA either way; what `tone` decides is the wash, and pinning
// the light one would make a pale blue slab the brightest thing on a black
// header.
export function SupportBanner({ onOpen, tone = 'light' }: { onOpen: () => void; tone?: 'light' | 'dark' }) {
  const { count } = useSupportUnread();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const theme = tone === 'dark' ? Colors.dark : Colors.light;
  if (count === 0 || count === dismissedAt) return null;

  return (
    <View style={[styles.bar, { backgroundColor: theme.bentoAccentWash }]}>
      <Text style={[styles.text, { color: theme.bentoAccentInk }]}>
        {count === 1 ? 'You have a message from Kaiibi.' : `You have ${count} messages from Kaiibi.`}
      </Text>
      <Pressable onPress={onOpen} hitSlop={8} accessibilityRole="button">
        <Text style={[styles.action, { color: theme.bentoAccentInk }]}>Read</Text>
      </Pressable>
      <Pressable
        onPress={() => setDismissedAt(count)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
      >
        <Text style={[styles.close, { color: theme.bentoAccentInk }]}>✕</Text>
      </Pressable>
    </View>
  );
}

// Colors live inline against `theme` at render time (see above), not here --
// `tone` picks between Colors.light and Colors.dark, and a static StyleSheet
// cannot hold two palettes at once.
//
// The vertical margins are the bar's own rather than its host's so that the
// slot each shell reserves for it collapses to nothing when there is no banner
// to show.
const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginVertical: 10,
  },
  text: { flex: 1, fontSize: 12.5, fontWeight: '700' },
  action: { fontSize: 12.5, fontWeight: '800' },
  // Quieter than `action`, because dismissing is not what this line is for --
  // but only to 0.85. At 0.7 the glyph blends to 3.56:1 on the light wash: legal
  // for an icon, under the 4.5:1 this is actually rendered as, which is text.
  close: { fontSize: 13, opacity: 0.85 },
});
