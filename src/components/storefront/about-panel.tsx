import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { ShopCard } from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import { collectLocation } from '@/lib/storefront-collect';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// The About tab.
//
// Most of it is composed from what the shop has already filled in elsewhere:
// the story is `storefronts.about`, the figures are counted from the products,
// categories and areas the route already fetches, and every FAQ answer is
// derived from `offers_delivery`, `payment_mode` and the area list.
//
// Three blocks are the shop's own: the "why shop here" cards
// (`storefront_highlights`), the year it opened (`storefronts.trading_since`)
// and the photographs. All are optional and all render as NOTHING when unset --
// the rule every block on this page follows.
//
// The gallery (`storefront_images`, 20261024000000) is the third, and the story
// simply runs full width when a shop has uploaded none -- a placeholder square
// is the one thing this page has never done.

// ─────────────────────────────────────────────────────────────────────────────
// THE FAQ, AND WHY IT IS GENERATED RATHER THAN TYPED
//
// "How do I pay" and "do you deliver to me" are the two questions that stop a
// stranger ordering, and both already have exact answers in the database. Asking
// a shopkeeper to re-type them into a free-text FAQ would create a second copy
// that goes stale the moment they change a delivery fee -- and the stale copy is
// the one the customer reads.
//
// So the shop writes none of this. Every entry below is derived, and an entry
// with nothing true to say is not produced at all.
// ─────────────────────────────────────────────────────────────────────────────
export type ShopQuestion = { id: string; q: string; a: string };

export function shopQuestions(
  storefront: PublicStorefront,
  areas: PublicDeliveryArea[],
): ShopQuestion[] {
  const questions: ShopQuestion[] = [];
  const where = collectLocation(
    storefront.collectAddress, storefront.collectNeighborhood, storefront.city,
  );

  // `payment_mode` is the single literal 'on_collection' today, so this is a
  // fixed sentence rather than a branch -- and it is worth printing precisely
  // because "do I have to pay now?" is why a stranger hesitates. The second
  // clause is added only where there is a delivery to pay on.
  questions.push({
    id: 'pay',
    q: 'How do I pay?',
    a: storefront.offersDelivery
      ? 'On collection, or to the shop when your delivery arrives. Nothing is charged when you place the order.'
      : 'On collection, when you pick the order up. Nothing is charged when you place the order.',
  });

  if (storefront.offersDelivery && areas.length > 0) {
    // Named from the CHEAPEST area for the same reason CollectingCard is: a
    // customer deciding whether to order wants the number, and the cheapest is
    // the only one true for at least somebody.
    const cheapest = Math.min(...areas.map((a) => a.feeCents));
    const price = cheapest === 0 ? 'free' : `from ${formatCents(cheapest)}`;
    questions.push({
      id: 'delivery',
      q: 'Do you deliver to me?',
      a: `We deliver to ${areas.length} ${areas.length === 1 ? 'area' : 'areas'}, ${price}. `
        + 'The full list with fees is on the Visit tab.',
    });
  } else {
    questions.push({
      id: 'delivery',
      q: 'Do you deliver?',
      a: 'Not at the moment — orders are for collection from the shop.',
    });
  }

  if (where) {
    questions.push({
      id: 'collect',
      q: 'Where do I collect from?',
      a: `${where}. Choose collection at checkout and pick your order up any time we are open.`,
    });
  }

  // Only offered where there is a number to ask on -- the same rule
  // WhatsAppButton and ProductActions follow: lose the answer rather than
  // print one that sends the customer nowhere.
  if (storefront.whatsappE164) {
    questions.push({
      id: 'stock',
      q: 'What if something is out of stock?',
      a: 'Sold-out items stay on the page with an Ask button rather than disappearing. '
        + 'Message us and we will tell you when it is back in.',
    });
  }

  return questions;
}

function Accordion({ colors, questions }: { colors: PaletteColors; questions: ShopQuestion[] }) {
  // One open at a time and the first open on load, matching the landing page's
  // own accordion. `openId` rather than an index so the identity survives a
  // question being added or dropped by the rules above.
  const [openId, setOpenId] = useState<string | null>(questions[0]?.id ?? null);

  return (
    <View style={styles.faq}>
      {questions.map((item) => {
        const open = item.id === openId;
        return (
          <View key={item.id} style={[styles.q, { backgroundColor: colors.ground }]}>
            <Pressable
              testID={`storefront-faq-${item.id}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setOpenId(open ? null : item.id)}
              style={pressable(styles.qHead)}
            >
              <Text style={[styles.qText, { color: colors.ink }]}>{item.q}</Text>
              {/* The glyph swaps rather than rotating: a rotated "+" reads as a
                  cross to a sighted user and still announces as "+", so the
                  expanded state above is what actually carries the meaning --
                  and RN has no CSS transition to make the rotation worth it. */}
              <Text style={[styles.qMark, { color: colors.muted }]}>{open ? '−' : '+'}</Text>
            </Pressable>
            {open ? (
              <Text testID={`storefront-faq-answer-${item.id}`} style={[styles.qBody, { color: colors.muted }]}>
                {item.a}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Stat({ colors, value, label }: { colors: PaletteColors; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.ink }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text>
    </View>
  );
}

export function AboutPanel({
  storefront, products, categories, areas, colors, wide,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  categories: StorefrontCategory[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
}) {
  const questions = shopQuestions(storefront, areas);
  // Counted, never stored. Three cells at most, and a cell with nothing to
  // count is not rendered -- a shop with no categories should not be told it
  // has zero of them.
  const stats: { value: string; label: string }[] = [];
  // Leads the strip when there is one, because it is the only figure here that
  // is not derivable from the page a customer is already looking at -- and the
  // one that answers "have these people been doing this a while".
  if (storefront.tradingSince) {
    stats.push({ value: String(storefront.tradingSince), label: 'trading since' });
  }
  stats.push({
    value: String(products.length),
    label: products.length === 1 ? 'item listed' : 'items listed',
  });
  if (categories.length > 0) {
    stats.push({
      value: String(categories.length),
      label: categories.length === 1 ? 'category' : 'categories',
    });
  }
  if (areas.length > 0) {
    stats.push({
      value: String(areas.length),
      label: areas.length === 1 ? 'delivery area' : 'delivery areas',
    });
  }
  // Four cells is 90px each on a 390px phone, which is narrower than the
  // figures they hold. The strip keeps the first three at that width -- and the
  // order above is deliberate, so what gets dropped is always the least
  // interesting of them rather than whichever happened to be last.
  const shownStats = wide ? stats : stats.slice(0, 3);

  return (
    // NOT `styles.panel`'s padding any more: the story band is filled with
    // `ground` and has to run edge to edge, so the gutter moves inside each
    // band. See `bandFill` below on why exactly one band changes tone.
    <View testID="storefront-about-panel">
      <View style={[styles.band, styles.bandFill, styles.gutter, { backgroundColor: colors.ground }]}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>About the shop</Text>
        {/* The headline leads here, where it is the subject of the tab, rather
            than competing with the wordmark as it does on the anchor card. A
            shop with no headline leads with the story itself. */}
        {storefront.headline ? (
          <Text
            testID="storefront-about-headline"
            style={[styles.title, wide && styles.titleWide, { color: colors.ink }]}
          >
            {storefront.headline}
          </Text>
        ) : null}
        {/* `about` is what gates this whole tab (see availableTabs), so it is
            always present by the time this renders. */}
        <Text testID="storefront-about-story" style={[styles.story, { color: colors.muted }]}>
          {storefront.about}
        </Text>

        {/* THE GALLERY, and it is a row of what the shop actually uploaded --
            never a grid with holes in it. The design draws one wide photo above
            two squares; that is what a shop with three gets. A shop with one
            gets one wide photo, because a lone square beside two gaps is a
            layout accident rather than a gallery. */}
        {storefront.images.length > 0 ? (
          <View style={styles.gallery} testID="storefront-about-gallery">
            <Image
              source={{ uri: storefront.images[0].url! }}
              style={[styles.galleryLead, { backgroundColor: colors.soft }]}
              resizeMode="cover"
            />
            {storefront.images.length > 1 ? (
              <View style={styles.galleryRest}>
                {storefront.images.slice(1).map((image) => (
                  <Image
                    key={image.id}
                    testID={`storefront-about-photo-${image.id}`}
                    source={{ uri: image.url! }}
                    style={[styles.gallerySquare, { backgroundColor: colors.soft }]}
                    resizeMode="cover"
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={styles.gutter}>
      <ShopCard colors={colors} style={styles.strip} testID="storefront-about-stats">
        {shownStats.map((stat, index) => (
          <View
            key={stat.label}
            style={[
              styles.statCell,
              // A rule between cells, not around them -- and never after the
              // last, which would be a line drawn against the card's own edge.
              index < shownStats.length - 1 && { borderRightWidth: 1, borderRightColor: colors.hairline },
            ]}
          >
            <Stat colors={colors} value={stat.value} label={stat.label} />
          </View>
        ))}
      </ShopCard>
      </View>

      {/* WHY SHOP HERE. Up to three claims the shop wrote itself; the whole
          band is absent when it has written none, which is the rule every
          optional block on this page follows. One or two render at that count
          rather than padding out to three with blanks. */}
      {storefront.highlights.length > 0 ? (
        <View style={[styles.band, styles.gutter]} testID="storefront-about-highlights">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Why shop here</Text>
          <View style={[styles.highlights, wide && styles.highlightsWide]}>
            {storefront.highlights.map((highlight) => (
              <ShopCard
                key={highlight.id}
                colors={colors}
                style={wide ? styles.highlightWide : undefined}
                testID={`storefront-about-highlight-${highlight.id}`}
              >
                <Text style={[styles.highlightTitle, { color: colors.ink }]}>{highlight.title}</Text>
                <Text style={[styles.highlightBody, { color: colors.muted }]}>{highlight.body}</Text>
              </ShopCard>
            ))}
          </View>
        </View>
      ) : null}

      <View style={[styles.band, styles.gutter, styles.lastBand]}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>Before you order</Text>
        <Accordion colors={colors} questions={questions} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: SPACE.page, gap: SPACE.cardGap },
  gutter: { paddingHorizontal: SPACE.page },
  band: { gap: 12, paddingTop: SPACE.page, paddingBottom: 4 },
  lastBand: { paddingBottom: SPACE.page },
  // THE ONE BAND THAT CHANGES TONE, and only one.
  //
  // The page is `soft` and cards are `ground`; on the ink palette those sit 3%
  // apart, so a band that merely alternates changes nothing you can see. What
  // reads is a FULL-BLEED fill, and it only works on a band carrying no cards:
  // a `ground` card on a `ground` band is not a card, which is the whole basis
  // of the surface system. The story band is the only one here made of type
  // alone, so it is the only one that gets this.
  bandFill: { paddingBottom: SPACE.page, marginBottom: SPACE.cardGap },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  title: {
    fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 31, fontWeight: '700',
    letterSpacing: LETTER.displayLoud,
  },
  titleWide: { fontSize: 34, lineHeight: 39 },
  story: { fontSize: TYPE.body + 1, lineHeight: 22 },
  gallery: { gap: SPACE.gap, marginTop: 6 },
  galleryLead: { width: '100%', aspectRatio: 16 / 9, borderRadius: RADIUS.inset },
  // Wraps, so four or five photographs fill rows instead of shrinking to fit
  // one. `flexBasis` rather than a fixed width: two per row on a phone, more on
  // a laptop, with no breakpoint to keep in step.
  galleryRest: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.gap },
  gallerySquare: { flexGrow: 1, flexBasis: 140, aspectRatio: 1, borderRadius: RADIUS.inset },

  strip: { flexDirection: 'row', paddingVertical: 18, paddingHorizontal: 0 },
  statCell: { flex: 1, paddingHorizontal: SPACE.card },
  stat: { gap: 4 },
  statValue: { fontSize: 28, fontWeight: '800', letterSpacing: -1, ...TABULAR },
  statLabel: { fontSize: 12, lineHeight: 15 },

  // Stacked on a phone and a row of three on a laptop. NOT a wrapping grid:
  // three cards of different copy lengths wrap into a ragged second row at
  // exactly the widths this page is most read at.
  highlights: { gap: SPACE.cardGap },
  highlightsWide: { flexDirection: 'row', alignItems: 'stretch' },
  highlightWide: { flex: 1 },
  highlightTitle: { fontSize: TYPE.body + 2.5, fontWeight: '800', letterSpacing: LETTER.display },
  highlightBody: { fontSize: TYPE.body, lineHeight: 20, marginTop: 7 },

  faq: { gap: 8 },
  q: { borderRadius: RADIUS.inset, overflow: 'hidden' },
  qHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 14, paddingHorizontal: 18, paddingVertical: 15,
  },
  qText: { flex: 1, fontSize: TYPE.body + 0.5, fontWeight: '700', letterSpacing: LETTER.display },
  qMark: { fontSize: 18, fontWeight: '700' },
  qBody: { fontSize: TYPE.body, lineHeight: 20, paddingHorizontal: 18, paddingBottom: 17 },
});
