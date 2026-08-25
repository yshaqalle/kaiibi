import { Pressable, StyleSheet, Text } from 'react-native';

import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { WHATSAPP_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
};

// Returns null when the shop has no number. Publishing requires one, so this is
// the belt to that braces -- a page rendered from a row written before that rule
// existed should lose the button, not render one that opens a chat with nobody.
export function WhatsAppButton({ storefront }: { storefront: PublicStorefront }) {
  if (!storefront.whatsappE164) return null;
  const href = waLink(storefront.whatsappE164, `Hello ${storefront.shopName}, I have a question.`);
  return (
    <Pressable style={styles.wa} onPress={() => openExternalUrl(href)} accessibilityRole="link">
      <Text style={styles.waText}>Message on WhatsApp</Text>
    </Pressable>
  );
}

export function EmptyState({ colors }: { colors: PaletteColors }) {
  return <Text style={[styles.empty, { color: colors.ink }]}>Nothing listed yet.</Text>;
}

const styles = StyleSheet.create({
  // Fixed green in every palette: a recognised affordance, not a brand colour.
  wa: { backgroundColor: WHATSAPP_GREEN, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  waText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  empty: { fontSize: 14, fontWeight: '700', padding: 24, textAlign: 'center' },
});
