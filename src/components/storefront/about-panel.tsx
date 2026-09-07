import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import {
  DISPLAY_FONT, LETTER, PROSE_MAX_WIDTH, RADIUS, SPACE, TOUCH_TARGET, TYPE,
} from '@/components/storefront/scale';
import { ShopCard } from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import { collectLocation } from '@/lib/storefront-collect';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// The About tab.
//
// A STRANGER TRUSTS WHAT THEY CAN SEE BEFORE WHAT THEY CAN READ (Task 21,
// 20261024000000/000100). The tab used to open in a reader's order -- story,
// then the gallery that was supposed to be vouching for it, buried below. The
// order top to bottom now is: the photographs, the proof chips, the shop's own
// voice, the FAQ -- every one of them the same data this tab has always had,
// re-weighted rather than replaced.
//
// Most of it is composed from what the shop has already filled in elsewhere:
// the story is `storefronts.about`, the proof chips are counted from the
// products the route already fetches, and every FAQ answer is derived from
// `offers_delivery`, `payment_mode` and the area list.
//
// Three blocks are the shop's own: the highlight cards inside the merged story
// card (`storefront_highlights`), the year it opened (`storefronts.trading_since`)
// and the photographs (`storefront_images`). All are optional and all render
// as NOTHING when unset -- the rule every block on this page follows. A shop
// that has uploaded no photographs and written no highlights starts the tab at
// the proof chips, or at its own story if it has nothing to prove either.

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

// `categories` stays in the prop type -- ShopChrome passes the same object it
// hands every panel, and the existing test suite's `renderAbout` helper
// already calls with it set -- but Task 21's proof chips no longer count it
// (see `proofChips` below), so it is never destructured to a local name; an
// unused local is what the old stats strip would have left behind here.
export function AboutPanel({
  storefront, products, areas, colors, wide,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  categories: StorefrontCategory[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
}) {
  const questions = shopQuestions(storefront, areas);

  // THE ONLY SAFETY NET A DANGLING ROW ACTUALLY HAS.
  //
  // removeGalleryImage deletes the storage object BEFORE the row, so a failure
  // between the two leaves a row pointing at nothing. The reader was said to
  // catch that by dropping entries whose url is null -- it cannot:
  // `image_path` holds an ABSOLUTE url (uploadImage returns one) and
  // publicImageUrl passes those straight through, so it never returns null and
  // the filter never fires. The row survives and the customer gets a broken
  // image, potentially the 16:9 lead.
  //
  // `onError` is what actually knows: the device tried to fetch it and failed.
  // Dropping on that is per-render and per-device, which is right -- a photo
  // missing for a moment on a bad connection comes back on the next visit,
  // where a persisted "this is broken" would not.
  const [failed, setFailed] = useState<string[]>([]);
  const dropImage = (id: string) => setFailed((prev) => (prev.includes(id) ? prev : [...prev, id]));
  const shownImages = storefront.images.filter((image) => !failed.includes(image.id));

  // THE CAPTION STRIP is the shop's PLACE, not a description of what is in the
  // photo -- `storefront_images` carries only `{ id, url }`, so there is no
  // caption column to read one from, and inventing a label for what the photo
  // shows would assert a claim the shop never made (the same discipline
  // `HoursCard` follows refusing to print a "Closed" row for a day the shop
  // never configured). A line beneath the cover rather than lettered over it:
  // over the photo it would need a scrim, because the photo's own brightness
  // is unknown, and a line under it needs none.
  const caption = collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city);

  // THE PROOF CHIPS replace the old stats strip -- three reasons to trust the
  // shop, phrased as reasons rather than a dashboard row, in place of a count
  // of categories and delivery areas that answered a question a stranger
  // skimming three photographs was not yet asking. Absent entirely, one at a
  // time, when it has nothing true to say.
  const inStockCount = products.filter((product) => product.stock > 0).length;
  const proofChips: { id: string; text: string }[] = [];
  // Leads when there is one: it is the one figure here not derivable from the
  // page a customer is already looking at, and the one that answers "have
  // these people been doing this a while".
  if (storefront.tradingSince) {
    proofChips.push({ id: 'trading', text: `Trading since ${storefront.tradingSince}` });
  }
  // Counting ALL listed products would put "9 items in today" on a shop whose
  // shelves are empty -- `stock > 0` is what a customer can actually buy right
  // now, which is what "in today" claims. Absent at zero rather than printed
  // as "0 items in today".
  if (inStockCount > 0) {
    proofChips.push({
      id: 'stock',
      text: inStockCount === 1 ? '1 item in today' : `${inStockCount} items in today`,
    });
  }
  // Offered only where there is a number to answer on -- the same rule
  // `shopQuestions` above and `WhatsAppButton` both follow.
  if (storefront.whatsappE164) {
    proofChips.push({ id: 'whatsapp', text: 'Answers on WhatsApp' });
  }

  return (
    <View testID="storefront-about-panel">
      <View style={styles.panel}>
        {/* THE GALLERY, moved to the top: a stranger trusts what they can see
            before what they can read. It is a row of what the shop actually
            uploaded -- never a grid with holes in it. The cover is always the
            first photo, full width and 16:9; the rest are a THUMBNAIL STRIP
            under it, which is what the design draws. A shop with one photo
            gets the cover and no strip; a shop with none renders no cover, no
            caption and no strip at all -- the tab simply starts at the proof
            chips below.

            NO PROSE BOUND HERE, DELIBERATELY (Task 25). PROSE_MAX_WIDTH exists
            for a paragraph's line length, and a photograph has no line to keep
            short -- so, unlike every block below it, this one carries no
            `maxWidth` at all and simply fills `body` (shop-chrome.tsx), which
            is the same width `ShopFooter` already renders at. That is also
            why `SHOP_MAX_WIDTH` is never imported here: a gallery with no
            bound of its own lands at the footer's width by construction, the
            two agreeing without a second constant to keep in step. */}
        {shownImages.length > 0 ? (
          <View style={styles.gallery} testID="storefront-about-gallery">
            <View>
              <Image
                testID="storefront-about-cover"
                source={{ uri: shownImages[0].url! }}
                onError={() => dropImage(shownImages[0].id)}
                style={[styles.galleryLead, { backgroundColor: colors.soft }]}
                resizeMode="cover"
              />
              {caption ? (
                <Text
                  testID="storefront-about-caption"
                  style={[styles.caption, { color: colors.muted }]}
                  numberOfLines={1}
                >
                  {caption}
                </Text>
              ) : null}
            </View>
            {shownImages.length > 1 ? (
              <View style={styles.galleryRest}>
                {shownImages.slice(1).map((image) => (
                  <Image
                    key={image.id}
                    testID={`storefront-about-photo-${image.id}`}
                    source={{ uri: image.url! }}
                    onError={() => dropImage(image.id)}
                    style={[styles.galleryThumb, { backgroundColor: colors.soft }]}
                    resizeMode="cover"
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* THE PROOF CHIPS. Plain View/Text, like the delivery-area rows in
            visit-panel.tsx -- a chip that looks tappable and is not is worse
            than a chip that does not, so none of these carry onPress or a
            role. Absent entirely when nothing qualifies.

            `styles.prose` (Task 25): this is READ, not looked at, so it keeps
            the same PROSE_MAX_WIDTH measure the story card and FAQ below it
            do -- see this file's own `prose` style and the gallery's comment
            above it for the block that does NOT carry this. */}
        {proofChips.length > 0 ? (
          <View style={[styles.proof, styles.prose]} testID="storefront-about-proof">
            {proofChips.map((chip) => (
              <View
                key={chip.id}
                testID={`storefront-about-proof-${chip.id}`}
                style={[styles.chip, { backgroundColor: colors.soft }]}
              >
                <Text style={[styles.chipText, { color: colors.muted }]}>{chip.text}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* THE SHOP'S OWN VOICE, one card. This used to be two claims made
            twice -- a "Why shop here" eyebrow introducing what is really more
            of the same voice as the story above it. The merged card carries
            no second eyebrow: the highlights are the shop's own writing,
            rendered as compact `soft`-filled tiles INSIDE the `ground` card
            rather than cards of their own, absent entirely when the shop has
            written none.

            `styles.prose` added last (Task 25) so it wins over `storyCard`'s
            own `gap` without dropping it -- this card IS the paragraph the
            whole PROSE_MAX_WIDTH argument was made for (scale.ts), so it
            keeps that measure now that the gallery above it no longer forces
            the same bound on every block in this tab. */}
        <ShopCard colors={colors} style={[styles.storyCard, styles.prose]} testID="storefront-about-story-card">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>About the shop</Text>
          {/* The headline leads here, where it is the subject of the tab,
              rather than competing with the wordmark as it does on the anchor
              card. A shop with no headline leads with the story itself. */}
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

          {/* Up to three claims the shop wrote itself; the whole block is
              absent when it has written none, and one or two render at that
              count rather than padding out to three with blanks. */}
          {storefront.highlights.length > 0 ? (
            <View style={[styles.highlights, wide && styles.highlightsWide]} testID="storefront-about-highlights">
              {storefront.highlights.map((highlight) => (
                <View
                  key={highlight.id}
                  testID={`storefront-about-highlight-${highlight.id}`}
                  style={[styles.highlightCard, { backgroundColor: colors.soft }, wide && styles.highlightWide]}
                >
                  <Text style={[styles.highlightTitle, { color: colors.ink }]}>{highlight.title}</Text>
                  <Text style={[styles.highlightBody, { color: colors.muted }]}>{highlight.body}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </ShopCard>

        {/* THE FAQ, LAST -- moved inside `panel` here (alignment fix,
            post-Task-25). Task 25 left this band OUTSIDE `panel`, recreating
            `panel`'s own inset by hand with `gutter`'s `paddingHorizontal:
            SPACE.page` -- a leftover from before Task 21, when the story was
            itself a full-bleed `ground` band and every band (including this
            one) needed its own gutter because none of them could lean on a
            shared padded container. Task 21 folded the story and highlights
            into a `ShopCard` inside `panel`; this band was never migrated
            with it.

            The result: two different containers each claiming to reproduce
            the SAME inset. At narrow widths `body`'s padding + `gutter`'s
            padding happened to equal `body`'s padding + `panel`'s padding
            (16+16 either way), so the two paths coincided by coincidence --
            but a bounded, CENTRED box does not scale like a plain sum of
            paddings, so at 1440 they diverged: measured live, the FAQ's own
            question cards sat at x=326 while the proof chips and story card
            sat at x=310, 16px apart. Confirmed here in the diff: `gutter`
            and `lastBand` were used ONLY by this view (grep across the file
            and its tests), so neither was load-bearing anywhere else -- pure
            leftover, safe to delete along with the second container.

            Now the FAQ is a plain fourth child of `panel`, exactly like the
            proof chips and the story card above it: `panel`'s own padding is
            its only source of inset, and `panel`'s own `gap` is its only
            source of spacing from the story card, so all three read the
            SAME formula rather than two that happen to agree at one width. */}
        <View style={[styles.faqBand, styles.prose]} testID="storefront-about-faq">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Before you order</Text>
          <Accordion colors={colors} questions={questions} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Every top-of-tab block -- the gallery, the proof chips, the merged story
  // card, and (as of the alignment fix below) the FAQ band -- sits inside
  // this one padding+gap wrapper now that none of them is a full-bleed band
  // any more: the story is a `ShopCard` like everything else on this page,
  // so there is nothing left that needs to run full-bleed. This is now the
  // ONLY source of horizontal inset for every bounded block below (see
  // `prose`) -- no block reproduces it with a gutter of its own, which is
  // exactly the bug the alignment fix removed.
  panel: { padding: SPACE.page, gap: SPACE.cardGap },
  // THE BOUND MOVED HERE FROM shop-chrome.tsx (Task 25). Phase 4 put a
  // gallery at the top of this tab, and a photograph has no reading measure
  // to keep -- so the chrome no longer wraps this whole panel in one
  // PROSE_MAX_WIDTH column (see that file's own comment on why). Every block
  // that IS read -- the proof chips, the merged story card, the FAQ band --
  // takes this style directly instead, so each narrows to the same measure
  // the chrome used to give the panel as a whole. The gallery is the one
  // block in this file that never takes it (see its own comment above), and
  // `panel` above stays unbounded so the gallery can fill `body`
  // (shop-chrome.tsx) right up to the width `ShopFooter` already renders at.
  //
  // ALL THREE bounded blocks must resolve this identically -- same maxWidth,
  // same alignSelf, and (this is the part Task 25 got wrong for the FAQ) NO
  // paddingHorizontal of its own layered on top, because `panel` above is
  // already the one and only container supplying that inset. A block that
  // adds its own horizontal padding on top of `prose` narrows its READABLE
  // content a second time without narrowing the bounding box drawn around
  // it, which is exactly how the FAQ's question cards ended up 16px right of
  // the proof chips and story card at 1440 despite all three measuring the
  // same `maxWidth` here.
  prose: { width: '100%', maxWidth: PROSE_MAX_WIDTH, alignSelf: 'center' },
  // THE FAQ BAND's only own style now: the 12px gap between its "Before you
  // order" eyebrow and the accordion beneath it -- the same role `storyCard`
  // below gives its own children. No padding of any kind: `panel` above
  // supplies this band's inset and its spacing from the story card above it
  // (via `panel`'s own `padding` and `gap`), the same as it already does for
  // the proof chips and the story card. See the alignment-fix comment at
  // this band's call site for the full story of why that used to be two
  // different containers instead of one.
  faqBand: { gap: 12 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  title: {
    fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 31, fontWeight: '700',
    letterSpacing: LETTER.displayLoud,
  },
  titleWide: { fontSize: 34, lineHeight: 39 },
  story: { fontSize: TYPE.body + 1, lineHeight: 22 },
  gallery: { gap: SPACE.gap },
  galleryLead: { width: '100%', aspectRatio: 16 / 9, borderRadius: RADIUS.inset },
  // The strip: one line under the cover, never lettered over the photo -- see
  // `caption`'s own comment above. `metaSmall` is this file's smallest legible
  // step, the same size a pill label uses (scale.ts), which is exactly the
  // register a location line under a photo asks for.
  caption: { fontSize: TYPE.metaSmall, marginTop: 6 },
  // Wraps, so four or five photographs fill rows instead of shrinking to fit
  // one. `flexBasis` rather than a fixed width: several per row on a phone,
  // more on a laptop, with no breakpoint to keep in step.
  galleryRest: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.gap },
  // A FIXED HEIGHT, AND A CEILING ON THE WIDTH -- measured, not guessed.
  //
  // This was `flexGrow: 1, flexBasis: 140, aspectRatio: 1`, and the pair is a
  // trap at low photo counts: `flexGrow` makes a LONE thumbnail take the whole
  // column, and `aspectRatio: 1` then makes it that TALL. Measured in a browser
  // on a shop with exactly two photos -- the common case, and the seeded one --
  // it drew 326x326 at 390px and 788x788 at 1440px, a thumbnail nearly twice
  // the height of the 16:9 cover above it, which pushed the proof chips to
  // y=1345 and off the first screen on every laptop. The whole point of the
  // re-weighting is that a stranger meets the photos and then the proof; a
  // thumbnail that outgrows its own cover defeats it.
  //
  // No test in this repo can see this -- nothing lays out here -- so the height
  // is stated rather than derived: a thumbnail is a fixed strip under the
  // cover, the way both mockups draw it. `maxWidth` is what stops one photo
  // spanning 788px of laptop; the row simply left-aligns when there are fewer
  // thumbnails than fill it.
  galleryThumb: {
    flexGrow: 1, flexBasis: 104, maxWidth: 168, height: 76, borderRadius: RADIUS.inset,
  },

  // THE PROOF CHIPS' ONE SHAPE, matching shop-directory-card.tsx's sell tags
  // exactly (radius 8, weight 700, size 10.5, `soft` fill, `muted` text) --
  // that file's own comment explains why a card gets exactly one chip
  // vocabulary rather than a second one invented per surface.
  proof: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 10.5, fontWeight: '700' },

  // The merged card gets its own internal rhythm -- the same 12px a `band`
  // used to give the story its gap from the gallery beneath it.
  storyCard: { gap: 12 },
  // Stacked on a phone and a row of three on a laptop. NOT a wrapping grid:
  // three cards of different copy lengths wrap into a ragged second row at
  // exactly the widths this page is most read at.
  highlights: { gap: SPACE.gap },
  highlightsWide: { flexDirection: 'row', alignItems: 'stretch' },
  highlightWide: { flex: 1 },
  // `RADIUS.inset`, a step tighter than the card's own `RADIUS.card` -- these
  // are tiles INSIDE `storyCard`, not cards of their own (see the merged
  // card's own comment above), so they take the "a photo or a plate inside a
  // card" radius and a `soft` fill rather than the `ground` fill a sibling
  // `ShopCard` would need to read as distinct from the card holding it.
  highlightCard: { borderRadius: RADIUS.inset, padding: SPACE.cardGap },
  highlightTitle: { fontSize: TYPE.body + 2.5, fontWeight: '800', letterSpacing: LETTER.display },
  highlightBody: { fontSize: TYPE.body, lineHeight: 20, marginTop: 7 },

  faq: { gap: 8 },
  q: { borderRadius: RADIUS.inset, overflow: 'hidden' },
  // Measured live at 51.5px -- the question text's own line height plus this
  // padding already clears the floor -- but, like `contact` in
  // visit-panel.tsx, nothing here stated that before this: no literal height,
  // no hitSlop, so a control genuinely built to 26px would have looked
  // identical to the sweep. `minHeight` names the floor this toggle already
  // meets.
  qHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 14, paddingHorizontal: 18, paddingVertical: 15, minHeight: TOUCH_TARGET,
  },
  qText: { flex: 1, fontSize: TYPE.body + 0.5, fontWeight: '700', letterSpacing: LETTER.display },
  qMark: { fontSize: 18, fontWeight: '700' },
  qBody: { fontSize: TYPE.body, lineHeight: 20, paddingHorizontal: 18, paddingBottom: 17 },
});
