import { type ReactNode, useRef, useState } from 'react';
import {
  Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle,
} from 'react-native';

import { type CheckoutDetails, CheckoutForm } from '@/components/storefront/checkout-form';
import { OrderPlaced } from '@/components/storefront/order-placed';
import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import {
  addLine, cartItemCount, cartSubtotalCents, loadCart, saveCart, setQuantity, type StorefrontCart,
} from '@/lib/storefront-cart';
import { collectLocation } from '@/lib/storefront-collect';
import { placeOrder, placeOrderViaWhatsApp, type PlacedOrder } from '@/lib/storefront-order';
import { WHATSAPP_BUTTON_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
//
// `areas` is optional so a caller that has none to offer (the theme-level
// component tests predate Task 8 and never pass it) still type-checks and
// renders a collection-only checkout -- CheckoutForm already treats an empty
// list the same as `offersDelivery: false`.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
  areas?: PublicDeliveryArea[];
  // Optional and defaulting to [] for the same reason `areas` is: every
  // theme-level test predating the band passes none, and a theme with no
  // categories to offer must render exactly as it did before the band
  // existed -- CategoryBand returns null below its minimum anyway.
  categories?: StorefrontCategory[];
};

// Returns null when the shop has no number. Publishing requires one, so this is
// the belt to that braces -- a page rendered from a row written before that rule
// existed should lose the button, not render one that opens a chat with nobody.
export function WhatsAppButton({ storefront }: { storefront: PublicStorefront }) {
  if (!storefront.whatsappE164) return null;
  const href = waLink(storefront.whatsappE164, `Hello ${storefront.shopName}, I have a question.`);
  return (
    <Pressable style={pressable(styles.wa)} onPress={() => openExternalUrl(href)} accessibilityRole="link">
      <Text style={styles.waText}>Message on WhatsApp</Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BENTO SURFACES
//
// The app's own system, recoloured. Dashboard and Accounting are a page tone,
// borderless 26px cards floating on it, one inverted anchor card and an
// eyebrow/value type ramp; this page predated all of that. Bento is a SURFACE
// system rather than a colour scheme, which is exactly why it survives being
// recoloured six ways.
//
// Three roles out of two tokens the palette already stores, at bento's own
// proportion (`bentoPage` #f4f4f5 sits 3% from `bentoSurface` #ffffff):
//
//   page              = the palette's `soft`
//   card              = the palette's `ground`
//   a plate INSIDE a card = `soft` again, which reads as the page showing through
//   the anchor card   = the palette's `ink`, with its type in `ground`
//
// What is NOT taken: BentoGrid, BentoCard, StatTile, Badge. Every one of them
// pins `Colors.light` (the skill says so in as many words), and this page
// renders in one of six palettes for a stranger with no account. The system
// comes across; the app's tokens do not.
// ─────────────────────────────────────────────────────────────────────────────

// Type ON the scrim, and so deliberately fixed -- the same pair, and the same
// reasoning, as the constants this replaces in theme-window.tsx: the ground
// underneath is an unknown photograph, and a palette's own ink would vanish
// into it. Lives here now because the shop card is shared by all three themes
// rather than being Window's alone.
export const ON_SCRIM_INK = '#ffffff';
export const ON_SCRIM_MUTED = '#e8e6e0';

// A card. Borderless and unshadowed on purpose: the separation is the page
// tone behind it, which is the whole of what makes a bento page read as
// floating rather than as boxes ruled onto a background.
export function ShopCard({
  colors, style, children, testID,
}: {
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.card, { backgroundColor: colors.ground }, style]}>
      {children}
    </View>
  );
}

// THE ANCHOR CARD, and the single decision this whole redesign turns on.
//
// Dashboard has exactly one near-black card (Takings) and it is what stops that
// page reading as a field of white rectangles. The storefront's equivalent is
// the shop itself -- so the wordmark, where it is, what it says and how to
// reach it all move onto one `ink` card, and the page finally has a centre of
// gravity instead of the 1,472px panel of `soft` that prompted this.
//
// The photo branch is Window's old hero, unchanged in substance: the image
// fills the card, a flat 0.55 scrim goes over it, and the type takes the two
// fixed on-scrim values above. What changed is only that it is now a card in a
// row of cards rather than a full-bleed panel of its own.
export function ShopAnchor({
  storefront, colors, style, wide, children,
}: {
  storefront: PublicStorefront;
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  // One clamp, not two designs: the wordmark that anchors a 1,080px card would
  // wrap to three lines at 390px, and the one that fits 390px is lost on a
  // laptop. Passed rather than measured here so a tile-level component never
  // subscribes to window dimensions of its own.
  wide?: boolean;
  // The WhatsApp button, on the layouts that put it here. Narrow layouts pass
  // nothing and keep it in the button row above, because the same button in
  // both places is the same control twice on a 390px screen.
  children?: ReactNode;
}) {
  const onPhoto = Boolean(storefront.heroImageUrl);
  const ink = onPhoto ? ON_SCRIM_INK : colors.ground;
  const muted = onPhoto ? ON_SCRIM_MUTED : colors.onDarkMuted;
  // Composed the same way the checkout and confirmation screens compose it, so
  // the counter named at the top of the page is the one named at the bottom of
  // it. `?? city` rather than joining both -- collectLocation already ends with
  // the city whenever there is one.
  const place =
    collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city) ?? storefront.city;

  return (
    <View
      testID="storefront-shop-card"
      style={[styles.card, styles.anchor, { backgroundColor: colors.ink }, style]}
    >
      {onPhoto ? (
        <>
          <Image source={{ uri: storefront.heroImageUrl! }} style={styles.anchorPhoto} resizeMode="cover" />
          <View testID="storefront-hero-scrim" style={styles.anchorScrim} pointerEvents="none" />
        </>
      ) : null}

      <Text style={[styles.eyebrow, { color: muted }]}>The shop</Text>

      {/* The biggest thing on the page, because "whose shop is this" is the
          first question a forwarded link has to answer. adjustsFontSizeToFit
          carries the genuinely long names down rather than letting them wrap
          to three lines -- shop names are not length-limited anywhere. */}
      <Text
        testID="storefront-wordmark"
        style={[styles.wordmark, wide && styles.wordmarkWide, { color: ink }, onPhoto && styles.onScrimText]}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {storefront.shopName}
      </Text>

      {place ? (
        <Text testID="storefront-eyebrow" style={[styles.place, { color: muted }, onPhoto && styles.onScrimText]}>
          {place}
        </Text>
      ) : null}

      {storefront.headline ? (
        <Text
          testID="storefront-headline"
          style={[styles.anchorHead, { color: ink }, onPhoto && styles.onScrimText]}
        >
          {storefront.headline}
        </Text>
      ) : null}

      {storefront.about ? (
        <Text
          testID="storefront-about"
          style={[styles.anchorAbout, { color: muted }, onPhoto && styles.onScrimText]}
        >
          {storefront.about}
        </Text>
      ) : null}

      {children ? <View style={styles.anchorFoot}>{children}</View> : null}
    </View>
  );
}

// What a customer asks before they order, which is three lines this page has
// always held and never printed. Every value is already on PublicStorefront or
// on the areas the route already fetches -- nothing new is stored or read.
export function CollectingCard({
  storefront, areas, colors, style, stacked, children,
}: {
  storefront: PublicStorefront;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  // Label above value instead of label-left/value-right. On a phone this card
  // is half the screen -- about 150px of usable width -- and a two-column row
  // there wrapped BOTH sides: "Collect from" broke over two lines and so did
  // "Jiija, Hargeisa" beside it. Stacking gives each the full width and costs
  // one line per fact.
  stacked?: boolean;
  // The Cart button, on layouts that put it here.
  children?: ReactNode;
}) {
  const where = collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city);
  // Named from the CHEAPEST area rather than a flat "Available": a customer
  // deciding whether to order wants the number, and the cheapest is the only
  // one that is true for at least somebody. A shop that offers delivery but
  // has no areas priced yet keeps the honest vaguer word.
  const cheapestCents = areas.length > 0 ? Math.min(...areas.map((a) => a.feeCents)) : null;
  const delivery = !storefront.offersDelivery
    ? 'Collection only'
    : cheapestCents === null
      ? 'Available'
      : cheapestCents === 0
        ? 'Free'
        : `From ${formatCents(cheapestCents)}`;

  return (
    <ShopCard colors={colors} style={style} testID="storefront-collecting-card">
      <Text style={[styles.eyebrow, { color: colors.muted }]}>Collecting</Text>
      <View style={styles.factList}>
        {where ? <Fact colors={colors} label="Collect from" value={where} stacked={stacked} /> : null}
        <Fact colors={colors} label="Delivery" value={delivery} stacked={stacked} />
        {/* storefronts.payment_mode is the single literal 'on_collection'
            today, so this is a fixed line rather than a branch -- and it is
            worth printing precisely because it is the answer to "do I need to
            pay now?", which is why a stranger hesitates. */}
        <Fact colors={colors} label="Pay" value="On collection" stacked={stacked} />
      </View>
      {children ? <View style={styles.cardFoot}>{children}</View> : null}
    </ShopCard>
  );
}

function Fact({
  colors, label, value, stacked,
}: { colors: PaletteColors; label: string; value: string; stacked?: boolean }) {
  return (
    <View style={[styles.fact, stacked && styles.factStacked, { borderBottomColor: colors.soft }]}>
      <Text style={[styles.factLabel, { color: colors.muted }]}>{label}</Text>
      <Text
        style={[styles.factValue, stacked && styles.factValueStacked, { color: colors.ink }]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

// A dot per product, hollow when it is out of stock -- the shape of the app's
// "7/7 products sold have a cost set" card, carrying the one fact a customer
// most wants at a glance.
//
// SHAPE CARRIES THE STATE AND COLOUR IS THE SECOND SIGNAL, which is the rule
// storefront-catalog.ts already sets by refusing to ship a `stockOk`: an
// out-of-stock dot is hollow AND amber, never amber alone.
export const MAX_STOCK_DOTS = 24;

export function StockCard({
  products, colors, style,
}: {
  products: StorefrontProduct[];
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
}) {
  const total = products.length;
  const inStock = products.filter((p) => p.stock > 0).length;
  // A dot each stops being a glance somewhere past two rows of them, and a
  // 200-product shop would render 200. Past the cap the line alone says it.
  const showDots = total > 0 && total <= MAX_STOCK_DOTS;

  return (
    <ShopCard colors={colors} style={[styles.stockCard, style]} testID="storefront-stock-card">
      <Text style={[styles.eyebrow, { color: colors.muted }]}>In the shop</Text>
      <Text style={[styles.value, { color: colors.ink }]}>{total}</Text>
      <Text style={[styles.valueLabel, { color: colors.muted }]}>
        {total === 1 ? 'item listed' : 'items listed'}
      </Text>
      {/* `marginTop: 'auto'` on the wrapper, not on the dots: on a wide layout
          this card is stretched to the anchor card's height, and without the
          push the bottom third of it is dead air. */}
      <View style={styles.stockFoot}>
        {showDots ? (
          <View style={styles.dots} testID="storefront-stock-dots">
            {products.map((p) => (
              <View
                key={p.id}
                style={[
                  styles.dot,
                  p.stock > 0
                    ? { backgroundColor: colors.accent }
                    : { borderColor: colors.stockOut, borderWidth: 1.5 },
                ]}
              />
            ))}
          </View>
        ) : null}
        {/* NOTHING AT ALL ON AN EMPTY SHOP. `inStock === total` is true at
            zero, so this line shipped saying "all in stock today" on a shop
            that has listed nothing -- immediately above the EmptyState that
            says "Nothing listed yet." Two claims, one page, and the cheerful
            one is the lie. A shop with no goods has no stock news. */}
        {total > 0 ? (
          <Text style={[styles.stockLine, { color: colors.muted }]}>
            {inStock === total ? 'all in stock today' : `${inStock} of ${total} in stock`}
          </Text>
        ) : null}
      </View>
    </ShopCard>
  );
}

// A pill. The app's black "Show my tasks · 2" button, in the shop's own ink.
export function ShopPill({
  colors, label, onPress, tone = 'ink', style, testID, accessibilityLabel,
}: {
  colors: PaletteColors;
  label: string;
  onPress: () => void;
  // 'wa' takes WhatsApp's own fixed green -- a recognised affordance, never
  // the shop's palette. 'onDark' is the ground-filled pill for the anchor card.
  tone?: 'ink' | 'wa' | 'onDark' | 'quiet';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const fills: Record<string, { background: string; text: string }> = {
    ink: { background: colors.ink, text: colors.ground },
    wa: { background: WHATSAPP_BUTTON_GREEN, text: WHATSAPP_INK },
    onDark: { background: colors.ground, text: colors.ink },
    quiet: { background: colors.soft, text: colors.ink },
  };
  const fill = fills[tone];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={pressable([styles.pill, { backgroundColor: fill.background }, style])}
    >
      <Text style={[styles.pillText, { color: fill.text }]}>{label}</Text>
    </Pressable>
  );
}

// The three cards, in the arrangement the width can carry. `wide` rather than
// a raw pixel test so the caller decides once, from the same measurement it
// already takes to pick a column count.
export function ShopHeader({
  storefront, products, areas, colors, wide, itemCount, onOpenCart,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
  itemCount: number;
  onOpenCart: () => void;
}) {
  const cartLabel = itemCount > 0 ? `Cart · ${itemCount}` : 'Cart';
  const cartA11y = itemCount > 0 ? `Open cart, ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Open cart';

  if (wide) {
    return (
      <View style={styles.header} testID="storefront-header">
        <ShopAnchor storefront={storefront} colors={colors} wide style={styles.anchorWide}>
          {storefront.whatsappE164 ? <WhatsAppButton storefront={storefront} /> : null}
        </ShopAnchor>
        <CollectingCard storefront={storefront} areas={areas} colors={colors} style={styles.collectingWide}>
          <ShopPill
            colors={colors}
            label={cartLabel}
            accessibilityLabel={cartA11y}
            onPress={onOpenCart}
            testID="storefront-cart-button"
            style={styles.blockPill}
          />
        </CollectingCard>
        <StockCard products={products} colors={colors} style={styles.stockWide} />
      </View>
    );
  }

  // Narrow: the buttons lead, then the anchor full width, then the two smaller
  // cards side by side. The WhatsApp button is in the row and NOT in the card,
  // for the reason theme-window.tsx has always given about the wordmark -- the
  // same control twice on a 390px screen is one too many.
  return (
    <View style={styles.headerNarrow} testID="storefront-header">
      <View style={styles.buttonRow}>
        <WhatsAppButton storefront={storefront} />
        <ShopPill
          colors={colors}
          label={cartLabel}
          accessibilityLabel={cartA11y}
          onPress={onOpenCart}
          testID="storefront-cart-button"
          style={styles.tightPill}
        />
      </View>
      <ShopAnchor storefront={storefront} colors={colors} />
      <View style={styles.headerPair}>
        <CollectingCard storefront={storefront} areas={areas} colors={colors} style={styles.pairCard} stacked />
        <StockCard products={products} colors={colors} style={styles.pairCard} />
      </View>
    </View>
  );
}

// Two different empties, and they must not say the same thing.
//
// This used to render one line -- "Nothing listed yet." -- for both of them: a
// shop that has listed nothing, and a grid a flyer has just filtered down to a
// category that happens to be sold out. The second case tells a customer
// standing in front of a FULL catalogue that the shop is empty, which is both
// wrong and a dead end.
//
// The shop-is-empty case is also the one place on this page where a full stop
// is worst. Every other screen here exists to start a conversation, and this
// one had a WhatsApp number in scope and declined to offer it.
export function EmptyState({
  colors, storefront, category, onClearCategory,
}: {
  colors: PaletteColors;
  // Optional so the theme-level tests that predate this still type-check, and
  // so a caller with no shop context degrades to the bare line rather than
  // failing to render.
  storefront?: PublicStorefront;
  // Set only while a flyer's category filter is applied -- see filterByCategory.
  category?: string | null;
  onClearCategory?: () => void;
}) {
  if (category) {
    return (
      <View style={styles.emptyBlock}>
        <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing in {category} right now.</Text>
        <Text style={[styles.emptyBody, { color: colors.muted }]}>
          The rest of the shop is still here.
        </Text>
        {onClearCategory ? (
          <Pressable
            testID="storefront-empty-clear-category"
            accessibilityRole="button"
            onPress={onClearCategory}
            style={pressable([styles.emptyAction, { backgroundColor: colors.soft }])}
          >
            <Text style={[styles.emptyActionText, { color: colors.ink }]}>Show everything</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const number = storefront?.whatsappE164;

  return (
    <View style={styles.emptyBlock}>
      <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing listed yet.</Text>
      {/* The second sentence is only true when there is somewhere to send
          them -- promising "message us" with no number to message would be
          the same dead end ProductActions refuses to render. */}
      <Text style={[styles.emptyBody, { color: colors.muted }]}>
        {number
          ? "We're still putting the shop online. Message us and we'll tell you what's in today."
          : "We're still putting the shop online. Check back shortly."}
      </Text>
      {number && storefront ? (
        <Pressable
          testID="storefront-empty-whatsapp"
          accessibilityRole="link"
          onPress={() => openExternalUrl(waLink(number, `Hello ${storefront.shopName}, what do you have in today?`))}
          style={pressable(styles.emptyWa)}
        >
          {/* NOT "Message on WhatsApp" -- that is already the label on the
              nav button a few pixels above, and two identical buttons on one
              screen make the reader work out whether they do the same thing.
              This one names the answer it gets back. */}
          <Text style={styles.emptyWaText}>Ask what&apos;s in today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type ProductActionsProps = {
  product: StorefrontProduct;
  colors: PaletteColors;
  // See the identical comment on ProductTile's Props in product-tile.tsx --
  // Ask does not render without a number, the same rule WhatsAppButton
  // above follows: lose the button rather than render one that opens a
  // chat with nobody.
  shopName?: string;
  whatsappE164?: string | null;
  onAdd?: (product: StorefrontProduct) => void;
  // ProductTile renders this pair full-width inside a grid tile; Counter
  // renders it inline in a dense price-list row, where a full-size button
  // pair would turn every row into a card. `compact` is the same two
  // buttons at row scale, not a different component.
  compact?: boolean;
};

// The Add/Ask pair every theme with per-product actions needs. Originally
// lived only in ProductTile (Market, Window); Counter has its own row layout
// and so cannot reuse ProductTile itself, only the two rules its actions
// follow. Extracted here rather than copied a third time, so those rules have
// exactly one place to drift out of sync.
//
// The rules: Add only in stock -- an out-of-stock product keeps Ask, because
// the shop may be restocking and that enquiry is a sale. And Ask only when
// there is a number to ask, for the reason WhatsAppButton above states: lose
// the button rather than render one that opens a chat with nobody. An earlier
// version rendered Ask always and made it silently do nothing, which is the
// worse half of both options -- the customer taps and the app shrugs.
export function ProductActions({ product, colors, shopName, whatsappE164, onAdd, compact }: ProductActionsProps) {
  const outOfStock = product.stock <= 0;

  function handleAsk() {
    // Unreachable now that Ask does not render without a number; kept as the
    // type narrow that lets waLink take a string.
    if (!whatsappE164) return;
    const message = shopName
      ? `Hi ${shopName}, is ${product.name} available?`
      : `Is ${product.name} available?`;
    openExternalUrl(waLink(whatsappE164, message));
  }

  return (
    <View style={[styles.actions, compact && styles.actionsCompact]}>
      {/* Add is only offered in stock -- accent is the palette's own
          "buttons and the active filter" colour, and ground stands in for
          the "always white on it" it's paired with, so this button needs no
          colour literal of its own. */}
      {outOfStock ? null : (
        <Pressable
          testID="product-tile-add"
          accessibilityRole="button"
          style={pressable([styles.button, compact && styles.buttonCompact, { backgroundColor: colors.accent }])}
          onPress={() => onAdd?.(product)}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: colors.ground }]}>Add</Text>
        </Pressable>
      )}
      {/* WhatsApp's own fixed brand colours -- never the shop's palette. */}
      {whatsappE164 ? (
        <Pressable
          testID="product-tile-ask"
          accessibilityRole="button"
          style={pressable([styles.button, compact && styles.buttonCompact, { backgroundColor: WHATSAPP_BUTTON_GREEN }])}
          onPress={handleAsk}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: WHATSAPP_INK }]}>Ask</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The cart entry point every theme needs -- including Counter, which has no
// product grid and so no Add button of its own. The cart is keyed by shop
// slug, not by theme (see storefront-cart.ts), so a customer who added items
// under Market and then lands on Counter -- or whose shop simply switched
// themes -- still needs a way to see and change what is already in it.
export function CartButton({ colors, count, onPress }: { colors: PaletteColors; count: number; onPress: () => void }) {
  return (
    <Pressable
      testID="storefront-cart-button"
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Open cart, ${count} item${count === 1 ? '' : 's'}` : 'Open cart'}
      onPress={onPress}
      style={pressable([styles.cart, { backgroundColor: colors.accent }])}
    >
      <Text style={[styles.cartText, { color: colors.ground }]}>{count > 0 ? `Cart · ${count}` : 'Cart'}</Text>
    </Pressable>
  );
}

// The way into a long catalogue. Renders only when there is enough of one to
// be worth a control -- see shouldOfferSearch in storefront-search.ts.
//
// A plain TextInput and no submit button: the list filters as you type, so
// there is nothing to submit, and a phone keyboard's own "search" key would
// only dismiss itself. `clearButtonMode` is iOS-only, so the explicit Clear
// below is what Android and web get -- and a filter with no visible way out
// is the same dead end CategoryFilterBar exists to avoid.
export function SearchField({
  colors, value, onChange, count,
}: {
  colors: PaletteColors;
  value: string;
  onChange: (next: string) => void;
  count: number;
}) {
  return (
    <View style={styles.searchRow}>
      <TextInput
        testID="storefront-search"
        accessibilityLabel={`Search ${count} items`}
        placeholder={`Search ${count} items`}
        placeholderTextColor={colors.muted}
        value={value}
        onChangeText={onChange}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={[styles.search, { borderColor: colors.soft, color: colors.ink, backgroundColor: colors.ground }]}
      />
      {value.length > 0 ? (
        <Pressable
          testID="storefront-search-clear"
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange('')}
          style={pressable([styles.searchClear, { backgroundColor: colors.soft }])}
        >
          <Text style={[styles.searchClearText, { color: colors.ink }]}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// What a search that found nothing should say. Distinct from both other
// empties: the shop is not empty and no category is filtering -- the customer
// simply typed something this shop does not stock, and the useful next move is
// to ask rather than to keep typing.
export function NoSearchResults({
  colors, query, onClear,
}: { colors: PaletteColors; query: string; onClear: () => void }) {
  return (
    <View style={styles.emptyBlock}>
      <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing matches “{query}”.</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>
        Try a shorter word, or ask the shop — they may have it behind the counter.
      </Text>
      <Pressable
        testID="storefront-search-empty-clear"
        accessibilityRole="button"
        onPress={onClear}
        style={pressable([styles.emptyAction, { backgroundColor: colors.soft }])}
      >
        <Text style={[styles.emptyActionText, { color: colors.ink }]}>Show everything</Text>
      </Pressable>
    </View>
  );
}

// Property 6 of the flyers brief: a slide with `link_kind = 'category'`
// filters the page. Case- and whitespace-insensitive because the two sides
// have different authors -- `link_value` is what the shop typed on the flyer,
// `products.category` is what they typed on the product, months apart -- and
// "solar " not matching "Solar" would be a dead end a customer cannot see the
// cause of.
//
// Shared rather than written twice: Market and Window both do this, Counter
// renders no flyers and so never calls it.
export function filterByCategory(products: StorefrontProduct[], category: string | null): StorefrontProduct[] {
  if (!category) return products;
  const wanted = category.trim().toLowerCase();
  return products.filter((p) => (p.category ?? '').trim().toLowerCase() === wanted);
}

// The way back out of that filter. Renders only while one is applied -- a
// permanent "showing everything" chip would be a control that never does
// anything -- and says which category it is showing, because the flyer that
// set it may well have been scrolled past by now.
export function CategoryFilterBar({
  colors, category, onClear,
}: { colors: PaletteColors; category: string | null; onClear: () => void }) {
  if (!category) return null;
  return (
    <Pressable
      testID="storefront-category-clear"
      accessibilityRole="button"
      accessibilityLabel={`Showing ${category} only. Show everything`}
      onPress={onClear}
      style={pressable([styles.filterChip, { backgroundColor: colors.soft }])}
    >
      <Text style={[styles.filterChipText, { color: colors.ink }]}>{category} · Show everything ✕</Text>
    </Pressable>
  );
}

// A hardcoded numColumns=2 suits the 390px phone the plan was verified at,
// but leaves a 1280px laptop with a couple of oversized tiles and vast empty
// margins either side. Breakpoints roughly split phone / tablet / laptop --
// three columns is not "the" right answer for 768px so much as a deliberate
// one, same as the rest of the grid a theme renders through.
export function gridColumnsForWidth(width: number): number {
  if (width < 640) return 2;
  if (width < 1024) return 3;
  return 4;
}

// Where the three shop cards stop stacking and sit in a row. Deliberately its
// own number rather than reusing a grid breakpoint: the header is three cards
// of very different content widths, and the point it stops working is not the
// point a product grid gains a column.
export const WIDE_SHOP_WIDTH = 900;

export function isWideShop(width: number): boolean {
  return width >= WIDE_SHOP_WIDTH;
}

// A SHORT FINAL ROW MUST LEAVE A GAP, NOT INFLATE.
//
// This is the defect that produced the screenshot this redesign came from.
// FlatList lays a short final row out with only the cells it has, and the cell
// style is `flex: 1` -- so three products at four columns became three cells
// each a THIRD of the width rather than a quarter. With `aspectRatio: 1` on the
// image that made a 480px-tall tile whose name and price fell below the fold,
// and it read as a layout accident rather than as a shop with three things in
// it.
//
// Padding the data is the fix rather than sizing the cell by percentage:
// percentages have to account for the inter-column gap, which changes with the
// column count, and getting that arithmetic subtly wrong is how a grid ends up
// one pixel short and wraps. A placeholder cell is exact at every width.
export function padFinalRow<T>(items: T[], numColumns: number): (T | null)[] {
  if (numColumns <= 1 || items.length === 0) return items;
  const remainder = items.length % numColumns;
  if (remainder === 0) return items;
  return [...items, ...Array<null>(numColumns - remainder).fill(null)];
}

// The cart lives in `storefront-cart.ts`, keyed by shop slug, and every
// theme needs to read it, add to it, and change a line's quantity the same
// way -- so that logic is a hook here rather than copied into Market, Window
// and Counter separately. Deliberately not exported as a class or a context:
// nothing here needs to be shared ACROSS components on the same screen, only
// reused across the three that each render their own tree.
export function useStorefrontCart(slug: string) {
  const [cart, setCart] = useState<StorefrontCart>(() => loadCart(slug));

  function addProduct(product: StorefrontProduct) {
    setCart((prev) => {
      const next = addLine(prev, { productId: product.id, name: product.name, unitPriceCents: product.priceCents });
      saveCart(next);
      return next;
    });
  }

  function changeQuantity(productId: string, quantity: number) {
    setCart((prev) => {
      const next = setQuantity(prev, productId, quantity);
      saveCart(next);
      return next;
    });
  }

  // placeOrder (storefront-order.ts) already clears the STORED cart the
  // moment an order is accepted -- this brings the in-memory copy every theme
  // reads back in sync with that, so a customer who places a second order
  // doesn't see the first one's lines still sitting in the cart. Never
  // called on a rejected order: the caller only reaches this after
  // placeOrder/placeOrderViaWhatsApp has resolved, never from a catch block.
  function clearCart() {
    setCart((prev) => {
      const next: StorefrontCart = { ...prev, lines: [] };
      saveCart(next);
      return next;
    });
  }

  return {
    cart,
    addProduct,
    changeQuantity,
    clearCart,
    itemCount: cartItemCount(cart),
    subtotalCents: cartSubtotalCents(cart),
  };
}

// The direct path from a non-empty cart to checkout. CartSheet (the cart
// review modal) has a fixed prop surface --
// visible/onClose/cart/colors/onChangeQuantity, see cart-sheet.tsx -- and
// gained no checkout affordance of its own, so this sticky bar is what every
// theme renders instead: named after the subtotal, gone the moment the
// cart is empty, so it can never invite a checkout with nothing in it.
// B6: the bar itself is `position: absolute`, so it takes no space in the
// document flow it floats over -- nothing pushes the browsing view's own
// content up to make room for it. Each theme's scrollable container adds
// this much bottom padding of its own, but ONLY while `itemCount > 0` (the
// same condition CheckoutBar below uses to render at all): an empty cart
// must not carry dead space at the bottom of a page with no bar to clear.
// Sized to the bar's own layout -- paddingVertical 14 top and bottom plus a
// ~17px line of 14px/800-weight text is ~45px, plus the 14px gap the bar
// itself sits above the screen edge -- rounded up with headroom rather than
// tuned to the pixel, so a future tweak to the bar's own padding does not
// also require re-measuring this constant.
export const CHECKOUT_BAR_CLEARANCE = 76;

export function CheckoutBar({
  colors, itemCount, subtotalCents, onPress,
}: { colors: PaletteColors; itemCount: number; subtotalCents: number; onPress: () => void }) {
  if (itemCount === 0) return null;
  return (
    <Pressable
      testID="storefront-checkout-bar"
      accessibilityRole="button"
      onPress={onPress}
      style={pressable([styles.checkoutBar, { backgroundColor: colors.accent }])}
    >
      <Text style={[styles.checkoutBarText, { color: colors.ground }]}>Checkout · {formatCents(subtotalCents)}</Text>
    </Pressable>
  );
}

export type CheckoutStage = 'browse' | 'checkout' | 'confirmation';

// place_storefront_order's own client-error vocabulary
// (20260927000000_place_order.sql's `c_client_errors`) exists precisely so a
// rejection tells the customer what they can fix -- property 9 of the
// checkout brief. supabase-js surfaces a rejected RPC as an error whose
// `message` IS that fixed code word (e.g. 'unavailable_item'), never prose,
// so this is a lookup table from code to a sentence a shopkeeper's customer
// can act on. Anything not in this table -- an unrecognised code, a network
// error with no `message` at all, `order_failed` itself (the fallback the
// RPC degrades an unanticipated server error to) -- keeps the old generic
// sentence, which is still honest for those cases: there really is nothing
// more specific to say.
const GENERIC_ORDER_ERROR = "We couldn't place your order. Check your connection and try again.";

const ORDER_ERROR_MESSAGES: Record<string, string> = {
  shop_unavailable: "This shop isn't taking orders right now.",
  rate_limited: "This shop has had a lot of orders in the last hour. Please try again shortly.",
  name_required: 'Add your name so the shop knows who is ordering.',
  invalid_name: "That name isn't valid. Check it and try again.",
  invalid_phone: "We couldn't recognise that phone number. Check it and try again.",
  invalid_fulfilment: 'Choose collection or delivery and try again.',
  invalid_landmark: 'Describe the landmark near you and try again.',
  invalid_note: 'Shorten your note and try again.',
  delivery_unavailable: "This shop doesn't offer delivery. Choose collection instead.",
  unknown_delivery_area: "That delivery area isn't available any more. Pick another one.",
  empty_cart: 'Your cart is empty. Add something before checking out.',
  cart_too_large: 'There are too many items in your cart. Remove a few and try again.',
  invalid_quantity: 'One of the quantities in your cart looks wrong. Adjust it and try again.',
  // The one code the brief calls out by name: the action is to remove the
  // item, not just be told about it -- CheckoutScreen below renders an
  // "Edit cart" action whenever this exact code comes back, wired to
  // reopen CartSheet on top of the same cart rather than merely saying so.
  unavailable_item: 'One of the items in your cart is no longer available. Remove it to continue.',
};

// The RPC's error surfaces as `error.message` set to the fixed code word
// itself (a thrown PostgrestError, never a plain string) -- this is the one
// place that assumption lives, so a change to how the RPC is called only
// has to update here.
function orderErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function orderErrorMessage(code: string | null): string {
  return (code && ORDER_ERROR_MESSAGES[code]) || GENERIC_ORDER_ERROR;
}

// Owns everything past "browsing" that every theme needs, and nothing a
// theme should have to get right on its own: filling in checkout, submitting
// through the right one of Task 7's two order functions, and landing on a
// confirmation. Kept out of any one theme for the same reason
// useStorefrontCart is -- Market, Window and Counter all need the identical
// sequencing (place the order, THEN clear the cart, THEN show the
// confirmation; never the other order, and never on a rejected order -- see
// storefront-order.ts's own comments on why that ordering is structural
// there, not just tested behaviour here).
//
// Property 4: a shop with no WhatsApp number still takes orders -- and
// property 2: a shop WITH one offers a genuine choice, not a redirect. The
// choice between the two order functions is made by `via`, the argument
// CheckoutForm's onSubmit hands back to say which of its two controls the
// customer actually pressed -- never re-derived here from whether
// `opts.whatsappE164` merely exists. (It shipped once as exactly that
// re-derivation -- `opts.whatsappE164 ? viaWhatsApp : placeOrder` with no
// `via` at all -- which silently sent every order at a shop with a number
// through WhatsApp, because CheckoutForm only ever rendered the one button
// that could reach here. See submit() below for the fix.)
export function useCheckoutFlow(opts: {
  slug: string;
  shopName: string;
  whatsappE164: string | null;
  // Called once an order has actually been accepted, never on a rejection --
  // wired to useStorefrontCart's clearCart above.
  onOrderPlaced: () => void;
}) {
  const [stage, setStage] = useState<CheckoutStage>('browse');
  const [order, setOrder] = useState<PlacedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // B1: a `submitting` STATE guard is not enough. React applies the
  // `setSubmitting(true)` from a first tap's handler on the next render; a
  // second tap landing before that render -- a double tap, not two separate
  // user decisions -- would still close over the pre-update `submitting`
  // value and sail through submit() a second time, placing two orders
  // against the same rate limit. A ref is written synchronously, before any
  // `await`, so a re-entrant call always sees it regardless of render timing.
  const submittingRef = useRef(false);

  function openCheckout() {
    setError(null);
    setErrorCode(null);
    setStage('checkout');
  }

  function backToBrowse() {
    setStage('browse');
  }

  async function submit(cart: StorefrontCart, details: CheckoutDetails, via: 'direct' | 'whatsapp') {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      // Branches on `via` -- what the customer pressed -- not on whether
      // `opts.whatsappE164` exists. The `&& opts.whatsappE164` here is only
      // a type narrow for placeOrderViaWhatsApp's required string param: the
      // WhatsApp control in CheckoutForm cannot render, and so `via` cannot
      // be 'whatsapp', unless a number is already present.
      const placed = via === 'whatsapp' && opts.whatsappE164
        ? await placeOrderViaWhatsApp(opts.slug, cart, details, opts.shopName, opts.whatsappE164)
        : await placeOrder(opts.slug, cart, details);
      opts.onOrderPlaced();
      setOrder(placed);
      setStage('confirmation');
    } catch (err) {
      // A rejected order (a stale product, a full cart, a rate limit)
      // leaves the cart exactly as placeOrder left it -- untouched, since
      // onOrderPlaced above is never reached -- and keeps the customer on
      // 'checkout' rather than bouncing them back to an empty-looking cart,
      // so what they typed is still on screen to retry with. B2: the message
      // itself is now the RPC's own client-error code translated into a
      // sentence the customer can act on (see ORDER_ERROR_MESSAGES above),
      // not a one-size-fits-all "check your connection".
      const code = orderErrorCode(err);
      setErrorCode(code);
      setError(orderErrorMessage(code));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return { stage, order, error, errorCode, submitting, openCheckout, backToBrowse, submit };
}

// Rendered by every theme in place of its own browsing UI once checkout
// begins. Deliberately theme-agnostic: collecting a name, phone and delivery
// address means the same thing on a photo grid or a price list, and only the
// palette should differ between them -- `colors` already carries that.
export function CheckoutScreen({
  storefront, cart, areas, colors, submitting, error, errorCode, onBack, onSubmit, onEditCart,
}: {
  storefront: PublicStorefront;
  cart: StorefrontCart;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  submitting: boolean;
  error: string | null;
  // B2: which client-error code (if any) `error` was translated from -- only
  // 'unavailable_item' changes what renders below the message, everything
  // else is just the sentence.
  errorCode?: string | null;
  onBack: () => void;
  onSubmit: (details: CheckoutDetails, via: 'direct' | 'whatsapp') => void;
  // B2/B7: reopens the cart on 'unavailable_item' so removing the stale
  // line is one tap away, not a message the customer has to act on by
  // guessing where to go. Optional so a caller mid-migration (and every
  // existing test that predates this) still type-checks.
  onEditCart?: () => void;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <View style={styles.screenNav}>
        {/* No background of its own -- `pressable(undefined)` still returns
            the callback, so the opacity/scale applies to the bare text. */}
        <Pressable
          testID="storefront-checkout-back"
          accessibilityRole="button"
          onPress={onBack}
          hitSlop={8}
          style={pressable(undefined)}
        >
          <Text style={[styles.screenBack, { color: colors.ink }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.screenTitle, { color: colors.ink }]}>Checkout</Text>
      </View>
      <ScrollView contentContainerStyle={styles.screenBody}>
        {error ? <Text style={[styles.screenError, { color: colors.danger }]}>{error}</Text> : null}
        {/* B2: "remove the item" is the action -- so make it possible from
            right here, not just say it and leave the customer to work out
            that the cart is back through the nav bar. */}
        {errorCode === 'unavailable_item' && onEditCart ? (
          <Pressable
            testID="storefront-checkout-edit-cart"
            accessibilityRole="button"
            onPress={onEditCart}
            style={pressable([styles.editCart, { borderColor: colors.danger }])}
          >
            <Text style={[styles.editCartText, { color: colors.danger }]}>Edit cart</Text>
          </Pressable>
        ) : null}
        <CheckoutForm
          cart={cart}
          colors={colors}
          offersDelivery={storefront.offersDelivery}
          areas={areas}
          submitting={submitting}
          whatsappE164={storefront.whatsappE164}
          // Composed here, not in the form: `collectAddress` is null for
          // nearly every shop (see storefront-collect.ts), and
          // `collectNeighborhood` then `city` are the fallbacks that actually
          // are populated. The form receives a line worth printing or nothing
          // at all.
          collectLocation={collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city)}
          onSubmit={onSubmit}
        />
        {submitting ? <Text style={[styles.screenHint, { color: colors.muted }]}>Placing your order…</Text> : null}
      </ScrollView>
    </View>
  );
}

// The last screen a customer sees on this page. "Continue shopping" is the
// only way onward -- there is no order history and no account, per
// order-placed.tsx's own header comment on what this trade can honestly
// promise today.
export function ConfirmationScreen({
  order, shopName, collectLocation, colors, onDone,
}: {
  order: PlacedOrder;
  shopName: string;
  // Composed by the caller from the storefront, the same way CheckoutScreen
  // does it -- so the counter named on the confirmation is the one named at
  // checkout. Optional so a caller that predates this still type-checks.
  collectLocation?: string | null;
  colors: PaletteColors;
  onDone: () => void;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <ScrollView contentContainerStyle={styles.screenBody}>
        <OrderPlaced order={order} shopName={shopName} collectLocation={collectLocation} colors={colors} />
        <Pressable
          testID="storefront-continue-shopping"
          accessibilityRole="button"
          onPress={onDone}
          style={pressable([styles.continueButton, { backgroundColor: colors.soft }])}
        >
          <Text style={[styles.continueText, { color: colors.ink }]}>Continue shopping</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// The hairline above the anchor card's button, and the only rule drawn on that
// card. Fixed white-at-low-alpha rather than a palette value for the same
// reason ON_SCRIM_INK is fixed: it is drawn on `ink`, which is a near-black on
// every palette, and a derived token would be six values doing one job.
const ON_INK_HAIRLINE = 'rgba(255,255,255,0.14)';

const styles = StyleSheet.create({
  // ── bento surfaces ──
  card: { borderRadius: RADIUS.card, padding: SPACE.card },
  // `overflow: hidden` so a hero photograph is clipped to the card's own
  // radius rather than squaring off its corners.
  anchor: { overflow: 'hidden' },
  anchorPhoto: { ...StyleSheet.absoluteFill },
  // A FLAT scrim covering the whole card, not a bottom-weighted gradient: the
  // type flows from the TOP of this card, so the area needing darkening is all
  // of it. What 0.55 does and does not buy is unchanged from the panel this
  // replaces -- comfortable against a mid or dark photo, not sufficient against
  // a near-white one, which is what the text shadow below carries.
  anchorScrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
  onScrimText: { textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  wordmark: {
    fontFamily: DISPLAY_FONT, fontSize: 30, fontWeight: '700',
    letterSpacing: LETTER.displayLoud, lineHeight: 34, marginTop: 12,
  },
  wordmarkWide: { fontSize: 40, lineHeight: 44 },
  place: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta,
    textTransform: 'uppercase', marginTop: 10,
  },
  anchorHead: { fontSize: 17, fontWeight: '700', letterSpacing: LETTER.display, lineHeight: 23, marginTop: 16 },
  anchorAbout: { fontSize: TYPE.body, lineHeight: 20, marginTop: 7 },
  anchorFoot: {
    marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: ON_INK_HAIRLINE,
    flexDirection: 'row', gap: 8, flexWrap: 'wrap',
  },
  factList: { marginTop: 14 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1 },
  factStacked: { flexDirection: 'column', gap: 1, alignItems: 'flex-start' },
  factLabel: { fontSize: 12.5, fontWeight: '600' },
  factValue: { fontSize: 12.5, fontWeight: '800', textAlign: 'right', flexShrink: 1 },
  factValueStacked: { textAlign: 'left' },
  cardFoot: { marginTop: 14 },
  stockCard: { flexDirection: 'column' },
  stockFoot: { marginTop: 'auto' },
  value: { fontSize: TYPE.value, fontWeight: '800', letterSpacing: -1.1, marginTop: 12, ...TABULAR },
  valueLabel: { fontSize: 12.5, marginTop: 2 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 14 },
  dot: { width: 9, height: 9, borderRadius: RADIUS.pill },
  stockLine: { fontSize: 11.5, marginTop: 10 },
  pill: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center' },
  pillText: { fontSize: 13, fontWeight: '800' },
  blockPill: { alignSelf: 'stretch' },
  tightPill: { paddingHorizontal: 14, paddingVertical: 8 },
  // `flexWrap` on BOTH arrangements, and asserted by
  // storefront-theme-header-overflow.test.tsx: nothing in this row may run off
  // the side of a screen. The three cards take `flex: n` (grow n, basis 0), so
  // they have no hypothetical width of their own to overflow with and the wrap
  // is a backstop rather than the mechanism.
  header: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.cardGap, alignItems: 'stretch' },
  anchorWide: { flex: 5 },
  collectingWide: { flex: 4 },
  stockWide: { flex: 3 },
  headerNarrow: { flexWrap: 'wrap', gap: SPACE.cardGap },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  headerPair: { flexDirection: 'row', gap: SPACE.cardGap, alignItems: 'stretch' },
  pairCard: { flex: 1 },

  // Fixed green in every palette: a recognised affordance, not a brand colour.
  wa: { backgroundColor: WHATSAPP_BUTTON_GREEN, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  waText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  empty: { fontSize: 14, fontWeight: '700', padding: 24, textAlign: 'center' },
  emptyBlock: { paddingHorizontal: 24, paddingVertical: 30, alignItems: 'center' },
  emptyHead: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: 'center', maxWidth: 320 },
  emptyAction: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, marginTop: 14 },
  emptyActionText: { fontSize: 12.5, fontWeight: '800' },
  // WhatsApp's own fixed colours, same as WhatsAppButton above -- never the
  // shop's palette.
  emptyWa: { backgroundColor: WHATSAPP_BUTTON_GREEN, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, marginTop: 14 },
  emptyWaText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: SPACE.page, paddingTop: 10 },
  search: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 10, fontSize: TYPE.body },
  searchClear: { borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  searchClearText: { fontSize: 12.5, fontWeight: '800' },
  cart: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  cartText: { fontSize: 12.5, fontWeight: '800' },
  filterChip: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7, marginHorizontal: 14, marginTop: 12 },
  filterChipText: { fontSize: 12.5, fontWeight: '800' },
  // Full-size default: ProductTile's grid tile, where the pair fills the
  // tile's own width evenly.
  actions: { flexDirection: 'row', gap: 6 },
  button: { flex: 1, borderRadius: 9, paddingVertical: 6, alignItems: 'center' },
  buttonText: { fontSize: 12, fontWeight: '800' },
  // Row scale: Counter's dense price list, where the pair sits inline next
  // to the stock label rather than filling a row's width.
  actionsCompact: { gap: 4 },
  // `flexGrow/Shrink/Basis` spelled out rather than the `flex: 0` shorthand
  // this used to carry, because THE SHORTHAND DOES NOT MEAN THE SAME THING ON
  // THE TWO PLATFORMS.
  //
  // React Native reads `flex: 0` as grow 0 / shrink 0 / basis auto -- the
  // button hugs its label, which is what Counter's dense row wants. CSS reads
  // it as `0 1 0%`: basis ZERO, so on react-native-web the button collapsed to
  // its own horizontal padding and clipped the label -- "Add" rendered as
  // "Adc" on every Counter shop. Native was fine, so nothing in the app
  // surfaced it, and jest cannot see it because react-test-renderer does no
  // layout. It showed up the first time Counter was opened in a browser --
  // which is where nearly all of this page's traffic actually is.
  //
  // The longhand is identical on both.
  buttonCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', borderRadius: 7, paddingVertical: 3, paddingHorizontal: 9 },
  buttonTextCompact: { fontSize: 10.5 },
  // Floats over the browsing view's own content -- the parent View every
  // theme renders is flex:1 with no explicit `position`, which React Native
  // defaults to 'relative', so this anchors to that box rather than the
  // whole window.
  checkoutBar: {
    position: 'absolute', left: 14, right: 14, bottom: 14,
    borderRadius: 999, paddingVertical: 14, alignItems: 'center',
  },
  checkoutBarText: { fontSize: 14, fontWeight: '800' },
  screen: { flex: 1 },
  screenNav: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  screenBack: { fontSize: 14, fontWeight: '700' },
  screenTitle: { fontSize: 16, fontWeight: '800' },
  screenBody: { paddingHorizontal: 14, paddingBottom: 24 },
  screenError: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  editCart: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginBottom: 14 },
  editCartText: { fontSize: 12.5, fontWeight: '800' },
  screenHint: { fontSize: 12.5, marginTop: 10, textAlign: 'center' },
  continueButton: { marginTop: 16, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  continueText: { fontSize: 14, fontWeight: '800' },
});
