import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SHOP_MAX_WIDTH, SPACE, TYPE } from '@/components/storefront/scale';
import {
  DIRECTORY_GAP, FeaturedShopCard, ShopDirectoryCard, directoryColumnsForWidth, featuredShop,
} from '@/components/storefront/shop-directory-card';
import { paletteColors } from '@/lib/storefront-catalog';
import {
  categoriesOf, citiesOf, inCategory, listPublicShops, searchShops,
} from '@/lib/storefront-directory';
import { padFinalRow } from '@/components/storefront/theme-shared';
import type { PublicShopSummary } from '@/types/models';

// /store -- the directory.
//
// THIS PAGE RENDERS IN ONE PALETTE AND IT IS NOT A SHOP'S. `ink` is the
// storefront's own default, so a customer moving from here into a shop meets
// the same surfaces, the same radii and the same pills; what changes is the
// shop's accent, which is exactly the thing that should change when you walk
// into somebody's shop. See ShopDirectoryCard on why eight shop palettes on
// one page would be eight brands rather than a list.
const colors = paletteColors('ink');


export default function StoreDirectoryScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const columns = directoryColumnsForWidth(width);
  // The city filter runs in the CLIENT, not as a refetch.
  //
  // The RPC takes a p_city and this deliberately does not use it: the whole
  // directory is one bounded read (100 rows, clamped in the function), the
  // chips are derived from those same rows, and filtering in memory means
  // tapping a chip is instant and cannot fail. Refetching per chip would put a
  // network round trip and a loading state behind a control whose entire job is
  // to narrow a list already on screen. `p_city` earns its place the day this
  // outgrows one page -- named here so the next person knows it is there.
  const [city, setCity] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'ready'; shops: PublicShopSummary[] }
  >({ status: 'loading' });

  // Bumped to retry. The effect below reads it and nothing else, so a retry is
  // a re-run of the same fetch rather than a second code path.
  const [attempt, setAttempt] = useState(0);

  // No synchronous setState in here: the initial state is already 'loading',
  // and the retry sets it back before bumping `attempt`. Calling setState in an
  // effect BODY schedules a second render before the first has painted, which
  // is what the react-hooks rule is warning about -- these two callbacks fire
  // from a settled promise, long after.
  useEffect(() => {
    let cancelled = false;
    listPublicShops()
      .then((shops) => { if (!cancelled) setState({ status: 'ready', shops }); })
      // UNLIKE THE SHOP PAGE, THIS ONE ADMITS THE FAILURE. A shop page collapses
      // a failed read into "no shop at this address" on purpose -- telling the
      // difference would confirm which slugs exist. The directory has no such
      // secret: it lists everything already, so "we couldn't load the shops"
      // leaks nothing and is the honest message, with a way to try again.
      .catch(() => { if (!cancelled) setState({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const shops = state.status === 'ready' ? state.shops : [];
  const cities = citiesOf(shops);
  // Search runs ON TOP of the city filter, not instead of it -- the same rule
  // the shop page's own search follows: a customer who has narrowed to Borama
  // and then types expects to be searching WITHIN Borama. Both ways out stay
  // visible, the chip row and the Clear button.
  const byCity = city ? shops.filter((s) => s.city?.trim().toLowerCase() === city.toLowerCase()) : shops;
  // Category narrows within the city, and search within both -- each control
  // composes with the ones above it rather than replacing them, so a customer
  // never loses a filter by using another.
  // Off the CITY-filtered list, so the chips only ever offer trades actually
  // present in the city on screen.
  const categories = categoriesOf(byCity);
  const shown = searchShops(inCategory(byCity, category), query);
  // Same padding as the product grid, for the same reason: a short final row
  // must leave a gap rather than inflating its cells to fill the width. See
  // padFinalRow in theme-shared.tsx.
  const cells = padFinalRow(shown, columns);
  // Off `shown`, not `shops`: a customer who has filtered to Borama or typed a
  // search should be shown the best of what they are looking at, not the best
  // of a page they are not.
  const featured = featuredShop(shown);

  const header = (
    <View>
      {/* THE DIRECTORY'S OWN NAV. /store sits at the app root, outside the
          (public) group, so it inherits none of the marketing chrome -- which
          left the page opening on a headline with no way back to anything and
          no way for a shopkeeper reading it to sign up. */}
      <View style={[styles.nav, { borderBottomColor: colors.hairline }]}>
        <Pressable
          testID="storefront-directory-home"
          accessibilityRole="link"
          onPress={() => router.push('/')}
          style={pressable(styles.brand)}
        >
          <View style={[styles.brandMark, { backgroundColor: colors.ink }]}>
            <Text style={[styles.brandMarkText, { color: colors.ground }]}>K</Text>
          </View>
          <Text style={[styles.brandName, { color: colors.ink }]}>Kaiibi</Text>
        </Pressable>
        <View style={styles.navSpacer} />
        <Pressable
          testID="storefront-directory-open-shop"
          accessibilityRole="link"
          onPress={() => router.push('/signup')}
          style={pressable([styles.navCta, { backgroundColor: colors.ink }])}
        >
          <Text style={[styles.navCtaText, { color: colors.ground }]} numberOfLines={1}>
            {width >= 560 ? 'Open your own shop' : 'Open a shop'}
          </Text>
        </Pressable>
      </View>

      {/* CENTRED, which is the design and was the thing most visibly wrong:
          a left-aligned hero over centred chips and a centred grid reads as
          two pages stacked. */}
      <View style={styles.hero}>
        <View style={[styles.heroTag, { backgroundColor: colors.ground }]}>
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Shops on Kaiibi</Text>
        </View>
        <Text style={[styles.title, width >= 720 && styles.titleWide, { color: colors.ink }]}>
          Buy from a real shop down the road
        </Text>
        <Text style={[styles.lede, { color: colors.muted }]}>
          Every shop here is a business someone runs in person. Browse what they have in today,
          order on WhatsApp, and pay when you collect.
        </Text>

        {/* ALWAYS RENDERED, and the minimum that used to gate it is gone.
            It was borrowed from shouldOfferSearch on the shop page, where a
            search sits above a grid and genuinely earns its place by count.
            Here it is part of the HERO -- the composition is tag, headline,
            lede, field -- so hiding it below a threshold does not simplify the
            page, it breaks it, which is exactly what a two-shop directory
            showed. A field over two shops is redundant; a hero with a hole in
            it is broken, and redundant beats broken. */}
        <View style={[styles.searchRow, { backgroundColor: colors.ground, borderColor: colors.edge }]}>
          <Text style={[styles.searchIcon, { color: colors.muted }]}>🔍</Text>
          <TextInput
            testID="storefront-directory-search"
            accessibilityLabel={`Search ${shops.length} shops`}
            placeholder="Search shops, or a city"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={[styles.search, { color: colors.ink }]}
          />
          {/* The design puts a Search button here. It does NOT submit anything
              -- the list filters as you type, so there is nothing to submit --
              so the slot carries Clear instead, which is the control this
              actually needs and the one a filter with no visible way out is
              missing. Rendered only while there is something to clear. */}
          {query.length > 0 ? (
            <Pressable
              testID="storefront-directory-search-clear"
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => setQuery('')}
              style={pressable([styles.searchClear, { backgroundColor: colors.ink }])}
            >
              <Text style={[styles.searchClearText, { color: colors.ground }]}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Only once there is a choice to make -- one city is a filter to
          everything, which is the rule CategoryBand already applies. */}
      {cities.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <CityChip label="All cities" active={city === null} onPress={() => { setCity(null); setCategory(null); }} />
          {cities.map((name) => (
            <CityChip
              key={name}
              label={name}
              active={city === name}
              // The category chips are derived from the CITY-filtered list, so
              // a trade that exists in Hargeisa and not in Borama would leave
              // the page filtered to a chip that is no longer on it. Clearing
              // is the honest move: changing city is choosing a new list.
              onPress={() => { setCity(name); setCategory(null); }}
            />
          ))}
        </ScrollView>
      ) : null}

      {categories.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <CityChip label="Everything" active={category === null} onPress={() => setCategory(null)} />
          {categories.map((name) => (
            <CityChip
              key={name}
              label={name}
              active={category === name}
              onPress={() => setCategory(name)}
              testIDPrefix="storefront-directory-category"
            />
          ))}
        </ScrollView>
      ) : null}

      {/* Leads the grid rather than sitting in it: a double-width cell inside a
          FlatList would have to fight numColumns at every breakpoint, and the
          featured shop is also the first row of the grid below -- so it is a
          header, and the grid still contains it. Deliberately NOT removed from
          the list underneath: a customer scanning alphabetically should still
          find it where they expect. */}
      {featured ? (
        <View style={styles.featureWrap}>
          <FeaturedShopCard
            shop={featured}
            colors={colors}
            wide={columns > 1}
            onPress={(slug) => router.push(`/store/${slug}`)}
          />
        </View>
      ) : null}

      {shown.length > 0 ? (
        <View style={[styles.rowHead, { borderBottomColor: colors.hairline }]}>
          <View style={styles.rowHeadLeft}>
            <Text style={[styles.rowHeadTitle, { color: colors.ink }]}>
              {shown.length} {shown.length === 1 ? 'shop' : 'shops'}
              {city ? ` in ${city}` : ''}{category ? ` · ${category}` : ''}
            </Text>
            <Text style={[styles.rowHeadSub, { color: colors.muted }]}>
              Shops with the most in stock first.
            </Text>
          </View>
          {/* The design says "Sorted by · Open now". It is not: the server
              cannot know what time it is where the reader is standing (local
              wall-clock hours, no timezone), so ordering by openness would
              disagree with the badges on the cards. This says what the order
              actually is. */}
          <Text style={[styles.rowHeadSort, { color: colors.muted }]}>Sorted by · Stock</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.soft }}>
      <DirectoryHead />
      <FlatList
        testID="storefront-directory"
        data={cells}
        key={columns}
        numColumns={columns}
        keyExtractor={(shop, i) => shop?.slug ?? `pad-${i}`}
        columnWrapperStyle={columns > 1 ? styles.row : undefined}
        contentContainerStyle={styles.grid}
        style={styles.scroller}
        ListHeaderComponent={header}
        ListEmptyComponent={
          state.status === 'loading' ? (
            <DirectorySkeleton columns={columns} />
          ) : state.status === 'failed' ? (
            <Empty
              title="We couldn't load the shops."
              body="Check your connection and try again."
              actionLabel="Try again"
              onAction={retry}
            />
          ) : query.trim() ? (
            <Empty
              title={`Nothing matches “${query.trim()}”.`}
              body="Try a shorter word, or the name of a city."
              actionLabel="Clear search"
              onAction={() => setQuery('')}
            />
          ) : (
            // THERE IS DELIBERATELY NO "no shops in <city>" EMPTY STATE, and
            // that is a consequence of deriving the chips rather than an
            // omission. Every chip comes from a shop that is in `shops`, so
            // filtering by one always leaves at least that shop -- the branch
            // could not be reached, and an unreachable empty state is a screen
            // nobody can test and everybody has to maintain.
            //
            // It comes back the day the filter becomes a refetch on the RPC's
            // `p_city` (see the note on `city` above), because then the list
            // and the chips can genuinely disagree.
            <Empty
              title="No shops are open yet."
              body="The first ones are being set up. Check back shortly."
            />
          )
        }
        // Closes the page, the same way ShopFooter closes a shop's. Only once
        // there are shops: under a "no shops yet" card it would be chrome
        // wrapped around an apology.
        ListFooterComponent={shown.length > 0
          ? <DirectoryFooter wideHow={columns > 1} onOpenShop={() => router.push('/signup')} />
          : null}
        renderItem={({ item }) => (
          <View style={styles.cell}>
            {item ? (
              <ShopDirectoryCard
                shop={item}
                colors={colors}
                onPress={(slug) => router.push(`/store/${slug}`)}
              />
            ) : null}
          </View>
        )}
      />
    </View>
  );
}

// HOW IT WORKS, and then the sign-off. Both are static: this page has no
// account, no basket and no checkout of its own, and saying so plainly is what
// stops a customer looking for a cart that is not there.
function DirectoryFooter({ wideHow, onOpenShop }: { wideHow: boolean; onOpenShop: () => void }) {
  return (
    <View testID="storefront-directory-footer">
      <View style={styles.howBand}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>How it works</Text>
        <Text style={[styles.howTitle, { color: colors.ink }]}>Three steps, no account</Text>
        <View style={[styles.howRow, wideHow && styles.howRowWide]}>
          {HOW_IT_WORKS.map((step) => (
            <View
              key={step.title}
              style={[styles.howCard, wideHow && styles.howCardWide, { backgroundColor: colors.ground }]}
            >
              <Text style={[styles.howCardTitle, { color: colors.ink }]}>{step.title}</Text>
              <Text style={[styles.howCardBody, { color: colors.muted }]}>{step.body}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={[styles.footer, { backgroundColor: colors.ink }]}>
        <Text style={[styles.footerMark, { color: colors.ground }]}>Kaiibi</Text>
        <Text style={[styles.footerLine, { color: colors.onDarkMuted }]}>
          Prices in USD · Pay on collection
        </Text>
        <Pressable
          testID="storefront-directory-footer-cta"
          accessibilityRole="link"
          onPress={onOpenShop}
          style={pressable([styles.footerCta, { backgroundColor: colors.ground }])}
        >
          <Text style={[styles.footerCtaText, { color: colors.ink }]}>Open your own shop</Text>
        </Pressable>
      </View>
    </View>
  );
}

const HOW_IT_WORKS = [
  { title: 'Find a shop near you', body: 'Filter by city, or search for what you need.' },
  { title: 'Order what is in today', body: 'Stock is what the shop actually has on the shelf, not a catalogue.' },
  { title: 'Pay on collection', body: 'Nothing is charged online. You pay the shop when you take it.' },
];

// One chip, two rows. The city row and the category row are the same control
// doing the same job on a different axis, so they are the same component --
// only the testID prefix differs, and only so a test can tell which row it is
// pressing.
function CityChip({
  label, active, onPress, testIDPrefix = 'storefront-directory-city',
}: { label: string; active: boolean; onPress: () => void; testIDPrefix?: string }) {
  return (
    <Pressable
      testID={`${testIDPrefix}-${label}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={pressable([
        styles.chip,
        // Bounded either way, for the reason CategoryBand's pills are: an
        // unselected chip is `ground` on `soft`, which is 1.04:1 on this
        // palette and so has no edge at all. The selected chip borders in its
        // own fill so the row does not shift by 2px when one is tapped.
        active
          ? { backgroundColor: colors.ink, borderColor: colors.ink }
          : { backgroundColor: colors.ground, borderColor: colors.edge },
      ])}
    >
      <Text style={[styles.chipText, { color: active ? colors.ground : colors.muted }]}>{label}</Text>
    </Pressable>
  );
}

// A shape, not a spinner -- the same argument storefront-skeleton.tsx makes for
// the shop page: this is the slowest moment in the flow, and a shape says what
// is coming.
function DirectorySkeleton({ columns }: { columns: number }) {
  return (
    <View testID="storefront-directory-skeleton" style={styles.skeletonWrap}>
      {Array.from({ length: columns * 2 }).map((_, i) => (
        <View key={i} style={[styles.skeletonCell, { width: `${100 / columns}%` }]}>
          <View style={[styles.skeleton, { backgroundColor: colors.ground }]}>
            <View style={[styles.skeletonPhoto, { backgroundColor: colors.soft }]} />
            <View style={[styles.skeletonLine, { backgroundColor: colors.soft }]} />
            <View style={[styles.skeletonLine, styles.skeletonShort, { backgroundColor: colors.soft }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

// NEVER A DEAD END. Every empty here carries the way out of itself, which is
// the rule EmptyState and NoSearchResults already follow on the shop page.
function Empty({
  title, body, actionLabel, onAction,
}: { title: string; body: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View testID="storefront-directory-empty" style={[styles.empty, { backgroundColor: colors.ground }]}>
      <Text style={[styles.emptyTitle, { color: colors.ink }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>{body}</Text>
      {actionLabel && onAction ? (
        <Pressable
          testID="storefront-directory-empty-action"
          accessibilityRole="button"
          onPress={onAction}
          style={pressable([styles.emptyAction, { backgroundColor: colors.ink }])}
        >
          <Text style={[styles.emptyActionText, { color: colors.ground }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Web only, and for the reason StorefrontHead in [slug].tsx spells out at
// length: on iOS `expo-router/head` is Apple Handoff, and it throws during
// render because app.json registers the router plugin without an `origin`.
// Unlike that one this page has nothing to hide -- it lists every published
// shop by design -- so there is no leak to weigh, only the crash.
function DirectoryHead() {
  if (Platform.OS !== 'web') return null;
  const title = 'Shops on Kaiibi';
  const description = 'Browse shops near you and order straight from them.';
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content="website" />
    </Head>
  );
}

const styles = StyleSheet.create({
  // The reading column, centred, with the page tone running edge to edge behind
  // it -- the same split every theme's scroller makes.
  scroller: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  grid: { padding: SPACE.page, paddingBottom: 48, gap: DIRECTORY_GAP },
  row: { gap: DIRECTORY_GAP },
  cell: { flex: 1 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch',
    marginTop: 24, borderWidth: 1, borderRadius: RADIUS.pill,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 6,
  },
  searchIcon: { fontSize: 15 },
  search: { flex: 1, paddingVertical: 10, fontSize: TYPE.body + 1.5 },
  searchClear: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11 },
  searchClearText: { fontSize: 12.5, fontWeight: '800' },

  featureWrap: { paddingBottom: 4 },

  nav: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: 14, paddingBottom: 14, borderBottomWidth: 1,
  },
  navSpacer: { flex: 1 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { fontSize: 15, fontWeight: '800' },
  brandName: { fontSize: 18, fontWeight: '800', letterSpacing: LETTER.displayLoud },
  navCta: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11 },
  navCtaText: { fontSize: 13, fontWeight: '800' },

  // Centred, and bounded independently of the grid: a 1,080px measure is right
  // for a row of cards and far too wide for a sentence.
  hero: { paddingTop: 40, paddingBottom: 26, alignItems: 'center', alignSelf: 'center', maxWidth: 640, width: '100%' },
  heroTag: { borderRadius: RADIUS.pill, paddingHorizontal: 14, paddingVertical: 7 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  title: {
    fontFamily: DISPLAY_FONT, fontSize: 30, lineHeight: 35, fontWeight: '700',
    letterSpacing: LETTER.displayLoud, marginTop: 16, textAlign: 'center',
  },
  titleWide: { fontSize: 40, lineHeight: 45 },
  lede: { fontSize: TYPE.body + 1.5, lineHeight: 23, marginTop: 14, textAlign: 'center' },

  chips: { flexDirection: 'row', gap: 8, paddingBottom: 6, paddingRight: SPACE.page },
  chip: { borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1 },
  chipText: { fontSize: 12.5, fontWeight: '800' },

  rowHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, flexWrap: 'wrap',
    paddingTop: 24, paddingBottom: 12, marginBottom: 2, borderBottomWidth: 1,
  },
  rowHeadLeft: { flexShrink: 1 },
  rowHeadTitle: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  rowHeadSub: { fontSize: TYPE.body, marginTop: 4 },
  rowHeadSort: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },

  skeletonWrap: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -DIRECTORY_GAP / 2 },
  skeletonCell: { paddingHorizontal: DIRECTORY_GAP / 2, paddingBottom: DIRECTORY_GAP },
  skeleton: { borderRadius: RADIUS.card, padding: 12 },
  skeletonPhoto: { aspectRatio: 16 / 10, borderRadius: RADIUS.inset },
  skeletonLine: { height: 11, borderRadius: 6, marginTop: 14, marginHorizontal: 6 },
  skeletonShort: { width: '52%', height: 9, marginTop: 9 },

  howBand: { paddingTop: 40, paddingBottom: 8, gap: 12 },
  howTitle: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  // Column at every width. Three cards of prose side by side at 390px is three
  // columns of two words -- and this band is a footnote, not the page.
  howRow: { gap: DIRECTORY_GAP, marginTop: 8 },
  howRowWide: { flexDirection: 'row', alignItems: 'stretch' },
  howCardWide: { flex: 1 },
  howCard: { borderRadius: RADIUS.card, padding: SPACE.card },
  howCardTitle: { fontSize: 15.5, fontWeight: '800', letterSpacing: -0.2 },
  howCardBody: { fontSize: TYPE.body, lineHeight: 19, marginTop: 6 },

  footer: { borderRadius: RADIUS.card, padding: SPACE.card, marginTop: 32 },
  footerMark: { fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: '700', letterSpacing: LETTER.display },
  footerLine: { fontSize: TYPE.metaSmall + 1, marginTop: 8 },
  footerCta: { borderRadius: RADIUS.pill, paddingHorizontal: 20, paddingVertical: 12, alignSelf: 'flex-start', marginTop: 18 },
  footerCtaText: { fontSize: 13, fontWeight: '800' },

  empty: { borderRadius: RADIUS.card, paddingVertical: 46, paddingHorizontal: 24, alignItems: 'center' },
  emptyTitle: { fontSize: 17, fontWeight: '800', letterSpacing: LETTER.display, textAlign: 'center' },
  emptyBody: { fontSize: TYPE.body, lineHeight: 19, marginTop: 8, textAlign: 'center', maxWidth: 340 },
  emptyAction: { borderRadius: RADIUS.pill, paddingHorizontal: 20, paddingVertical: 11, marginTop: 18 },
  emptyActionText: { fontSize: 13, fontWeight: '800' },
});
