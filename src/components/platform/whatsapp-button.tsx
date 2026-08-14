import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/lib/external-url';
import { whatsappLink } from '@/lib/whatsapp';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// WhatsApp's own green. The one brand colour in the console that is not a
// bento token, because it is not ours to restyle: a green glyph IS the
// affordance, and a grey one would not be recognised as it.
export const WHATSAPP_GREEN = '#1fa855';
export const WHATSAPP_WASH = '#e7f6ed';

// The official mark, drawn rather than approximated with a phone character:
// six of these sit in a column on the Overview, and a glyph nobody recognises
// is worse than the word it replaced.
const WHATSAPP_PATH =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z';

/**
 * Opens WhatsApp with a number and a first line already written.
 *
 * Renders NOTHING when the number cannot be dialled, per the note in
 * src/lib/whatsapp.ts: a caller that draws an affordance should ask
 * whatsappLink() and hide itself when it returns null, because offering to
 * message someone unreachable is worse than not offering.
 */
export function WhatsAppButton({
  phone,
  message,
  label,
}: {
  phone: string | null | undefined;
  message: string;
  /** Spoken by a screen reader — the word the glyph replaced. */
  label: string;
}) {
  const link = whatsappLink(phone, message);
  if (!link) return null;
  return (
    <Pressable
      onPress={() => openExternalUrl(link)}
      style={({ hovered }) => [styles.button, styles.wa, hovered && styles.hovered]}
      hitSlop={8}
      aria-label={label}
      role="button"
    >
      <Svg width={17} height={17} viewBox="0 0 24 24">
        <Path d={WHATSAPP_PATH} fill={WHATSAPP_GREEN} />
      </Svg>
    </Pressable>
  );
}

/** The fallback when there is no number. Every owner row has an email. */
export function EmailButton({ email, label }: { email: string | null | undefined; label: string }) {
  if (!email) return null;
  return (
    <Pressable
      onPress={() => openExternalUrl(`mailto:${email}`)}
      style={({ hovered }) => [styles.button, styles.mail, hovered && styles.hovered]}
      hitSlop={8}
      aria-label={label}
      role="button"
    >
      <Svg width={16} height={16} viewBox="0 0 24 24">
        <Rect x={2.5} y={5} width={19} height={14} rx={2.5} stroke={theme.bentoMuted} strokeWidth={1.7} fill="none" />
        <Path d="M3 7l9 6 9-6" stroke={theme.bentoMuted} strokeWidth={1.7} fill="none" />
      </Svg>
    </Pressable>
  );
}

/** Neither a number nor an address — said once, quietly, rather than drawn. */
export function NoContact({ children = 'no contact' }: { children?: string }) {
  return (
    <View>
      <Text style={styles.none}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 34pt drawn, 44pt+ pressable via hitSlop.
  button: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hovered: { opacity: 0.8 },
  wa: { backgroundColor: WHATSAPP_WASH },
  mail: { backgroundColor: theme.bentoSoft },
  none: { color: theme.bentoMuted2, fontSize: 11 },
});
