import { FontAwesome } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { openWhatsApp, whatsappLink } from '@/lib/whatsapp';

// One WhatsApp affordance, two shapes. It was inlined twice in the People
// screen -- a round icon in a list row, a green pill in a detail pane -- and
// the Team tab needed both, which is three and four copies of the same
// Pressable and the same styles.
//
// Renders nothing when the number can't be dialled (missing, or too short to
// be a phone number). Offering to message someone and then opening an empty
// chat is worse than not offering, and every call site had to remember to
// guard on `phone &&` to avoid it -- now none of them do.
export function WhatsAppButton({
  phone,
  name,
  variant = 'icon',
  message,
}: {
  phone: string | null | undefined;
  name: string;
  variant?: 'icon' | 'pill';
  message?: string;
}) {
  if (!whatsappLink(phone)) return null;

  const label = `Message ${name} on WhatsApp`;

  if (variant === 'pill') {
    return (
      <Pressable accessibilityLabel={label} onPress={() => openWhatsApp(phone!, message)} style={styles.pill}>
        <FontAwesome name="whatsapp" size={16} color="#FFFFFF" />
        <Text style={styles.pillText}>WhatsApp</Text>
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityLabel={label} onPress={() => openWhatsApp(phone!, message)} style={styles.icon} hitSlop={6}>
      <FontAwesome name="whatsapp" size={18} color="#25D366" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  icon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E1F0E4', alignItems: 'center', justifyContent: 'center' },
  // Matches the People screen's `actionButton` metrics so it sits level with
  // the Edit button beside it.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#111111',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  pillText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
});
