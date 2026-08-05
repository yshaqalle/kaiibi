import { StyleSheet, Text, View } from 'react-native';

import { Marketing, MarketingLayout } from '@/constants/marketing-theme';
import { useLocale } from '@/hooks/use-locale';
import type { MessageKey } from '@/lib/i18n';

// The kinds of shop Kaiibi is for. Not logos and not a customer count — those
// would be claims; these are just categories.

const KINDS: MessageKey[] = ['trust.shops', 'trust.pharmacies', 'trust.electronics', 'trust.wholesalers'];

export function LandingTrustStrip() {
  const { t } = useLocale();
  return (
    <View style={styles.strip}>
      <View style={styles.inner}>
        {KINDS.map((kind) => (
          <Text key={kind} style={styles.item}>
            {t(kind)}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: Marketing.line,
    backgroundColor: Marketing.gray50,
    paddingVertical: 26,
  },
  inner: {
    width: '100%',
    maxWidth: MarketingLayout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: MarketingLayout.gutter,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 44,
  },
  item: {
    fontSize: 13,
    fontWeight: '700',
    color: Marketing.gray400,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
