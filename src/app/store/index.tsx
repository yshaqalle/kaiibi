import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, KAIIBI_MARK_ASPECT, LETTER, RADIUS, SPACE, TOUCH_TARGET, TYPE } from '@/components/storefront/scale';
import {
  DIRECTORY_GAP, DIRECTORY_MAX_WIDTH, FeaturedShopCard, ShopDirectoryCard,
  directoryColumnsForWidth, featuredShop,
} from '@/components/storefront/shop-directory-card';
import { KAIIBI_BLUE, KAIIBI_INK, paletteColors } from '@/lib/storefront-catalog';
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
  // Off `shown`, not `shops`: a customer who has filtered to Borama or typed a
  // search should be shown the best of what they are looking at, not the best
  // of a page they are not.
  const featured = featuredShop(shown);
  // NOT `shown` -- `featuredShop` always picks `shown[0]` (the RPC sorts by
  // stock, so the lead and the grid's first slot are always the same shop),
  // and rendering it twice within ~90px said its name and photo twice in a
  // row, once as the hero and once again as grid card #1 -- a screen reader
  // gets the name twice back to back. Sliced off the FRONT rather than
  // filtered by slug: the lead is always position 0 when it exists at all.
  const gridShops = featured ? shown.slice(1) : shown;
  // Same padding as the product grid, for the same reason: a short final row
  // must leave a gap rather than inflating its cells to fill the width. See
  // padFinalRow in theme-shared.tsx.
  const cells = padFinalRow(gridShops, columns);

  const header = (
    <View>
      {/* ONE MASTHEAD, not a nav row with a hero bolted under it. The nav used
          to carry an ink "K" plate and the wordmark, and the hero immediately
          below it opened on an eyebrow pill ("Shops on Kaiibi"), a serif
          headline ("Buy from a real shop down the road") and a two-sentence
          lede -- which said "kaiibi" twice within 120px, the same repetition
          defect the Phase 2 whole-branch review found when one page said
          "collection" three times. On kaiibi's OWN front door there is
          nothing else to name: the WORDMARK is the headline, so the pill, the
          headline and the lede all go, and what is left is the lockup, one
          line of promise, and the search -- directly under it, because a
          customer who now knows whose page this is has exactly one question
          left, "can I find my shop", and the field is the answer.
          `/store` sits at the app root, outside the (public) group, so it
          inherits none of the marketing chrome -- which is why the lockup
          still needs to be a link home and the CTA still needs to be here;
          neither has anywhere else to live.
          NOT painted `ground` the way the mockup's `.dmast` is: this View sits
          inside the FlatList's own padded content area (`styles.grid`'s
          `padding: SPACE.page`), so a fill here would be a floating white
          rectangle inset from the screen's edges, not the edge-to-edge band
          the mockup shows. Matching that would mean the masthead owning its
          own full-bleed layer above the FlatList -- a real change this task's
          three deltas do not ask for -- so it stays on the page's own tone,
          which is what every other band on this page (chips, the row head)
          already does. */}
      <View testID="storefront-directory-masthead" style={[styles.masthead, { borderBottomColor: colors.hairline }]}>
        <View style={styles.mastheadRow}>
          <Pressable
            testID="storefront-directory-home"
            accessibilityRole="link"
            onPress={() => router.push('/')}
            style={pressable(styles.lockup)}
          >
            {/* THE ONE OTHER PLACE THIS PAGE TURNS KAIIBI BLUE. Every shop's
                page wears that shop's own accent; this page wears none --
                it's `ink` throughout, see the note atop this file -- except
                here, where the plate is carrying kaiibi's own mark rather
                than a shop's, and the selected filter chip below, where the
                same argument applies to a choice the customer just made. */}
            <View testID="storefront-directory-mark" style={[styles.mark, { backgroundColor: KAIIBI_BLUE }]}>
              <Image
                source={require('@/assets/images/kaiibi-mark-white.png')}
                style={styles.markImage}
                accessibilityIgnoresInvertColors
              />
            </View>
            <Text style={[styles.wordmark, { color: colors.ink }]}>Kaiibi</Text>
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

        <Text testID="storefront-directory-promise" style={[styles.promise, { color: colors.muted }]}>
          Every shop, one place. Order ahead, collect in town.
        </Text>

        {/* ALWAYS RENDERED, and the minimum that used to gate it is gone.
            It was borrowed from shouldOfferSearch on the shop page, where a
            search sits above a grid and genuinely earns its place by count.
            Here it is part of the MASTHEAD -- the composition is lockup,
            promise, field -- so hiding it below a threshold does not simplify
            the page, it breaks it, which is exactly what a two-shop directory
            showed. A field over two shops is redundant; a masthead with a
            hole in it is broken, and redundant beats broken. */}
        <View style={[styles.searchRow, { backgroundColor: colors.ground, borderColor: colors.edge }]}>
          {/* The shop page's own glyph (`theme-shared.tsx`'s `SearchField`),
              not a full-colour emoji -- Task 18 stripped this masthead back
              to a wordmark, a line and a field, so 🔍 was left as the
              loudest, only full-colour glyph on kaiibi's own front door, on
              a page whose header comment claims a customer moving into a
              shop "meets the same surfaces". Hidden from screen readers for
              the same reason SearchField's own copy is: the TextInput's own
              accessibilityLabel already says what to search. */}
          <Text
            style={[styles.searchIcon, { color: colors.muted }]}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            ⌕
          </Text>
          <TextInput
            testID="storefront-directory-search"
            // Names what changed underneath it: the haystack now includes
            // every shop's stocked categories (searchShops,
            // storefront-directory.ts), not just its name, city and blurb --
            // so the label should say "shops" AND what they sell, not "shops"
            // alone.
            accessibilityLabel={`Search ${shops.length} shops, or what they sell`}
            placeholder="Find a shop — or a thing they sell…"
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
          <CityChip
            label="All cities"
            active={city === null}
            neutralWhenActive
            onPress={() => { setCity(null); setCategory(null); }}
          />
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
          <CityChip label="Everything" active={category === null} neutralWhenActive onPress={() => setCategory(null)} />
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
          FlatList would have to fight numColumns at every breakpoint, so this
          renders as a header instead. REMOVED from the grid below (`gridShops`
          above) rather than left in it -- the RPC sorts by stock and
          `featuredShop` always takes `shown[0]`, so the lead and the grid's
          own first card were always the SAME shop: same photo, same name,
          stated twice within about 90px of scroll, and announced twice back
          to back to a screen reader. There is no alphabetical scan for the
          duplicate to serve -- the order here is stock, not the alphabet. */}
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

      {gridShops.length > 0 ? (
        <View style={[styles.rowHead, { borderBottomColor: colors.hairline }]}>
          <View style={styles.rowHeadLeft}>
            {/* `gridShops.length`, not `shown.length`: this header sits
                directly above the grid, so its count has to agree with the
                cards a customer can actually count below it -- when the lead
                is showing above, it is one of the two lists on screen, not
                both, and `shown.length` would over-count by exactly the one
                shop already named in the hero. */}
            <Text style={[styles.rowHeadTitle, { color: colors.ink }]}>
              {gridShops.length} {gridShops.length === 1 ? 'shop' : 'shops'}
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
        renderItem={({ item, index }) => (
          <View style={styles.cell}>
            {item ? (
              <ShopDirectoryCard
                shop={item}
                colors={colors}
                // FlatList's own flat index across `cells` -- padding cells
                // included, though they never render a card to receive it --
                // is what lets directoryEntranceDelay (shop-directory-card.tsx)
                // stagger the grid by position rather than every card
                // entering on the same frame.
                index={index}
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
  label, active, onPress, testIDPrefix = 'storefront-directory-city', neutralWhenActive = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testIDPrefix?: string;
  // "All cities" and "Everything" are the DEFAULT state, not a choice --
  // active from the first paint, before a customer has tapped anything. Blue
  // there would mean "kaiibi's colour reads as: you did nothing", the exact
  // inversion of the rule below. Every named chip (a real city, a real trade)
  // leaves this false, because choosing one of those IS the stated choice
  // blue exists for.
  neutralWhenActive?: boolean;
}) {
  // Bounded either way, for the reason CategoryBand's pills are: an
  // unselected chip is `ground` on `soft`, which is 1.04:1 on this palette
  // and so has no edge at all. The selected chip borders in its own fill so
  // the row does not shift by 2px when one is tapped.
  //
  // KAIIBI_BLUE marks a choice the customer just made -- the other place
  // this page's own colour belongs (see the mark plate above), and the
  // mockup fills a selected chip the same way (`.dc.on{background:#0071e3}`).
  // "All cities"/"Everything" are never that choice: they are what is
  // already true before anything is tapped, so an active one of THOSE wears
  // `colors.ink` instead -- the neutral "selected" treatment every chip on
  // this page wore before KAIIBI_BLUE was introduced for the ones that are a
  // real, stated narrowing. The page's other ink-filled pills -- the masthead
  // CTA, the search's Clear, the footer's -- stay neutral for the same reason:
  // they are chrome, not a stated choice. An UNSELECTED chip is neither, and
  // wears neither: `ground` inside `edge`, as above.
  const activeFill = neutralWhenActive ? colors.ink : KAIIBI_BLUE;
  const activeText = neutralWhenActive ? colors.ground : KAIIBI_INK;
  return (
    <Pressable
      testID={`${testIDPrefix}-${label}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={pressable([
        styles.chip,
        active
          ? { backgroundColor: activeFill, borderColor: activeFill }
          : { backgroundColor: colors.ground, borderColor: colors.edge },
      ])}
    >
      <Text style={[styles.chipText, { color: active ? activeText : colors.muted }]}>{label}</Text>
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
  // DIRECTORY_MAX_WIDTH, not SHOP_MAX_WIDTH: see that constant on why a grid of
  // cards is not a reading column and should not borrow one's bound.
  scroller: { flex: 1, width: '100%', maxWidth: DIRECTORY_MAX_WIDTH, alignSelf: 'center' },
  grid: { padding: SPACE.page, paddingBottom: 48, gap: DIRECTORY_GAP },
  row: { gap: DIRECTORY_GAP },
  cell: { flex: 1 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch',
    marginTop: 24, borderWidth: 1, borderRadius: RADIUS.pill,
    paddingLeft: 18, paddingRight: 6, paddingVertical: 6,
  },
  searchIcon: { fontSize: 15 },
  // Measured 38px -- `searchRow` is a row (alignItems: 'center' above), so
  // growing the input's own minHeight is enough; the row centres it and the
  // glyph/Clear beside it without either of those needing its own change.
  search: { flex: 1, paddingVertical: 10, fontSize: TYPE.body + 1.5, minHeight: TOUCH_TARGET },
  searchClear: {
    borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  searchClearText: { fontSize: 12.5, fontWeight: '800' },

  featureWrap: { paddingBottom: 4 },

  // ONE MASTHEAD -- lockup row, promise, search -- replacing what used to be
  // a nav (paddingTop/Bottom 14, its own bottom hairline) with a centred hero
  // stacked under it. The hairline moves here, to the bottom of the WHOLE
  // masthead: it is now one composition, so it gets one edge, where the old
  // nav's hairline used to cut directly under the brand row and above a
  // headline that had nothing to do with it.
  masthead: { paddingTop: 18, paddingBottom: 22, borderBottomWidth: 1 },
  mastheadRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  navSpacer: { flex: 1 },
  // Bigger gap than the old nav's `brand` (10 -> 12): the mark plate below is
  // itself bigger, and the two need to keep the same visual ratio.
  //
  // `minHeight` is belt and braces -- `mark` below is already a fixed 44x44,
  // which this row's `alignItems: 'center'` already stretches the Pressable
  // to fit. Stated directly anyway: react-test-renderer never lays out a
  // parent from its children's own dimensions, so nothing short of this
  // states "reachable" as a fact the sweep test can check.
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TOUCH_TARGET },
  // 44px, up from the old ink plate's 32px -- "masthead scale" per the design
  // record above, because this plate is no longer one of two lockups on the
  // page, it is the only one.
  mark: {
    width: 44, height: 44, borderRadius: RADIUS.inset - 4,
    alignItems: 'center', justifyContent: 'center',
  },
  // The asset is already white-on-transparent (the same file ShopFooter loads
  // for its own colophon), so the plate's colour is carried entirely by
  // `mark`'s fill -- no tinting here, just sizing it inside the plate.
  //
  // HEIGHT AND THE MARK'S OWN RATIO, not a square: the file is 200x212, and a
  // square box makes the bag 6% too narrow. `contain` alone was hiding that --
  // it letterboxed the artwork honestly inside a wrong-shaped box, so the mark
  // was undistorted but sat smaller than the box it was given, which is why it
  // read as a stamp lost in the middle of the plate.
  //
  // 26 of the plate's 44, rather than 22: the mark IS the picture here, and at
  // half the plate it was drawn as though it were an afterthought inside it.
  markImage: { width: Math.round(26 * KAIIBI_MARK_ASPECT), height: 26, resizeMode: 'contain' },
  // The wordmark IS the headline now (see the design record above), so it
  // reads at a size that can carry that job alone rather than the old nav's
  // 18px aside-to-a-headline size.
  wordmark: { fontSize: 26, fontWeight: '800', letterSpacing: LETTER.displayLoud },
  // Measured 37px -- "Open a shop", the directory's own conversion CTA.
  navCta: {
    borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  navCtaText: { fontSize: 13, fontWeight: '800' },
  // One line, directly under the lockup row -- the promise the eyebrow pill,
  // headline and lede used to take three lines and two repetitions of
  // "kaiibi" to make.
  promise: { fontSize: TYPE.body + 1.5, marginTop: 14 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },

  chips: { flexDirection: 'row', gap: 8, paddingBottom: 6, paddingRight: SPACE.page },
  // The city/category rows -- CityChip renders both, only the testID prefix
  // differs (see that component's own comment). Every one of these is a real
  // filter a thumb has to hit inside a horizontally-scrolling row, not a
  // static label, so it takes the same floor everything else on this page
  // just did.
  chip: {
    borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 9, borderWidth: 1,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
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
  // Measured 39px -- the last control on the page, and the second ask for
  // the same conversion `navCta` above already makes once.
  footerCta: {
    borderRadius: RADIUS.pill, paddingHorizontal: 20, paddingVertical: 12, alignSelf: 'flex-start', marginTop: 18,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  footerCtaText: { fontSize: 13, fontWeight: '800' },

  empty: { borderRadius: RADIUS.card, paddingVertical: 46, paddingHorizontal: 24, alignItems: 'center' },
  emptyTitle: { fontSize: 17, fontWeight: '800', letterSpacing: LETTER.display, textAlign: 'center' },
  emptyBody: { fontSize: TYPE.body, lineHeight: 19, marginTop: 8, textAlign: 'center', maxWidth: 340 },
  emptyAction: {
    borderRadius: RADIUS.pill, paddingHorizontal: 20, paddingVertical: 11, marginTop: 18,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  emptyActionText: { fontSize: 13, fontWeight: '800' },
});
