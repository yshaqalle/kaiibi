import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';
import {
  DEFAULT_THEME,
  PALETTES,
  THEMES,
  paletteColors,
  type StorefrontPalette,
  type StorefrontTheme,
} from '@/lib/storefront-catalog';

// Pinned to the light palette — no dark mode yet, same as every other bento
// screen.
const theme = Colors.light;

// The row of theme tiles and colour swatches a shop picks its public page's
// look from. Both rows are DERIVED from THEMES/PALETTES, never a hand-typed
// list -- a seventh palette needs no change here.
//
// The one exception to "tokens only" in this file: the swatches paint each
// palette's real ground/soft/accent from paletteColors, because seeing the
// colour before applying it is the entire point of the strip.
export function DesignStrip({
  theme: selectedTheme,
  palette: selectedPalette,
  neverPublished,
  onThemeChange,
  onPaletteChange,
}: {
  theme: StorefrontTheme;
  palette: StorefrontPalette;
  /**
   * `storefront.publishedAt === null` -- the real signal for "this shop has
   * never chosen a design", handed down by the editor screen. Depends on
   * nothing else: a shop that deliberately returns to Market/Ink after
   * customising has published, so it has chosen, whatever it chose.
   */
  neverPublished: boolean;
  onThemeChange: (key: StorefrontTheme) => void;
  onPaletteChange: (key: StorefrontPalette) => void;
}) {
  return (
    <BentoCard title="Design">
      <Text style={styles.eyebrow}>Layout</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.row}
      >
        {THEMES.map((t) => {
          const active = t.key === selectedTheme;
          const showBadge = neverPublished && t.key === DEFAULT_THEME;
          return (
            <Pressable
              key={t.key}
              onPress={() => onThemeChange(t.key)}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: active }}
              style={[styles.tile, active && styles.tileActive]}
            >
              <Text style={[styles.tileLabel, active && styles.tileLabelActive]}>{t.label}</Text>
              <Text
                style={[styles.tileDescription, active && styles.tileDescriptionActive]}
                numberOfLines={3}
              >
                {t.description}
              </Text>
              {showBadge ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>Chosen for you</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <Text style={[styles.eyebrow, styles.paletteEyebrow]}>Colours</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.row}
      >
        {PALETTES.map((p) => {
          const active = p.key === selectedPalette;
          const colors = paletteColors(p.key);
          return (
            <Pressable
              key={p.key}
              onPress={() => onPaletteChange(p.key)}
              accessibilityRole="button"
              accessibilityLabel={`${p.label}, suits ${p.suits}`}
              accessibilityState={{ selected: active }}
              style={[styles.swatchTile, active && styles.swatchTileActive]}
            >
              <View style={styles.swatchRow}>
                <View style={[styles.swatch, { backgroundColor: colors.ground }]} />
                <View style={[styles.swatch, { backgroundColor: colors.soft }]} />
                <View style={[styles.swatch, styles.swatchAccent, { backgroundColor: colors.accent }]} />
              </View>
              <Text style={[styles.swatchLabel, active && styles.swatchLabelActive]}>{p.label}</Text>
              <Text style={styles.swatchSuits} numberOfLines={1}>
                {p.suits}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 8,
  },
  paletteEyebrow: { marginTop: 16 },
  scroll: { flexGrow: 0 },
  row: { flexDirection: 'row', gap: 10, paddingBottom: 2, paddingRight: 4 },

  tile: {
    width: 158,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    padding: 12,
  },
  tileActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  tileLabel: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, marginBottom: 4 },
  tileLabelActive: { color: theme.bentoSurface },
  tileDescription: { fontSize: 11.5, lineHeight: 15, color: theme.bentoMuted2 },
  tileDescriptionActive: { color: theme.bentoSurface },

  badge: {
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    marginTop: 8,
  },
  badgeText: { fontSize: 10, fontWeight: '800', color: theme.bentoAccentInk },

  swatchTile: {
    width: 118,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    padding: 10,
  },
  swatchTileActive: { borderColor: theme.bentoInk, borderWidth: 2, padding: 9 },
  swatchRow: { flexDirection: 'row', gap: 4, marginBottom: 8 },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.bentoLine,
  },
  swatchAccent: { borderColor: 'transparent' },
  swatchLabel: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 2 },
  swatchLabelActive: { color: theme.bentoInk },
  swatchSuits: { fontSize: 10.5, color: theme.bentoMuted2 },
});
