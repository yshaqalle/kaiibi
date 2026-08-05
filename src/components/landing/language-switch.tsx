import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Marketing, MarketingRadius } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import { LOCALES, type Locale } from '@/lib/i18n';

// The EN/SO pill. One component, three skins, because the design puts the same
// control on an ink bar, on a light footer, and inside the native login hero —
// and three copies would drift.
//
// All instances read the same context, so switching in one updates the others'
// selected state for free. That is worth checking by hand when touching this:
// two switchers disagreeing about the current language is the obvious failure.

export function LanguageSwitch({
  tone = 'onDark',
  compact = false,
}: {
  tone?: 'onDark' | 'onLight';
  /** Two-letter labels, for the narrow bars where "Soomaali" won't fit. */
  compact?: boolean;
}) {
  const { locale, setLocale, t } = useLocale();
  const onDark = tone === 'onDark';

  return (
    <View
      style={[styles.group, onDark ? styles.groupOnDark : styles.groupOnLight]}
      role="radiogroup"
      accessibilityLabel={t('lang.group')}
    >
      {LOCALES.map((option) => (
        <Option
          key={option}
          locale={option}
          label={t(labelKey(option, compact))}
          selected={locale === option}
          onDark={onDark}
          onPress={() => setLocale(option)}
        />
      ))}
    </View>
  );
}

function labelKey(locale: Locale, compact: boolean) {
  if (compact) return locale === 'en' ? ('lang.enShort' as const) : ('lang.soShort' as const);
  return locale === 'en' ? ('lang.en' as const) : ('lang.so' as const);
}

function Option({
  locale,
  label,
  selected,
  onDark,
  onPress,
}: {
  locale: Locale;
  label: string;
  selected: boolean;
  onDark: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      role="radio"
      // Both spellings on purpose, and neither is redundant. Verified in the
      // browser: `accessibilityState={{ selected }}` and `{{ checked }}` each
      // emitted NO attribute at all on role="radio", so a screen reader could
      // not tell which language was active. The `aria-checked` prop (RN 0.71+)
      // is what actually reaches the DOM; `accessibilityState` is what native
      // reads.
      aria-checked={selected}
      accessibilityState={{ checked: selected }}
      // The language's own name, so the label reads to a speaker of the
      // language being offered rather than the one currently active.
      accessibilityLabel={locale === 'en' ? 'English' : 'Soomaali'}
      style={({ pressed, hovered }) => [
        styles.option,
        selected && (onDark ? styles.optionSelectedOnDark : styles.optionSelectedOnLight),
        hovered && !selected && styles.optionHovered,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.label,
          onDark ? styles.labelOnDark : styles.labelOnLight,
          selected && (onDark ? styles.labelSelectedOnDark : styles.labelSelectedOnLight),
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', borderRadius: MarketingRadius.pill, padding: 3, gap: 2 },
  groupOnDark: { backgroundColor: 'rgba(255,255,255,0.12)' },
  groupOnLight: { backgroundColor: Marketing.gray100, borderWidth: 1, borderColor: Marketing.line },

  option: { paddingVertical: 5, paddingHorizontal: 14, borderRadius: MarketingRadius.pill },
  optionSelectedOnDark: { backgroundColor: Marketing.white },
  optionSelectedOnLight: { backgroundColor: Marketing.ink },
  optionHovered: { opacity: 0.85 },
  pressed: { opacity: 0.7 },

  label: { fontSize: 12.5, fontWeight: '700' },
  labelOnDark: { color: 'rgba(255,255,255,0.7)' },
  labelOnLight: { color: Marketing.gray500 },
  labelSelectedOnDark: { color: Marketing.ink },
  labelSelectedOnLight: { color: Marketing.white },
});
