# Storefront visual refresh — design

**Date:** 2026-08-30
**Status:** Partly built — the three defect fixes have shipped; the design work is still awaiting review
**Mockup:** `docs/design/storefront-visual-refresh-mockup.html`
**Scope:** A visual pass on the public storefront's three themes and the editor's
design picker. No change to what a shop can edit, where content comes from, or
what a customer can do.

## Problem

The storefront shipped its behaviour first and its surface last. Everything works
— cart, checkout, flyers, WhatsApp, delivery areas — and the page it all happens
on has three specific weaknesses, one of which is a live accessibility defect.

**Two colour literals escaped the palette system.** `#1f7a4d` and `#8a5a05` are
typed into `product-tile.tsx:56` and `theme-counter.tsx:132` as the in-stock and
out-of-stock colours, fixed across all six palettes. Both collide:

- `#8a5a05` **is** Saffron's `accent` (`storefront-catalog.ts:58`), byte for byte.
  On a Saffron shop "Out of stock — ask us" is the same colour as the Add button
  and the section rule — the notice reads as an action. The codebase already
  knows: `storefront-catalog.test.ts:68` asserts `danger !== '#8a5a05'` to keep an
  error from looking like a stock notice. The guard went on `danger`; the literal
  that caused it was left alone.
- `#1f7a4d` **is** `WHATSAPP_BUTTON_GREEN` (`storefront-catalog.ts:139`) — which
  the catalogue's own comment describes as deliberately not themeable, "a
  recognised affordance, not a brand colour". Today the words "In stock" wear the
  affordance colour, one line above an Ask button wearing the same green.

**Window's hero puts near-black type on an arbitrary photo with no scrim.**
`theme-window.tsx:78-86` lays `heroImageUrl` across the panel with
`StyleSheet.absoluteFill`, then renders the headline in `colors.ink`. A shop that
uploads a dark or busy photo gets an unreadable headline. With no photo the same
panel is a flat `colors.soft` rectangle with 24px of padding and nothing to
justify its height.

**Market has no way into a long catalogue.** It is the default theme, so it is
where every shop lands. It goes from the about paragraph straight to an
undifferentiated grid. Counter groups by `products.category`; Market reads
category only as a flyer filter target.

## Relationship to the handed brief

This spec was commissioned from a brief written against a different storefront —
five named designs, a fixed juniper/parchment palette, three Google-hosted font
families, a 900px breakpoint. Four of its asks do not survive contact with this
codebase, and saying so is part of the deliverable:

| Brief | Why not |
|---|---|
| Fixed brand tokens (`--juniper`, `--parchment`) | Storefront colour belongs to the shop — six palettes, contrast-checked in `storefront-catalog.test.ts`, with `muted` and `danger` derived rather than picked. A fixed palette deletes the feature. |
| Fraunces / Inter / IBM Plex Mono | No custom fonts load anywhere. `expo-font` is a dependency with no `useFonts` call and no `assets/fonts`. This is React Native, not a `<link>` tag. |
| Five designs (Grid catalogue, Campaign, …) | Three layouts × six palettes. Renaming or adding one is a product change, not a visual pass. |
| 900px breakpoint | `gridColumnsForWidth()` already owns this at 640/1024. A fourth number means two answers at 900px. |
| Three stock states (`ok`/`low`/`no`) | There are two. A low-stock threshold is a product decision, not CSS. |

Everything else in the brief is adopted below, translated into this system. The
brief's diagnosis was largely right; only its vocabulary was wrong.

## Decisions

### Colour the storefront cannot pick, it derives

`paletteColors()` gains `stockOk` and `stockOut`, built exactly the way
`dangerInk` already is: anchor on a conventional colour, blend `0.12` toward that
palette's own `ink` so the token is genuinely computed *from* the palette rather
than a constant reused six times, then walk it through
`stepUntilContrast(…, ground, 4.5)`.

The anchors stay at today's literals — `#1f7a4d` and `#8a5a05` — so the familiar
green and amber are the *starting* point rather than the shipped value. Run
against the six palettes, the derivation gives:

| Palette | `stockOk` | ratio | `stockOut` | ratio |
|---|---|---|---|---|
| ink | `#1e6e47` | 6.22 | `#7c5207` | 6.85 |
| palm | `#1d6f47` | 5.97 | `#7c5308` | 6.59 |
| clay | `#206e46` | 5.97 | `#7e5207` | 6.52 |
| sea | `#1d6f49` | 5.96 | `#7b5309` | 6.62 |
| saffron | `#206f46` | 5.93 | `#7e5306` | 6.49 |
| plum | `#1f6e48` | 5.99 | `#7e5208` | 6.54 |

Every palette clears 4.5:1 with headroom, and **the Saffron collision is gone** —
`#7e5306` is no longer that palette's accent, because the token is now a function
of Saffron rather than a constant that happened to equal it.

`PaletteColors` grows two fields. Nothing at a call site picks a colour.

**Be honest about what this does *not* fix.** A 0.12 blend barely moves a green
that is already close to the palette's ink, so `stockOk` lands within ~4% of
`WHATSAPP_BUTTON_GREEN` on every palette. A `stockOk !== WHATSAPP_BUTTON_GREEN`
assertion would pass and prove nothing. The in-stock label is separated from the
Ask button by **shape and weight, not hue**: a light wash pill with dark green
type against a saturated green button with white type. If genuine hue separation
is wanted, that is an anchor change, not a derivation change — see the open
question below.

### Resolved — in-stock keeps its words and loses its colour

Settled during build, and it changed the shape of the fix.

Removing the in-stock signal outright was wrong: "do they actually have it?" is
the question this page exists to answer, and absence-as-signal only works for a
customer who already knows the convention. But colouring the state that ~90% of
products are in spends the page's scarcest signal where it carries no
information — and on Counter's 200-row list it buries the handful of sold-out
rows a customer is actually scanning for.

So the state is **demoted from colour to type**: "In stock" keeps its words, set
in `ink`; "Out of stock" gets the pill and the derived amber. That kills the
WhatsApp-green resemblance by removing the green entirely, rather than
explaining away a 4% difference — and it means **`stockOk` was never needed**.
One new token, not two.

The pill says **"Out of stock"**, not "Ask us": the Ask button sits directly
beside it, so the pill should carry the state and let the button carry the
action.

### Superseded — the original open question

Worth settling before build. Most products, most of the time, are in stock, so a
green pill on nearly every tile is decoration that carries no information. The
alternative is to mark only the exception: out-of-stock gets the pill, in-stock
gets plain `muted` body text or nothing at all. That removes the WhatsApp-green
resemblance entirely by removing the green, and makes the one state a customer
must notice the only one wearing colour.

`stockOk` is still worth deriving either way — Counter's dense price list may want
it where a grid tile doesn't. **Recommendation: mark the exception only.** Flagged
rather than decided because it changes what a customer sees, which puts it a step
past a visual pass.

### Shape carries the state; colour is the second signal

Both stock states become pills — `borderRadius: 999`, 9.5px/800 — filled with the
token's own wash (the token blended `0.86` toward `ground`) and inked with the
token. This is the same rule bento applies to `bentoProfit`/`bentoLoss`: a figure
in a status colour with no shape or glyph is colour alone doing the work, and
green/red is ΔE 4.0 for a deutan viewer.

Prices gain `fontVariant: ['tabular-nums']` so a column of them scans as a column.

### Window's hero becomes a wordmark, and gets a scrim

Two states, one component:

- **No photo** — a radial gradient `ground → soft`, derived from the palette, not
  a fixed parchment. The shop name is set as the wordmark; an eyebrow line
  composed from `city` and `collectLocation()` sits under it, then the headline
  and about as body copy. Both eyebrow sources are already on
  `PublicStorefront` and at least one is populated for every shop, so the line is
  never blank.
- **With photo** — full-bleed image, scrim
  `linear-gradient(180deg, transparent 42%, rgba(0,0,0,.55))`, type flips to
  white.

The scrim is the fix for the legibility defect. The wordmark is what makes the
panel earn its height. They are one change because the second is worthless
without the first.

A customer arriving on a forwarded WhatsApp link needs to know whose page this is
before anything else speaks — today the shop name is 15px and tracked out above a
28px headline. The wordmark inverts that.

### Market gets a category band, driven by state that already exists

Above the grid: "Shop by category", tiles at `aspect-ratio: 4/5`, radius 11, dark
scrim, name plus live product count.

**Tapping a tile sets the same `category` state a flyer already sets.** No new
state, no new filter, no new way out — `filterByCategory` and
`CategoryFilterBar` are reused verbatim, which means the "showing X only · show
everything" affordance is already correct for this entry point.

Two rules on when it renders:

- **2+ categories with in-stock products, or no band.** One category is a filter
  to everything.
- **Market and Window only. Counter gets no band** — it already groups by
  category, and it is the theme a shop picks when it wants density. This is the
  same reasoning that keeps flyers off Counter, pinned in
  `storefront-flyer-placement.test.tsx`.

Tile art comes from `categories.image_url` (migration `0016`) where the shop has
set one, and a gradient seeded from the palette's accent where it hasn't. **The
no-photo case is the majority case and must not look like an error** — the same
principle as `ProductTile`'s no-photo branch, which sets the product name large on
`soft` rather than showing a broken-image box.

### Type roles without shipping a font

Three roles, one system face:

| Role | Spec | Used by |
|---|---|---|
| Display | 800, −0.9 tracking, 19–32px | wordmark, hero headline, section and category heads |
| Body | 400/600, 0 tracking, 12.5–14px | product names, about, checkout copy |
| Meta | 800, +0.09em, uppercase, 9.5–11px, tabular-nums | prices, stock pills, counts, eyebrows |

A display serif is deferred, not rejected. Its real cost is not the file: it is
that every hero and section head reflows on native at a different metric, so
Window's hero and Counter's section rules need re-verifying on device. Worth doing
deliberately; not worth smuggling into a colour pass.

### The picker shows what you are choosing

`design-strip.tsx`'s selected state is already strong — the tile inverts to
`bentoInk`. The weakness is that neither row shows you the thing itself: a layout
is prose, a palette is three 18px dots.

- Layout tiles gain a 52px wireframe of the actual layout above the label.
- Palette swatches go from 18px dots to a 44px three-band strip, with the accent
  band widened — it is the band the shop is really choosing.
- Selected gains a `✓` alongside the existing inversion.

Both rows stay **derived from `THEMES` / `PALETTES`**. A seventh palette still
needs no change here.

## What this needs that isn't component-local

The category band is the only item with a backend cost.

- **A public category read.** A function beside `get_public_storefront_products`
  returning `name`, `image_url` and a live in-stock product count, joining
  `categories` to `products.category` **by name** — they are not FK-linked
  (`0004_categories_tags.sql`: "products.category/tags are free text"). Must be
  `anon`-callable and must respect the same published-only gate the products
  function does. Adding it to the narrowed anon surface
  (`20261009000100_narrow_the_anon_rpc_surface.sql`) is a deliberate line, not a
  side effect.
- **Preview parity.** The editor reads products admin-side through
  `getStorefrontPreviewProducts` precisely because the public RPC returns nothing
  while `published_at is null` — which is exactly when a shop first looks at the
  preview. Categories need the same admin-side twin, or the band is empty on the
  one run it matters.
- **Tests for the two new tokens.** `storefront-catalog.test.ts` gains ≥4.5:1 on
  all six palettes for both, plus `stockOut !== accent` — the Saffron collision,
  pinned so it cannot come back. Deliberately **no**
  `stockOk !== WHATSAPP_BUTTON_GREEN` assertion: it would pass on a ~4% difference
  and read as a guarantee the colour does not provide.

## Content model — unchanged

Stated because the brief asked for it to be confirmed:

- **Editable per shop:** shop name, headline, about, hero photo, WhatsApp number,
  slug, layout, palette, flyers, delivery areas. All already wired through
  `patchDraft` to the server-side draft.
- **Read-only, backend-synced:** products — name, price, stock, photo, category.
  Nothing in this pass makes a product editable from this screen.
- **Per shop, saved as a setting:** layout and palette, `storefronts.theme` and
  `.palette`, CHECK-constrained, unknown values falling back on read.

Nothing here is hardcoded today, so the brief's "flag it separately if it is" has
nothing to flag.

## Past the visual pass — six things that matter more

Everything above fixes how the storefront *looks*. These fix how it *feels*, and
the first three are worth more than the rest of this spec.

The subject drives all of them: this page arrives as a forwarded WhatsApp link,
opens in an in-app browser, on a phone, often on a slow connection, for a customer
who usually already knows the shop. They want what is in, what it costs, and how
to get it — and they will pay a person, not the page. Latency and touch response
matter more than ornament.

### 1 · Nothing responds to touch

**Not one `Pressable` in the storefront has a pressed state** — no `style`
callback, no `android_ripple`, anywhere in `src/components/storefront/`. Tap Add
and nothing happens until a count changes in the corner; on a slow phone the
customer taps again and adds two.

One helper in `theme-shared.tsx` — scale `0.97` and reduced opacity for the press
duration, `android_ripple` in `colors.accent` on Android, no transform under
`prefers-reduced-motion` — applied in a single pass to Add, Ask, Cart, the
checkout bar, the category chip and the sheet close. Roughly fifteen lines for the
largest felt change available.

### 2 · The shop's own words are thrown away

`products.description` is selected by `get_public_storefront_products`, mapped at
`storefront.ts:148`, and **rendered by no theme at all**. Shopkeepers type it and
no customer has ever seen it — dead data already paid for on every page load.

Give it a product sheet: tap a tile (which is every customer's instinct, and the
tile is not currently pressable at all) for a larger photo, the price, the stock
pill, the description, the category, and Add/Ask. No new RPC, no new column.

### 3 · First paint is a white screen and a spinner

`store/[slug].tsx:67-73` renders a bare `ActivityIndicator` on `#ffffff`. That is
the first second of *every* visit, over the slowest connection in the flow.

Replace with a skeleton in the grid's real shape so the layout doesn't jump when
data lands. **Honest constraint:** the palette arrives *with* the fetch, so the
first paint cannot be in the shop's colours without shipping theme and palette
ahead of the payload. The skeleton is therefore neutral and earns its place on
layout stability, not branding. Colouring it properly is separate, larger work
about what the server sends first.

### 4 · No way to find anything

Counter exists for "a long catalogue with no photos" — a 200-line pharmacy — and
there is no search on the public page at all. The theme built for scale has the
least navigation.

A sticky field under the nav filtering name and category, using the same
case-insensitive trim `filterByCategory` already applies. Counter first; Market
and Window past a product-count threshold rather than always.

### 5 · Three themes, three unrelated scales

Shop name is 19 / 15 / 18 px across Market / Window / Counter; page padding is
14 / 16 / 14. Nothing is wrong individually — but there is no system, which is
*why* the set reads unfinished.

| Role | Today | One scale |
|---|---|---|
| Shop name | 19 / 15 / 18 | **19** — Window keeps its uppercase tracking; the treatment is the theme's, the size isn't |
| Hero headline | 22 / 28 / 19 | **22 / 28** — Window is deliberately the loud one; Counter stops being a third value |
| Body | 13 / 13.5 / 13 | **13.5** |
| Page padding | 14 / 16 / 14 | **16** — Window is right; the others are cramped |
| Meta / eyebrow | 11 / 11.5 / 11.5 | **11**, with `+0.09em` tracking per §type roles |

### 6 · The empty state is a full stop

"Nothing listed yet." — on a page whose whole purpose is to start a conversation,
next to a WhatsApp number it declines to offer. Make it an invitation: say the
shop is still going online, and give the number that is already on the page
object.

### If only three ship

**1, 2 and 3.** Touch feedback changes how every screen feels for about fifteen
lines. The product sheet turns data the shop already typed into the reason a
customer stays. The loading state is the first second of every visit — the one
moment no polish further down the page can reach.

## Acceptance

- [ ] No `#1f7a4d` / `#8a5a05` literal survives in `product-tile.tsx` or
      `theme-counter.tsx`; both colours come from `paletteColors()`
- [ ] Both new tokens clear 4.5:1 on all six palettes, asserted in
      `storefront-catalog.test.ts`
- [ ] `stockOut !== accent` on Saffron, asserted
- [ ] The "does In stock need a colour" question above is answered before build
- [ ] Stock state survives greyscale — pill shape and wording carry it
- [ ] Window's hero is legible over a dark uploaded photo, verified on device
- [ ] Window's hero with no photo looks intentional — the test every theme in this
      set had to pass
- [ ] Category band renders only at 2+ categories with stock, and only on Market
      and Window
- [ ] Tapping a category drives the existing `filterByCategory` state, with
      `CategoryFilterBar` as the way back out
- [ ] A shop with no category photos gets gradient tiles that read as designed
- [ ] Band and grid column counts both come from `gridColumnsForWidth`
- [ ] Picker rows still derived from `THEMES` / `PALETTES`
- [ ] Verified on web, iOS and Android — this pass touches RN layout

Separately, if the "past the visual pass" items are taken:

- [ ] Every `Pressable` in `src/components/storefront/` has a pressed state, and
      none animates under `prefers-reduced-motion`
- [ ] `products.description` is rendered somewhere a customer can reach
- [ ] The public page's first paint is not a spinner on white
- [ ] Counter has a working search over a 200-product catalogue
- [ ] The three themes share one type and spacing scale

## Not in scope

A display serif. A low-stock third state. A 900px breakpoint. Renaming, adding or
removing a layout or palette. Any change to what a shop can edit, or to the
cart/checkout/order path.
