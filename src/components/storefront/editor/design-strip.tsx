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

// A drawing of each layout, in the shape of the page it produces: Market's
// even grid, Counter's stacked price rows, Window's one big opening panel over
// larger tiles. Bars, not a screenshot -- a screenshot would be a second thing
// to keep in step with the themes, and would be wrong the first time one
// changed.
//
// Switches on the theme KEY rather than taking a shape as data, so a fourth
// layout fails to compile here until someone draws it. That is the intended
// behaviour: a layout with no preview is the problem this component exists to
// fix.
function LayoutWireframe({ theme: key, active }: { theme: StorefrontTheme; active: boolean }) {
  const bar = [styles.wireBar, active && styles.wireBarActive];

  return (
    <View style={[styles.wire, active && styles.wireActive]}>
      {key === 'market' ? (
        <>
          <View style={[...bar, styles.wireHead]} />
          <View style={styles.wireRow}>
            <View style={[...bar, styles.wireCell]} />
            <View style={[...bar, styles.wireCell]} />
          </View>
          <View style={styles.wireRow}>
            <View style={[...bar, styles.wireCell]} />
            <View style={[...bar, styles.wireCell]} />
          </View>
        </>
      ) : null}

      {key === 'counter' ? (
        <>
          <View style={[...bar, styles.wireHead]} />
          <View style={[...bar, styles.wireLine]} />
          <View style={[...bar, styles.wireLine]} />
          <View style={[...bar, styles.wireLine]} />
          <View style={[...bar, styles.wireLine]} />
        </>
      ) : null}

      {key === 'window' ? (
        <>
          <View style={[...bar, styles.wireHero]} />
          <View style={styles.wireRow}>
            <View style={[...bar, styles.wireCell]} />
            <View style={[...bar, styles.wireCell]} />
          </View>
        </>
      ) : null}
    </View>
  );
}

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
   * `storefront.firstPublishedAt === null` -- the real signal for "this
   * shop has never chosen a design", handed down by the editor screen.
   * Deliberately NOT `publishedAt === null`: that goes back to null the
   * moment a shop unpublishes, which would tell a shop that has already
   * published -- and so already chosen, whatever it chose -- that its
   * design was picked for it all over again. firstPublishedAt is set once,
   * on a shop's first publish, and never cleared by unpublishing.
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
              {/* A drawing of the layout, above the words for it.
                  "Even grid, price forward" asks a shop to picture something
                  they have never seen; three grey bars in the shape of the
                  actual page do not. Derived from the theme key, so a fourth
                  layout gets a wireframe by adding one case here rather than
                  by shipping an image. */}
              <LayoutWireframe theme={t.key} active={active} />
              <Text style={[styles.tileLabel, active && styles.tileLabelActive]}>
                {t.label}
                {active ? <Text style={styles.tick}> ✓</Text> : null}
              </Text>
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
              {/* One band, not three dots. Three 18px squares is not enough
                  surface to judge a palette by -- and the accent, the colour
                  the shop is really choosing, was the same size as the two
                  near-whites beside it. It now takes the larger share. */}
              <View style={styles.swatchRow}>
                <View style={[styles.swatchBand, { backgroundColor: colors.ground }]} />
                <View style={[styles.swatchBand, { backgroundColor: colors.soft }]} />
                <View style={[styles.swatchBand, styles.swatchBandAccent, { backgroundColor: colors.accent }]} />
              </View>
              <Text style={[styles.swatchLabel, active && styles.swatchLabelActive]}>
                {p.label}
                {active ? <Text style={styles.tick}> ✓</Text> : null}
              </Text>
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

  // A drawing of the layout, at the size the label needs anyway.
  wire: {
    height: 54,
    borderRadius: 9,
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    padding: 6,
    gap: 3,
    marginBottom: 9,
    overflow: 'hidden',
  },
  // On the inverted (selected) tile the wireframe's own white card would glare,
  // so it drops to a translucent panel and its bars lighten to match.
  wireActive: { backgroundColor: 'rgba(255,255,255,0.12)', borderColor: 'transparent' },
  wireBar: { backgroundColor: theme.bentoLine, borderRadius: 2 },
  wireBarActive: { backgroundColor: 'rgba(255,255,255,0.45)' },
  wireHead: { height: 5, width: '38%' },
  wireHero: { height: 22 },
  wireLine: { height: 4 },
  wireRow: { flexDirection: 'row', gap: 3, flex: 1 },
  wireCell: { flex: 1, height: '100%' },
  tick: { fontSize: 11 },

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
  // One continuous band rather than three separated squares: the three values
  // are a palette, and a palette is judged as a whole.
  swatchRow: {
    flexDirection: 'row',
    height: 44,
    borderRadius: 9,
    overflow: 'hidden',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.bentoLine,
  },
  swatchBand: { flex: 1 },
  // The one the shop is actually choosing -- ground and soft are both
  // near-white in every palette, and giving all three equal width made the
  // decision look like a choice between two whites.
  swatchBandAccent: { flex: 1.4 },
  swatchLabel: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, marginBottom: 2 },
  swatchLabelActive: { color: theme.bentoInk },
  swatchSuits: { fontSize: 10.5, color: theme.bentoMuted2 },
});
