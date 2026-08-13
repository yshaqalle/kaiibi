# Marketing and offers — design

**Date:** 2026-08-12
**Mockups:** [`docs/design/marketing-mockup.html`](../../design/marketing-mockup.html) ·
[`docs/design/pos-offers-mockup.html`](../../design/pos-offers-mockup.html) ·
[`docs/design/promotion-poster-mockup.html`](../../design/promotion-poster-mockup.html)

## The problem

Kaiibi stores promotions and applies them at the till. Nothing tells a customer they exist, and
nothing records which promotion produced a discount.

Three specific gaps, all confirmed against the code:

1. **No reach.** `promotions` has no consumer outside the POS cart. A shop can run a 20% weekend sale
   and the only people who find out are the ones who happened to walk in.
2. **No memory.** `sale_items.discount_cents` stores the amount. `promotion_id` does not exist anywhere
   in the schema. The till can say *20% came off* and cannot say *which offer did it*.
3. **No window.** `promotions` has `active` and nothing else. A short-term offer is switched on by hand
   and stays on until somebody remembers to switch it off.

There is also a live gap that is independent of all of the above: `permissions.ts` has no discount
permission, so any cashier at any till can type any discount onto any sale, and nothing records why.

## What already exists, and is reused unchanged

| Thing | Where | Reused for |
|---|---|---|
| `promotions` table + CRUD | `supabase/migrations/0013`, `src/lib/promotions.ts` | Everything here |
| Auto-apply, best-deal-wins | `bestPromotionForProduct()` in `src/lib/discounts.ts` | The single gate the window is added to |
| WhatsApp deep link + SO number normalization | `src/lib/whatsapp.ts` | Campaign sending, reachability |
| Customer segments | `src/lib/customer-segments.ts` | Campaign audiences |
| Two-pane list/detail | `TwoPaneListDetail` | Campaign list and detail |
| HTML → PDF pipeline | `src/lib/receipt.ts` + `expo-print` | The poster |
| Kaiibi branding rule | `receipt_branding_removal` module, `src/lib/kaiibi-mark.ts` | The poster's mark |
| `promotions` module gate | `src/lib/entitlements.ts` | Gates the whole Marketing tab |

No new module is added to the entitlement catalog. Marketing is part of `promotions`.

## Decisions

These were open at the end of brainstorming and are settled here. Each is reversible; each is called
out so a reviewer can disagree with a specific line rather than the whole document.

**The cashier picks which offer, never how much.** Selecting an offer reads `discount_type` and
`discount_value` off the promotion row and passes them to the existing `discountAmountCents()`. There
is no number to type. This is what makes a discount permission expressible for the first time.

**Auto-apply is not replaced by a dropdown.** A store-wide 20% must not depend on a busy cashier
remembering to select it — forget it once and the customer is overcharged, which is worse than missing
attribution. A new `auto_apply` flag splits the table: `false` means the offer never fires on its own
and appears in a picker instead. The picker holds four or five entries, not forty.

**"Marked sent", never "Delivered".** A `wa.me` link is a one-way door — no callback, no return value.
The only honest signals are a tap the owner made and a sale rung up under a customer's name. See
*Metrics* below.

**The customer prompt asks; it never auto-applies.** One tap, and a cashier who did not know the offer
existed learns something. Auto-applying would be faster and would remove the only place a campaign
redemption can be recorded deliberately.

**An offer can be applied with no customer attached.** Someone who walks in quoting the message but is
not in the directory still gets their discount. The report says "claimed, no customer attached" rather
than pretending otherwise.

**Facebook, Instagram, TikTok and X get a poster, not an integration.** Posting on a shop's behalf needs
an OAuth flow per network, a Meta app review, a paid X tier and TikTok's approval-gated content API —
weeks of work and per-shop onboarding, to save one tap. Out of scope, and the poster is the reason it
can wait.

**The WhatsApp Business Cloud API is out of scope.** The campaign, audience and message model is
designed so that only the *sender* changes when a shop connects one. Typical campaign size was never
established; the deep-link queue is correct for tens of recipients and painful for hundreds, and if
real usage lands in the hundreds this decision should be revisited before Phase 3 ships.

**The shop's colour is a shop setting, not a poster setting.** Otherwise an owner re-picks their own
brand every time they run a sale.

## Architecture

Four units, each usable on its own, built in order. Phase 1 is the foundation; 2 and 3 are independent
of each other; 4 needs 1 and 3.

```
Phase 1  Promotion foundations   ── window, auto_apply, attribution, discount permission
   │
   ├── Phase 2  Poster           ── brand colour, templates, PDF/PNG, share
   │
   └── Phase 3  Campaigns        ── audience, message, send queue, metrics
              │
              └── Phase 4  Till offers  ── picker, customer prompt, redemption
```

---

## Phase 1 — Promotion foundations

One new screen — the Marketing tab, containing only the promotions editor, which moves here from
Settings. It is the shell Phases 2 and 3 fill in. Everything else in this phase is worth having whether
or not Marketing ships at all.

### Schema

```sql
alter table public.promotions
  add column starts_at   timestamptz,
  add column ends_at     timestamptz,
  add column auto_apply  boolean not null default true,
  add column archived_at timestamptz;

alter table public.promotions
  add constraint promotions_window_ordered
    check (starts_at is null or ends_at is null or ends_at > starts_at);

alter table public.sale_items
  add column promotion_id   uuid references public.promotions(id) on delete set null,
  add column promotion_name text;
```

- `starts_at` null means *already running*. Set, and the promotion reads as **Scheduled**, applies
  nothing, and opens itself at the minute given — Thursday's sale is built on Tuesday.
- `ends_at` null means *until I turn it off*, the current behaviour, still right for a standing loyalty
  discount. Set, and it stops applying on its own.
- `active` is unchanged and remains the hard "off now" override. A promotion applies only when it is
  active **and** inside its window.
- `auto_apply` default `true` preserves every existing row's behaviour exactly.
- `archived_at` is a third, distinct state and must not be confused with the other two: `active = false`
  is *paused, may come back*; `ends_at` in the past is *this run is over*; `archived_at` is *gone from
  every list, kept only so old sales still read*. An archived promotion never applies and never appears
  anywhere but a past receipt.
- `promotion_name` is the same pattern `sale_items` already uses for `product_name`: the receipt and the
  report still read correctly after the promotion is expired, renamed, archived or deleted. The FK is
  `on delete set null` so a delete can never break a sale.

### Behaviour

`bestPromotionForProduct()` in `src/lib/discounts.ts` is the single gate every cart line passes through.
It gains two comparisons in the same predicate that already checks `active`, so the product tile badge,
the cart line and the total can never disagree about whether an offer is live. It also gains an
`auto_apply` filter, since a manual-only offer must not fire by itself.

The function takes the current time as a parameter rather than calling `Date.now()` internally, so the
window is testable without mocking the clock.

`appliedPromotionForLine()` already returns the winning promotion and the client already throws it away.
`buildSalePayload()` in `src/lib/cart.ts` starts including `promotion_id` and `promotion_name` per line
alongside the `discount_cents` it already sends.

`complete_sale` and `edit_sale` read the two new keys out of the existing `p_items` jsonb — **no
signature change**, so no new overload and no grant churn. Both functions must be reproduced at their
full current body with only the two new columns added to the `sale_items` insert; see the Global
Constraints note in migration `0023_customers.sql` on `CREATE OR REPLACE FUNCTION`.

`edit_sale`'s snapshot in `sale_edits.previous_snapshot` gains the two fields, so editing a sale does not
silently drop which offer applied.

### Discount permission

A new permission in `src/lib/permissions.ts` governing the free-form discount editor. Two levels, because
the useful distinction is between choosing and inventing:

- **may apply offers** — the picker and the customer prompt.
- **may enter a discount** — `discount-editor.tsx`, where a cashier types a number.

Both are defined and granted in this phase, and *may enter a discount* is enforced here, since the
free-form editor already exists. *May apply offers* has nothing to gate until Phase 4 and is inert until
then — defined now so the two ship as one coherent pair rather than a permission catalog that changes
twice.

Today everyone effectively holds both. Existing roles are migrated holding both, so nothing a shop
currently does stops working; an owner narrows it deliberately. Enforced in the DB write policy as well
as the client, matching `20260818000400`'s module gates.

### Delete becomes archive

`deletePromotion()` hard-deletes today. It becomes: hard delete if the promotion has never been applied
to a sale, set `archived_at` otherwise. An owner should not be told "you cannot remove this, it was used
400 times", and equally should not be able to blank 400 rows of history by accident. The two outcomes
look identical in the UI — the promotion is gone from the list either way.

### Editor moves

The promotions editor moves from `Settings → Sales & promotions` into a new **Marketing** tab under
People — a fifth `PeopleTab`, gated on the existing `promotions` module plus `settings.access`, so an
owner holding one but not the other never sees a half-working tab. Not a customers permission, as an
earlier draft of this section said: `settings.access` is what the promotions table's own RLS write
policy requires (migration 0024), and anything looser would open an editor whose saves the database
then refuses. Same table, same module gate, no migration. Settings keeps a read-only summary that
deep-links across, carrying the same module gate — without it, a shop whose plan lacks `promotions`
gets a button onto a tab it is bounced off. The editor gains the window fields and the `auto_apply`
toggle.

### Phase 1 acceptance

- A promotion with `ends_at` in the past applies to nothing, in the cart, on the tile and in the total.
- A promotion with `starts_at` in the future reads as Scheduled and applies to nothing.
- `active = false` beats any window.
- A completed sale's `sale_items` rows carry the id and the frozen name of whichever promotion applied.
- Deleting a used promotion archives it; the past sale still reads correctly.
- A cashier without *may enter a discount* cannot open the free-form editor, and the DB refuses the write
  if they somehow do.

---

## Phase 2 — Poster

Mockup: `promotion-poster-mockup.html`.

### Platform reality, checked against SDK 57

This is the constraint that shapes the phase.

| Output | Native (iOS/Android) | Web |
|---|---|---|
| A4 PDF | `expo-print` `printToFileAsync`, custom `width`/`height` in points | Opens the print dialog; **returns no file** |
| Square / story PNG | `react-native-view-shot` `captureRef` | **Not supported** — the library is Android/iOS only |
| Print | `printAsync` | Works |

So the poster's *file* output is a native capability. Web gets Print. That is acceptable: sharing a
poster to WhatsApp status or a feed is a phone activity, and the owner is holding the phone. Image
download on web is explicitly out of scope for this phase.

`react-native-view-shot` is installed with `npx expo install react-native-view-shot` and is included in
Expo Go. `PixelRatio.get()` must be divided out to hit a true 1080px export — see the SDK 57 page.

### Templates

Four, driven entirely by promotion data. Not a canvas: a layout the shop can drag things around on
guarantees posters with the price behind the logo, and support requests about both.

- **Bold** — dark ground, the number carries it. Reads across a street.
- **Market** — the shop's colour as the full ground.
- **Quiet** — paper and hairlines, for a boutique or a pharmacy.
- **This week** — every promotion inside its window on one sheet. The only template that is not
  per-promotion, and the one that actually belongs on a shop door.

Three shapes per template, re-laid out rather than scaled: square 1080×1080, story 1080×1920, A4.

### Content provenance

Everything on the poster comes from data, so it can never contradict the till.

| On the poster | Source |
|---|---|
| The number | `discount_value`, `discount_type` |
| What it applies to | `scope`, `scope_value` |
| The dates | `starts_at`, `ends_at` — no window, no date line printed |
| Shop name, logo | Existing receipt branding. `logoUrl` is a remote URL, which `WKWebView` accepts; only *local asset* URLs need base64 inlining on iOS |
| Branch, address, hours | Location record and store hours, optional per poster |
| "Made with Kaiibi" | `receipt_branding_removal` module via `kaiibi-mark.ts` — the same rule receipts use |
| Headline | The one free-text field, capped short. "Ciid wanaagsan" cannot be derived from a discount row |

Language is Somali, English, or both stacked — a fixed phrase per language, not a translation of free
text, so it is always idiomatic.

### Colour

```sql
alter table public.shops add column brand_color text;  -- nullable hex, e.g. '#5B31B5'
```

A full picker: preset swatches, a hue/depth/light slider set built from plain Views (no dependency, and
better for a finger on a counter tablet than a wheel), and a hex field. `<input type="color">` on web.

**The text colour is not the shop's to pick.** The Market template makes the chosen colour the entire
ground; left free, a bright brand yellow gets white type on a sheet meant to be read from across a
street. Kaiibi computes the colour's relative luminance and selects white or near-black ink. The same
colour must also work as *accent text* on Bold's dark ground, where a deep navy vanishes, so it is
stepped lighter or darker until it clears — the same reasoning `theme.ts` documents for its own tokens.

A new `src/lib/contrast.ts`: hex parsing, WCAG relative luminance, `inkFor(ground)`, `stepUntilClears()`.
Pure functions, no React, directly unit-testable. This is the phase's one piece of real logic and it
should be TDD'd against known WCAG pairs.

The picker never blocks and never scolds. If a colour had to be stepped, the chip says so quietly.

### Phase 2 acceptance

- Every template renders at all three shapes with no clipped text at any supported discount value,
  including `$1,250 off` and `5%`.
- A promotion with no window prints no date line.
- Ink flips correctly at the luminance boundary; `contrast.ts` unit tests cover known WCAG pairs.
- A shop on a branding-removal plan gets no Kaiibi mark; every other shop does.
- Web offers Print and does not offer a broken Save.

---

## Phase 3 — Campaigns

Mockup: `marketing-mockup.html`.

### Schema

```sql
create table public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  promotion_id uuid references public.promotions(id) on delete set null,
  name         text not null,
  message_en   text,
  message_so   text,
  audience     jsonb not null,          -- segments, tags, location, inactive-days
  status       text not null default 'draft'
                 check (status in ('draft','sending','done')),
  created_at   timestamptz not null default now()
);

create table public.campaign_recipients (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  customer_id  uuid not null references public.customers(id) on delete cascade,
  state        text not null default 'waiting'
                 check (state in ('waiting','opened','sent','skipped','unreachable')),
  opened_at    timestamptz,
  sent_at      timestamptz,
  unique (campaign_id, customer_id)
);
```

Both shop-scoped under the same RLS shape as `customers` (`is_shop_member`), both behind the
`promotions` module gate.

`audience` is stored as a filter, not a frozen list. Recipient rows are materialised when sending starts
and **topped up each time the queue is opened**: the filter is re-evaluated and any newly-matching or
newly-reachable customer is inserted as `waiting`. The unique constraint on
`(campaign_id, customer_id)` makes that top-up idempotent, so nobody is queued twice. This is what makes
"fix a phone number and they join the queue" true rather than aspirational.

Removal is deliberately not symmetric: a customer who stops matching the filter mid-campaign keeps their
row. Deleting someone from a queue the owner is halfway through would silently change the denominator
they are working against.

### Audience

`segmentForCustomer()` unchanged, plus a "no purchase in N days" filter derived from sales. No new
segment concept and no schema field for one. Reachability uses `whatsappLink() !== null` — the same rule
the button uses, so the count can never disagree with what the button does.

### Message

One message with `{name}` `{shop}` `{offer}` `{ends}` `{branch}`, filled per recipient at open time.
`{ends}` reads `ends_at` rather than a date typed into text that then goes stale. Somali and English are
two columns on one campaign, not two campaigns.

### The send queue

One recipient at a time through the existing `openWhatsApp()`. On return to foreground, an `AppState`
listener asks *"Did that send to X?"* — one tap. Ignored, the row stays at `opened`, which is true and
visibly weaker than `sent`. Nothing is inferred from how long the app was backgrounded.

The queue paces deliberately and suggests a break every twenty. Numbers that fan out to dozens of
non-contacts in a burst get rate-limited or banned by WhatsApp; this is a real constraint, not a UI
flourish.

### Metrics

Each figure names its own source. Nothing is displayed that the app did not watch happen.

| Shown | Source | |
|---|---|---|
| Reachable | `whatsappLink()` returns a URL | pure function of the stored number |
| Chat opened | we called `openWhatsApp()` | our own tap |
| Marked sent | the owner answered on return | attested, correctable |
| Bought within 7 days | a sale with that `customer_id` after `sent_at` | our own data |
| Delivered / Read / Failed | — | **not available, not shown** |

*Bought within 7 days* is a correlation, and the tile says so — the customer may have been coming anyway,
and walk-ins get the same discount. It also depends on cashiers attaching customers to sales; a shop that
rings most baskets up anonymously will see a figure that says more about checkout habits than about the
campaign. Worth measuring the current `customer_id` attach rate before this becomes the headline number.

### Phase 3 acceptance

- A campaign with 0 reachable customers cannot be started, and says why.
- Fixing a customer's phone mid-campaign adds them to the queue.
- Closing the app mid-queue and returning resumes at the same recipient.
- A recipient is never messaged twice by the same campaign (the unique constraint, and the UI).
- Editing the message mid-campaign leaves already-sent recipients alone.

---

## Phase 4 — Till offers

Mockup: `pos-offers-mockup.html`.

```sql
alter table public.sales add column campaign_id uuid references public.campaigns(id) on delete set null;

alter table public.campaign_recipients add column redeemed_at timestamptz;
```

`redeemed_at` is set by the customer prompt and is the campaign's only deliberate outcome signal. It is
kept separate from `state` on purpose: state tracks the errand of messaging someone, redemption tracks
what came back, and a recipient can be `sent` and never redeem, or redeem after being `skipped` because
they heard about the offer another way.

`complete_sale` and `edit_sale` gain `p_campaign_id uuid default null`, appended as a default-valued
parameter at the end of the signature, following the pattern migration `0023` established.

Three surfaces:

- **The cart line names its offer** instead of an anonymous strike-through, and the totals line reads
  "Eid weekend — 20% off −$5.00". Two offers in one basket show two lines.
- **The product tile carries a badge** for whatever would come off it right now, so the offer is visible
  before the product reaches the cart rather than discovered at the total.
- **Apply an offer** — a picker holding only `auto_apply = false` offers. Expired and not-yet-started
  entries are greyed with the date that explains why, rather than hidden, so a cashier told "use the
  school offer" learns why they cannot. The free-form "type a discount" entry sits below a divider and is
  disabled without the permission.
- **The customer prompt** — when a customer is attached and a campaign messaged them, one line and one
  button. Sets `campaign_id`, and marks the recipient redeemed. This is the only place a redemption is
  recorded deliberately; everything else in the campaign report is inference.

### Phase 4 acceptance

- The prompt appears only when a customer is attached *and* a campaign messaged them.
- Applying an offer never lets the cashier alter the amount.
- A sale with `campaign_id` shows as a redemption on the campaign, distinct from "bought within 7 days".
- Removing the customer from the cart clears any campaign attribution.

---

## Testing

- **Pure functions first, TDD.** `contrast.ts`, the window predicate in `discounts.ts`, audience
  filtering, and placeholder filling are all pure and carry the real risk. The window predicate gets a
  clock parameter specifically so this is possible.
- **Schema.** The check constraints, the `on delete set null` behaviour, and that a completed sale keeps
  its promotion name after the promotion is deleted.
- **RPC.** `complete_sale` and `edit_sale` round-trip the new fields; the `sale_edits` snapshot includes
  them.
- **On device.** The send queue's foreground-return question, the WhatsApp hand-off, and poster export
  all cross the native boundary and cannot be verified by reading code — screenshots on the simulator,
  per the project's testing skill. Poster export must be checked on both platforms; the web split above
  means the Save affordance has to actually be absent there.

## Out of scope

WhatsApp Business Cloud API · posting to Facebook, Instagram, TikTok or X on a shop's behalf · email
campaigns · scheduled or recurring campaigns · A/B testing · product photography on posters · image
download on web · loyalty-points integration with campaigns.
