import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GlobalSearch } from '@/components/dashboard/global-search';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useShopLogo } from '@/hooks/use-shop-logo';
import type { SearchResult } from '@/lib/search';

const theme = Colors.light;

// The Dashboard's own header band: shop mark, name, and the global search.
//
// Scoped to this screen's content area, NOT the nav shell. The shell already
// owns navigation on every platform -- AdminSidebar on wide web, a top header
// plus bottom tabs below the tablet breakpoint, native tabs on device -- so
// this deliberately carries no hamburger and no nav of its own. Duplicating
// them would give the reader two rows of chrome and two ways to go the same
// places.
//
// The logo and the name come from `useAuth()` rather than being passed in,
// for the same reason AdminSidebar reads them there: they are shop identity,
// and a screen that took them as props could be handed the wrong ones.
export function DashboardPageHeader({ onSelectResult }: { onSelectResult: (result: SearchResult) => void }) {
  const { shop } = useAuth();
  const { editLogo, uploading, canEditLogo, logoUrl } = useShopLogo();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Pressable
          onPress={editLogo}
          disabled={!canEditLogo || uploading}
          // Light behind a real logo, dark only behind the fallback initial.
          // A logo is usually a transparent PNG, and on a near-black circle
          // its dark strokes disappear into the background — which is exactly
          // how this looked before.
          style={[styles.mark, logoUrl ? styles.markWithLogo : styles.markFallback, uploading && styles.markBusy]}
          accessibilityLabel={canEditLogo ? 'Change shop logo' : undefined}
          accessibilityRole={canEditLogo ? 'button' : undefined}
        >
          {logoUrl ? (
            <Image source={{ uri: logoUrl }} style={styles.markImage} contentFit="cover" />
          ) : (
            <Text style={styles.markText}>{initial}</Text>
          )}
        </Pressable>
        <View style={styles.brandText}>
          <Text style={styles.shopName} numberOfLines={1}>
            {shop?.name ?? 'Dashboard'}
          </Text>
          <Text style={styles.shopMeta}>{canEditLogo ? 'Tap the logo to change it' : 'Dashboard'}</Text>
        </View>
      </View>

      <GlobalSearch onSelect={onSelectResult} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    flexWrap: 'wrap',
    backgroundColor: theme.bentoSurface,
    borderRadius: 22,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 14,
    // Keeps the search panel above the cards below it once it opens.
    zIndex: 30,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11, flexShrink: 1 },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  markWithLogo: { backgroundColor: theme.bentoSoft, borderWidth: 1, borderColor: theme.bentoLine },
  markFallback: { backgroundColor: theme.bentoInk },
  markBusy: { opacity: 0.5 },
  markImage: { width: '100%', height: '100%' },
  markText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
  brandText: { flexShrink: 1 },
  shopName: { fontSize: 15, fontWeight: '800', color: theme.bentoInk, lineHeight: 19 },
  shopMeta: { fontSize: 12, color: theme.bentoMuted, lineHeight: 15 },
});
