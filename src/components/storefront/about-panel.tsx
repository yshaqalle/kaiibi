import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { ShopCard } from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import { collectLocation } from '@/lib/storefront-collect';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// The About tab, built entirely from what the shop has ALREADY filled in.
//
// Nothing here reads a column that does not exist yet. The story is
// `storefronts.about`, the figures are counted from the products, categories
// and areas the route already fetches, and every answer in the FAQ is composed
// from `offers_delivery`, `payment_mode` and the area list. The gallery,
// highlight cards and "trading since" in the mockup are the parts that need new
// tables, and they are deliberately absent rather than stubbed -- a placeholder
// square is the one thing this page has never done.

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
  const stats: { value: string; label: string }[] = [
    { value: String(products.length), label: products.length === 1 ? 'item listed' : 'items listed' },
  ];
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

  return (
    <View style={styles.panel} testID="storefront-about-panel">
      <View style={styles.band}>
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
      </View>

      <ShopCard colors={colors} style={styles.strip} testID="storefront-about-stats">
        {stats.map((stat, index) => (
          <View
            key={stat.label}
            style={[
              styles.statCell,
              // A rule between cells, not around them -- and never after the
              // last, which would be a line drawn against the card's own edge.
              index < stats.length - 1 && { borderRightWidth: 1, borderRightColor: colors.hairline },
            ]}
          >
            <Stat colors={colors} value={stat.value} label={stat.label} />
          </View>
        ))}
      </ShopCard>

      <View style={styles.band}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>Before you order</Text>
        <Accordion colors={colors} questions={questions} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: SPACE.page, gap: SPACE.cardGap },
  band: { gap: 12 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  title: {
    fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 31, fontWeight: '700',
    letterSpacing: LETTER.displayLoud,
  },
  titleWide: { fontSize: 34, lineHeight: 39 },
  story: { fontSize: TYPE.body + 1, lineHeight: 22 },

  strip: { flexDirection: 'row', paddingVertical: 18, paddingHorizontal: 0 },
  statCell: { flex: 1, paddingHorizontal: SPACE.card },
  stat: { gap: 4 },
  statValue: { fontSize: 28, fontWeight: '800', letterSpacing: -1, ...TABULAR },
  statLabel: { fontSize: 12, lineHeight: 15 },

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
