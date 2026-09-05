# Storefront Apple-Blue Design, Checkout Redesign & Kaiibi Branding — Implementation Plan

> **Entry point moved:** start from `2026-09-05-storefront-master-plan.md` in this directory — it carries the decision ledger and Phases 2–4. This document remains the authoritative, fully-specified TDD source for **Phase 1** (its Tasks 1–12) and is executed as written.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the apple.com-blue design language (solid accent primaries, tinted secondaries) to the public storefront, redesign the checkout bar as an evidence-carrying slip, and add removable-on-Pro kaiibi branding — touching nothing in the admin app.

**Architecture:** All colour flows through the existing palette system in `src/lib/storefront-catalog.ts` — the apple blue is the `azure` palette's `accent` (already in the client catalog), and the tinted tier is two new *derived* tokens so all seven palettes gain it for free. Branding visibility is computed server-side in the public RPCs via the existing `shop_effective_plan()`, because the storefront renders for a stranger with no session. The checkout bar becomes a two-tier slip inside the shop's reading column, which Task 8 widens from 1080 to 1320 — the admin shell's own desktop ceiling.

**Tech Stack:** React Native (Expo SDK 57) + StyleSheet, Jest + react-test-renderer, Supabase (Postgres migrations, `security definer` RPCs).

**Workspace:** `.claude/worktrees/storefront-apple-blue`, branch `worktree-storefront-apple-blue`, based on `origin/main` @ 57b8f93. Baseline verified 2026-09-05: 223 suites / 4,099 storefront-matching tests green, `tsc --noEmit` clean (after copying the gitignored build artifacts `expo-env.d.ts`, `src/global.css`, `src/components/animated-icon.module.css`, `.expo/types/router.d.ts` from the main checkout — a fresh worktree needs those four). The azure catalog edits (Task 1's client half) are already applied here. **Execution is deferred until the concurrent session on `storefront-editor-removes-and-errors` completes** — before starting, `git fetch && git rebase origin/main` and re-run the baseline.

## Global Constraints

- **Admin untouched.** No changes under `src/constants/theme.ts`, `src/components/accounting/`, POS, or any `(admin)` route. The storefront editor (`src/components/storefront/editor/`) is admin too — it needs no change (the picker derives from `PALETTES`).
- **No hex literals at call sites.** Every storefront colour comes from `PaletteColors` (or is one of the catalogued fixed constants like `WHATSAPP_BUTTON_GREEN`). New colours are stored-or-derived in `storefront-catalog.ts` and contrast-tested in `src/lib/__tests__/storefront-catalog.test.ts`.
- **WhatsApp green stays fixed** (`#1f7a4d` button / brand green in the logo path); `stockOut` is never the accent; in-stock carries no colour of its own. These are pinned by existing tests — do not weaken them.
- **The storefront is sessionless.** Nothing on the public page may call an authed RPC (`my_shop_entitlements()` is authed — off limits).
- **Migrations:** new files must sort after `20261025000000_what_a_shop_sells_and_how_to_reach_it.sql`. Use the exact filenames given per task. When re-creating a public RPC, copy the **latest** existing body forward verbatim (explicit column list, `security definer`, `set search_path`), add only the new column, and re-grant execute to `anon, authenticated`.
- **Per-task verification:** `npx jest storefront` and `npx tsc --noEmit` must pass before each commit. Baseline on this worktree: 223 suites / 4,099 tests green (grows as tasks add tests).
- **After the final task:** verify on a running device/web via the `/testing-kaiibi` skill — code-reading is not verification for layout work (project memory: stale bundles fake failures).

---

## Phase A — The colour scheme

### Task 1: Let the database accept the azure palette

The client catalog already ships `azure` (`accent #0071e3`), but `storefronts.palette` has a CHECK constraint listing only the original six — choosing Azure in the editor fails the write. Fix the constraint.

**Files:**
- Create: `supabase/migrations/20261101000000_storefront_palette_azure.sql`

**Interfaces:**
- Produces: DB accepts `palette = 'azure'` — the editor's Azure save starts persisting.

- [ ] **Step 1: Confirm the constraint's current shape and name**

Run: `grep -n "palette" supabase/migrations/20260924000000_storefront.sql`
Expected: line 40 shows `palette text not null default 'ink' check (palette in ('ink', 'palm', 'clay', 'sea', 'saffron', 'plum')),` — an inline column check, so Postgres named it `storefronts_palette_check`.

- [ ] **Step 2: Write the migration**

```sql
-- The client catalog gained a seventh palette (azure, the apple.com blue
-- #0071e3 -- see the comment on COLORS.azure in storefront-catalog.ts for why
-- that hex and not iOS systemBlue). The column's CHECK still names six, so a
-- shop picking Azure in the editor had its save refused. Same list, plus one.
alter table public.storefronts
  drop constraint storefronts_palette_check;

alter table public.storefronts
  add constraint storefronts_palette_check
  check (palette in ('ink', 'palm', 'clay', 'sea', 'saffron', 'plum', 'azure'));
```

- [ ] **Step 3: Apply and verify locally**

Run: `npx supabase migration up` (or the project's usual `npx supabase db reset` if that is the local flow).
Then verify both directions in `psql`/Studio SQL editor:

```sql
update public.storefronts set palette = 'azure' where false;  -- parses, constraint allows the value
insert into public.storefronts (shop_id, palette) values (gen_random_uuid(), 'neon'); -- must FAIL the check
```

Expected: the first statement succeeds (no rows touched); the second errors with `violates check constraint "storefronts_palette_check"`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261101000000_storefront_palette_azure.sql
git commit -m "fix(storefront): the database now accepts the azure palette the client already offers"
```

---

### Task 2: The tinted action tier — two derived tokens

The provided design has two button tiers: a solid accent fill with white type, and a **tinted** pill (light accent wash, deep accent type). The storefront has only the solid tier. Add `accentWash` + `accentInk` as *derived* tokens so every palette gains the tier. Derivation, not storage: the plain accent as text on its own wash fails 4.5:1 on azure (4.15:1 measured), so `accentInk` must be stepped darker — the same `stepUntilContrast` discipline `danger` and `stockOut` already use.

**Files:**
- Modify: `src/lib/storefront-catalog.ts`
- Test: `src/lib/__tests__/storefront-catalog.test.ts`

**Interfaces:**
- Produces: `PaletteColors` gains `accentWash: string` (a fill for quiet actions) and `accentInk: string` (type on that wash, ≥4.5:1 on wash and on ground). Task 3 consumes them.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/storefront-catalog.test.ts`:

```ts
describe('the tinted action tier', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s keeps accent type readable on its wash', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.accentInk, c.accentWash)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s keeps accent type readable on bare ground too', (key) => {
    // A tinted pill sits on ground and on soft; the type must survive both,
    // and ground is the lighter (harder) of the two on every palette.
    const c = paletteColors(key);
    expect(contrastRatio(c.accentInk, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s keeps the wash a tint, not a second fill', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.accentWash, c.ground)).toBeLessThan(1.6);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/lib/__tests__/storefront-catalog.test.ts -t "tinted action tier"`
Expected: FAIL — `accentInk`/`accentWash` do not exist on `PaletteColors`.

- [ ] **Step 3: Implement the tokens**

In `src/lib/storefront-catalog.ts`:

1. Extend `PaletteColors` (after the `edge` member, before `onDarkMuted`):

```ts
  // THE TINTED ACTION TIER. A quiet action -- "Edit cart", a clear chip, the
  // empty-state nudge -- wears the accent washed toward ground, with its label
  // in the accent stepped dark enough to read. Two tokens because the plain
  // accent as TYPE on its own wash fails 4.5:1 on azure (4.15:1) -- the accent
  // is tuned to carry white, which is the opposite job.
  accentWash: string;
  accentInk: string;
```

2. Add both names to the `Omit<...>` list in `BasePaletteColors` (they are derived, never stored):

```ts
type BasePaletteColors = Omit<
  PaletteColors,
  'muted' | 'danger' | 'stockOut' | 'onDarkMuted' | 'hairline' | 'edge' | 'accentWash' | 'accentInk'
>;
```

3. Add the derivations (beside `hairlineInk`, after `HAIRLINE_BLEND`):

```ts
// The wash reuses HAIRLINE_BLEND's proportion toward ground -- far enough to
// be unmistakably a tint (tested < 1.6:1 against ground), near enough to keep
// the palette's hue. On the ink palette this degrades to a light grey, which
// is correct: that palette's whole point is having no colour.
const ACCENT_WASH_BLEND = 0.88;

export function accentWashOf(palette: StorefrontPalette): string {
  const c = COLORS[paletteKey(palette)];
  return blendHex(c.accent, c.ground, ACCENT_WASH_BLEND);
}

// Stepped against the WASH (its own surface), then re-checked against ground
// by the tests -- ground is lighter than the wash on every palette, so a
// value that clears ground clears soft too.
export function accentInkOf(palette: StorefrontPalette): string {
  const c = COLORS[paletteKey(palette)];
  const onWash = stepUntilContrast(c.accent, accentWashOf(palette), 4.5);
  return stepUntilContrast(onWash, c.ground, 4.5);
}
```

4. Spread them in `paletteColors()`:

```ts
    accentWash: accentWashOf(key),
    accentInk: accentInkOf(key),
```

- [ ] **Step 4: Run the full catalog suite**

Run: `npx jest src/lib/__tests__/storefront-catalog.test.ts`
Expected: PASS, all palettes × all gates (previous 158 + 21 new).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/storefront-catalog.ts src/lib/__tests__/storefront-catalog.test.ts
git commit -m "feat(storefront): a tinted action tier, derived per palette and contrast-gated"
```

---

### Task 3: Apply the tier to the storefront's quiet actions

Repoint the four quiet controls from grey/borders to the tinted tier. The solid tier (Add, checkout, active category pill, CartButton) stays exactly as it is — **one fill per region** is the rule that keeps the accent meaning "press this".

**Files:**
- Modify: `src/components/storefront/theme-shared.tsx`

**Interfaces:**
- Consumes: `colors.accentWash` / `colors.accentInk` from Task 2.

- [ ] **Step 1: Locate the four controls**

Run: `grep -n "editCart\b\|searchClear\|filterChip\|emptyAction\b" src/components/storefront/theme-shared.tsx`
They are: the checkout screen's "Edit cart" pill (bordered today), the search field's clear chip, the category filter's clear chip, and the empty-state action (non-WhatsApp variant only).

- [ ] **Step 2: Repoint each**

For each of the four JSX sites, replace the current colour props with the tier (keep layout styles untouched). The pattern, shown for the search-clear chip — apply the same two substitutions at all four sites:

```tsx
// container: was backgroundColor: colors.soft (or a colors.edge border)
style={pressable([styles.searchClear, { backgroundColor: colors.accentWash }])}
// label: was color: colors.ink / colors.muted
<Text style={[styles.searchClearText, { color: colors.accentInk }]}>
```

For `editCart` specifically, also delete `borderWidth: 1` from the style and drop the inline `borderColor` — the wash is the boundary now. The WhatsApp variant of the empty state keeps `WHATSAPP_BUTTON_GREEN` untouched.

- [ ] **Step 3: Run the storefront suites**

Run: `npx jest storefront`
Expected: PASS. If a component test asserts the old `soft` background on any of these four, update that assertion to `accentWash` — the test is describing the old design, not guarding a behaviour.

- [ ] **Step 4: Commit**

```bash
git add src/components/storefront/theme-shared.tsx
git commit -m "feat(storefront): quiet actions wear the tinted tier"
```

---

### Task 4: Palm stops reading green-on-green

Two one-value moves in Palm's `COLORS` row, one diagnosis (design review 2026-09-05): the hue belongs in the accent, and the dark surface goes charcoal with only a whisper of it.

1. **Accent** `#1f6b45` sits ΔE 7.51 from the fixed WhatsApp green `#1f7a4d` — a shop on Palm paints "Buy" and "Message us" in what reads as one colour. Move to `#14543a` (ΔE 19.07; white-on-accent *improves* 6.47→8.90:1).
2. **Ink** `#12211a` is a *green* black, so every ink-filled surface (anchor card, footer) is a green card carrying a green WhatsApp button with sage muted text on top — the murk is hue-on-hue. Move to `#15191b`, a charcoal with a whisper of green (ΔE ink→WhatsApp rises 47→55). All 21 derived-token gates re-verified passing on the new pair.

Pin the accent separation with a test so no future palette regresses it.

**Files:**
- Modify: `src/lib/storefront-catalog.ts` (one value)
- Test: `src/lib/__tests__/storefront-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file (the ΔE helper is test-only — CIE76 over CIELAB is enough to guard a floor):

```ts
describe('no accent impersonates the WhatsApp button', () => {
  const lab = (hex: string): [number, number, number] => {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(lin);
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    [x, y, z] = [f(x), f(y), f(z)];
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const deltaE = (a: string, b: string) => {
    const [l1, a1, b1] = lab(a);
    const [l2, a2, b2] = lab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };

  it.each(PALETTES.map((p) => p.key) as StorefrontPalette[])(
    '%s keeps its accent at least deltaE 15 from the WhatsApp green',
    (key) => {
      // 15 is the floor theme.ts already applies between two chart marks; two
      // BUTTONS with different meanings deserve at least what two bars get.
      expect(deltaE(paletteColors(key).accent, WHATSAPP_BUTTON_GREEN)).toBeGreaterThanOrEqual(15);
    },
  );
});
```

- [ ] **Step 2: Run to verify it fails on palm only**

Run: `npx jest src/lib/__tests__/storefront-catalog.test.ts -t "impersonates"`
Expected: FAIL for `palm` (ΔE ≈ 7.5), PASS for the other six.

- [ ] **Step 3: Move both values**

In `COLORS`:

```ts
  // Two one-value moves (2026-09-05). The accent deepened from #1f6b45, which
  // sat deltaE 7.5 from the fixed WhatsApp button green -- "Buy" and "Message
  // us" in one colour; #14543a is deltaE 19 away and carries white harder
  // (8.9:1 vs 6.5:1). The ink neutralised from #12211a, a GREEN black that
  // made every ink-filled surface a green card under a green button; charcoal
  // with a whisper of green keeps Palm's identity, and the green itself now
  // lives only in the accent.
  palm:    { ground: '#fbfcfa', soft: '#eef4ef', ink: '#15191b', accent: '#14543a' },
```

The catalog's own `it.each` gates re-verify every derived token (muted, hairline, edge, danger, stockOut, accentWash/Ink) against the new ink automatically — no new assertions needed for the ink move.

- [ ] **Step 4: Run the full catalog suite, typecheck, commit**

```bash
npx jest src/lib/__tests__/storefront-catalog.test.ts && npx tsc --noEmit
git add src/lib/storefront-catalog.ts src/lib/__tests__/storefront-catalog.test.ts
git commit -m "fix(storefront): palm stops reading green-on-green"
```

---

## Phase B — The checkout redesign

### Task 5: The clearance padding stops being conditional

Adding the first item currently reflows the whole grid by 76px, because the bottom clearance is applied only when `itemCount > 0`. Make it unconditional in all three themes. (76px of quiet space at the very bottom of an empty-cart scroll is the cost; a page that jumps under the customer's finger was the bug.)

**Files:**
- Modify: `src/components/storefront/theme-market.tsx:196`
- Modify: `src/components/storefront/theme-counter.tsx` (same pattern, `scrollContentWithCheckoutBar`)
- Modify: `src/components/storefront/theme-window.tsx` (same pattern, `gridWithCheckoutBar`)

- [ ] **Step 1: Make the change in each theme**

In `theme-market.tsx` line 196, replace:

```tsx
contentContainerStyle={[styles.grid, itemCount > 0 && styles.gridWithCheckoutBar]}
```

with:

```tsx
// Unconditional: the first Add must not reflow the page under the
// customer's finger. The cost is the clearance's worth of quiet space at
// the bottom of an empty-cart scroll, which nothing sits under.
contentContainerStyle={[styles.grid, styles.gridWithCheckoutBar]}
```

Apply the identical conditional-removal in `theme-counter.tsx` (`scrollContentWithCheckoutBar`) and `theme-window.tsx` (`gridWithCheckoutBar`) — same one-line change, same comment.

- [ ] **Step 2: Run, typecheck, commit**

```bash
npx jest storefront && npx tsc --noEmit
git add src/components/storefront/theme-market.tsx src/components/storefront/theme-counter.tsx src/components/storefront/theme-window.tsx
git commit -m "fix(storefront): the first Add no longer reflows the page"
```

---

### Task 6: The checkout bar joins the reading column

The bar is `position: absolute; left: 14; right: 14` as a sibling of the 1080px-max scroller, so it anchors to the window — on a 2000px screen the goods sit in 1080px and the button spans 1972px. Constrain it to the same column.

**Files:**
- Modify: `src/components/storefront/theme-shared.tsx` (`CheckoutBar` and its styles)

**Interfaces:**
- Produces: the wrapper/slot structure Task 7 rebuilds in place. Callers unchanged.

- [ ] **Step 1: Wrap the bar in a centring slot**

In `CheckoutBar`, wrap the existing `Pressable` (leave its props alone):

```tsx
return (
  <View pointerEvents="box-none" style={styles.checkoutBarSlot}>
    <Pressable
      testID="storefront-checkout-bar"
      accessibilityRole="button"
      onPress={onPress}
      style={pressable([styles.checkoutBar, { backgroundColor: colors.accent }])}
    >
      <Text style={[styles.checkoutBarText, { color: colors.ground }]}>Checkout · {formatCents(subtotalCents)}</Text>
    </Pressable>
  </View>
);
```

Replace the `checkoutBar` styles and add the slot (import `SHOP_MAX_WIDTH` from `@/components/storefront/scale` if not already imported):

```ts
  // The slot is what floats; the bar inside it is what the reading column
  // bounds. Absolute left/right anchor to the theme root, which is the full
  // window -- the maxWidth is what stops a 2000px screen getting a 1972px
  // button while the goods sit in 1080px.
  checkoutBarSlot: { position: 'absolute', left: 14, right: 14, bottom: 14, alignItems: 'center' },
  checkoutBar: {
    width: '100%', maxWidth: SHOP_MAX_WIDTH - 28,
    borderRadius: 999, paddingVertical: 14, alignItems: 'center',
  },
```

- [ ] **Step 2: Run, typecheck, commit**

```bash
npx jest storefront && npx tsc --noEmit
git add src/components/storefront/theme-shared.tsx
git commit -m "fix(storefront): the checkout bar joins the reading column"
```

---

### Task 7: The slip — evidence left, action right

Replace the accent-slab bar with a slip: a `ground` container carrying up-to-three line thumbnails, the total, a count-and-fulfilment line — and a **proportionate** accent button. The accent goes back to being a thing you press instead of a field you stand on. Same control on phone and desktop.

**Files:**
- Modify: `src/lib/storefront-catalog.ts` (two fixed constants)
- Modify: `src/components/storefront/theme-shared.tsx` (`CheckoutBar`, `CHECKOUT_BAR_CLEARANCE`, new helper `cartThumbnails`, the checkout screen's continue button)
- Modify: `src/components/storefront/checkout-form.tsx` (the place-order primary)
- Modify: `src/components/storefront/theme-market.tsx:240`, `theme-counter.tsx:220`, `theme-window.tsx:227` (callsites)
- Test: `src/lib/__tests__/storefront-catalog.test.ts`, `src/components/__tests__/storefront-checkout-bar.test.tsx` (create)

**Interfaces:**
- Consumes: `CartLine { productId, name, unitPriceCents, quantity }` from `src/lib/storefront-cart.ts`.
- Produces:
  ```ts
  export const CHECKOUT_BLUE = '#0071e3';  // storefront-catalog.ts
  export const CHECKOUT_INK = '#ffffff';
  export function cartThumbnails(cart: StorefrontCart, products: StorefrontProduct[]): (string | null)[]
  export function CheckoutBar(props: {
    colors: PaletteColors; itemCount: number; subtotalCents: number;
    thumbnails: (string | null)[]; fulfilment: string | null; onPress: () => void;
  }): JSX.Element | null
  ```

- [ ] **Step 0: The fixed checkout blue (decision 2026-09-05)**

The checkout action is apple blue on EVERY palette — a fixed transactional affordance, exactly the pattern `WHATSAPP_BUTTON_GREEN` set: fixed colour for a fixed meaning, catalogued rather than a stray literal. In `src/lib/storefront-catalog.ts`, beside the WhatsApp constants:

```ts
// The CHECKOUT affordance, fixed on every palette (decision 2026-09-05):
// committing an order goes through kaiibi's machinery whichever shop you are
// in, and one recognisable colour for that moment is worth more than palette
// purity -- the same trade WHATSAPP_BUTTON_GREEN already makes. Byte-identical
// to the azure palette's accent on purpose (pinned by test): on an Azure shop
// the page and the affordance agree seamlessly. Carries white at 4.70:1.
export const CHECKOUT_BLUE = '#0071e3';
export const CHECKOUT_INK = '#ffffff';
```

Append to `src/lib/__tests__/storefront-catalog.test.ts`:

```ts
describe('checkout blue', () => {
  it('carries white text, which is its whole job', () => {
    expect(contrastRatio(CHECKOUT_INK, CHECKOUT_BLUE)).toBeGreaterThanOrEqual(4.5);
  });

  it('is byte-identical to the azure accent, deliberately', () => {
    // If either value moves without the other, an Azure shop's page and its
    // checkout affordance drift apart -- pin the relationship.
    expect(paletteColors('azure').accent).toBe(CHECKOUT_BLUE);
  });
});
```

Run `npx jest src/lib/__tests__/storefront-catalog.test.ts -t "checkout blue"` — FAIL until the constants exist, then PASS.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/storefront-checkout-bar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';

import { CheckoutBar } from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';

const colors = paletteColors('ink');
const noop = () => {};

describe('the checkout slip', () => {
  it('renders nothing with an empty cart', () => {
    render(
      <CheckoutBar colors={colors} itemCount={0} subtotalCents={0} thumbnails={[]} fulfilment={null} onPress={noop} />,
    );
    expect(screen.queryByTestId('storefront-checkout-bar')).toBeNull();
  });

  it('carries the evidence: total, count and fulfilment', () => {
    render(
      <CheckoutBar
        colors={colors} itemCount={3} subtotalCents={11297}
        thumbnails={[null, null, null]} fulfilment="collection" onPress={noop}
      />,
    );
    expect(screen.getByText('$112.97')).toBeTruthy();
    expect(screen.getByText('3 items · collection')).toBeTruthy();
    expect(screen.getByText('Checkout')).toBeTruthy();
  });

  it('says item, singular, and drops the fulfilment word when null', () => {
    render(
      <CheckoutBar colors={colors} itemCount={1} subtotalCents={1800} thumbnails={[null]} fulfilment={null} onPress={noop} />,
    );
    expect(screen.getByText('1 item')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest storefront-checkout-bar`
Expected: FAIL — `thumbnails`/`fulfilment` are not props; the texts do not render.

- [ ] **Step 3: Rebuild `CheckoutBar` and add the helper**

In `theme-shared.tsx`, replace the whole `CheckoutBar` (keeping the Task-6 slot):

```tsx
// Up to three thumbnails, in cart order. A product with no photo degrades to
// a soft plate -- the same no-photo fallback the tiles use.
export function cartThumbnails(cart: StorefrontCart, products: StorefrontProduct[]): (string | null)[] {
  const byId = new Map(products.map((p) => [p.id, p.imageUrl]));
  return cart.lines.slice(0, 3).map((line) => byId.get(line.productId) ?? null);
}

// The SLIP. The old bar was the accent as a full-width field with four words
// on it -- the customer committed on trust, and on desktop the field ran the
// window rather than the column. Now the container is ground (a surface), the
// evidence sits on it (thumbnails, total, count, fulfilment), and the accent
// is a button-sized button again.
export function CheckoutBar({
  colors, itemCount, subtotalCents, thumbnails, fulfilment, onPress,
}: {
  colors: PaletteColors;
  itemCount: number;
  subtotalCents: number;
  thumbnails: (string | null)[];
  fulfilment: string | null;
  onPress: () => void;
}) {
  if (itemCount === 0) return null;
  const line = `${itemCount} ${itemCount === 1 ? 'item' : 'items'}${fulfilment ? ` · ${fulfilment}` : ''}`;
  return (
    <View pointerEvents="box-none" style={styles.checkoutBarSlot}>
      <Pressable
        testID="storefront-checkout-bar"
        accessibilityRole="button"
        onPress={onPress}
        style={pressable([styles.slip, { backgroundColor: colors.ground, shadowColor: '#000' }])}
      >
        <View style={styles.slipEvidence}>
          <View style={styles.slipThumbs}>
            {thumbnails.map((uri, i) => (
              <View key={i} style={[styles.slipThumb, { backgroundColor: colors.soft, borderColor: colors.ground }]}>
                {uri ? <Image source={{ uri }} style={styles.slipThumbImage} /> : null}
              </View>
            ))}
          </View>
          <View>
            <Text style={[styles.slipTotal, { color: colors.ink }]}>{formatCents(subtotalCents)}</Text>
            <Text style={[styles.slipLine, { color: colors.muted }]}>{line}</Text>
          </View>
        </View>
        {/* CHECKOUT_BLUE, not colors.accent -- the affordance is fixed on
            every palette (Step 0). White type, the pair the constant is
            contrast-tested for; colors.ground would drift per palette. */}
        <View style={[styles.slipGo, { backgroundColor: CHECKOUT_BLUE }]}>
          <Text style={[styles.slipGoText, { color: CHECKOUT_INK }]}>Checkout</Text>
        </View>
      </Pressable>
    </View>
  );
}
```

Add `Image` to the `react-native` import at the top of the file if absent. Replace the `checkoutBar`/`checkoutBarText` styles with:

```ts
  slip: {
    width: '100%', maxWidth: SHOP_MAX_WIDTH - 28,
    borderRadius: 999, paddingVertical: 8, paddingLeft: 16, paddingRight: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14,
    shadowOpacity: 0.13, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  slipEvidence: { flexDirection: 'row', alignItems: 'center', gap: 11, flexShrink: 1 },
  slipThumbs: { flexDirection: 'row' },
  slipThumb: {
    width: 30, height: 30, borderRadius: 9, borderWidth: 2, marginLeft: -9, overflow: 'hidden',
  },
  slipThumbImage: { width: '100%', height: '100%' },
  slipTotal: { fontSize: 14, fontWeight: '800' },
  slipLine: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  slipGo: { borderRadius: 999, paddingHorizontal: 20, paddingVertical: 11 },
  slipGoText: { fontSize: 13.5, fontWeight: '800' },
```

Fix the first thumb's overlap: add `slipThumbFirst: { marginLeft: 0 }` and apply `i === 0 && styles.slipThumbFirst` in the map.

- [ ] **Step 4: Re-measure the clearance**

The slip is 8+30+8 = 46px tall plus 14px bottom offset and shadow — the old bar was ~45px. Update the constant's comment (value stays):

```ts
// The slip is 46px tall (8 padding + 30 thumb + 8) sitting 14px off the
// bottom; 76 clears it with shadow headroom. Re-measure if the slip's
// vertical paddings or thumb size change.
export const CHECKOUT_BAR_CLEARANCE = 76;
```

- [ ] **Step 5: Update the three callsites**

`theme-market.tsx:240` becomes (market has `products`, `cart` from `useStorefrontCart`, and `storefront` in scope):

```tsx
<CheckoutBar
  colors={colors}
  itemCount={itemCount}
  subtotalCents={subtotalCents}
  thumbnails={cartThumbnails(cart, products)}
  fulfilment={storefront.offersDelivery ? null : 'collection'}
  onPress={checkout.openCheckout}
/>
```

Add `cartThumbnails` to each theme's import from `theme-shared`. Apply the same six-prop call in `theme-counter.tsx:220` and `theme-window.tsx:227` — all three files have the same `cart`, `products`, `storefront` locals in scope (verify the exact local names at each site with the surrounding lines; `useStorefrontCart` supplies the cart in all three).

- [ ] **Step 6: The checkout flow's primaries take the same blue**

The affordance is the *moment of committing*, so the checkout screen's forward actions match the slip. Two sites, same substitution (`CHECKOUT_BLUE` fill, `CHECKOUT_INK` type; import both from `@/lib/storefront-catalog`):

1. Run `grep -n "continueButton" src/components/storefront/theme-shared.tsx` — at the JSX site, replace the inline `backgroundColor: colors.accent` with `backgroundColor: CHECKOUT_BLUE` and the label's `color: colors.ground` with `color: CHECKOUT_INK`.
2. Run `grep -n "colors.accent" src/components/storefront/checkout-form.tsx` — the **place-order submit button only** takes the same two substitutions. Every other `colors.accent` use in that file (links, focus tints, secondary emphasis) stays palette-drawn; the affordance is the commit button, not the form.

- [ ] **Step 7: Run everything**

Run: `npx jest storefront && npx tsc --noEmit`
Expected: PASS, including the new `storefront-checkout-bar` suite and the two `checkout blue` catalog tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/storefront-catalog.ts src/lib/__tests__/storefront-catalog.test.ts src/components/storefront/theme-shared.tsx src/components/storefront/checkout-form.tsx src/components/storefront/theme-market.tsx src/components/storefront/theme-counter.tsx src/components/storefront/theme-window.tsx src/components/__tests__/storefront-checkout-bar.test.tsx
git commit -m "feat(storefront): the checkout becomes a slip, and its blue is fixed on every palette"
```

---

### Task 8: The desktop stops restricting the page

`SHOP_MAX_WIDTH` is 1080, and on a 1,600px+ window the whole shop sits in a strip with dead gutters (user report 2026-09-05). Its own comment says it "matches the app's own reading column" — but the admin's desktop shell caps at **1320**. Widen the shop to the app's own ceiling, and give the product grid a fifth column where the new width allows one; below 1280 nothing changes.

**Coordination caveat:** `docs/design/storefront-desktop-redesign-mockup.html` sits untracked in the shared checkout and belongs to the other session. Before executing this task, check whether that session landed desktop-layout changes; if it did, reconcile against them instead of assuming these two edits still stand alone.

**Files:**
- Modify: `src/components/storefront/scale.ts` (`SHOP_MAX_WIDTH` and its comment)
- Modify: `src/components/storefront/theme-shared.tsx` (`gridColumnsForWidth`, ~line 718)

- [ ] **Step 1: Widen the column**

Replace the constant and the last paragraph of its comment:

```ts
// 1080 -> 1320 (2026-09-05): 1080 matched the phone-era reading column and
// left a 1,600px window mostly gutter. 1320 is the admin shell's own desktop
// ceiling, so the shop and the app now agree on how wide "wide" is. Still a
// fixed number rather than a percentage -- a measure that grows with the
// window stops being a measure.
export const SHOP_MAX_WIDTH = 1320;
```

- [ ] **Step 2: A fifth column past 1280**

```ts
export function gridColumnsForWidth(width: number): number {
  if (width < 640) return 2;
  if (width < 1024) return 3;
  // Five only once the column itself widened (SHOP_MAX_WIDTH 1320): at that
  // width a four-up tile is ~310px -- wider than a phone's whole two-up --
  // and five keeps tiles near the ~250px the grid was designed around.
  if (width < 1280) return 4;
  return 5;
}
```

Nothing else moves by hand: ShopChrome's rail and scroller, all three theme scrollers, and the Task 6/7 slip all read `SHOP_MAX_WIDTH`.

- [ ] **Step 3: Run, typecheck**

Run: `npx jest storefront && npx tsc --noEmit` — update any test pinning 4 columns at ≥1024 to the new table.

- [ ] **Step 4: Eyeball on web at ≥1600px** via `/testing-kaiibi` — REQUIRED before commit (project memory: layout changes verify on a real render, not by reading).

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/scale.ts src/components/storefront/theme-shared.tsx
git commit -m "feat(storefront): the shop column widens to the app's own desktop ceiling"
```


---

## Phase C — Kaiibi branding, removed on Pro

### Task 9: The hide-branding flag, end to end

Branding visibility is a plan capability computed server-side: the storefront renders sessionless, so the flag travels on `get_public_storefront` — the `security definer` RPC that already decides what an anonymous visitor sees. Not `planKey === 'pro'` (plans get retired and hopped — `shop_effective_plan()` exists precisely for that), and the default is **show**: over-permitting is the shape a monetization bypass takes, and here the *perk* is hiding.

**Files:**
- Create: `supabase/migrations/20261101000100_plans_hide_storefront_branding.sql`
- Create: `supabase/migrations/20261101000200_storefront_public_hide_branding.sql`
- Modify: `src/lib/storefront.ts` (`getPublicStorefront` mapping)
- Modify: `src/types/models.ts` (`PublicStorefront`)
- Test: extend the existing suite that covers `getPublicStorefront`'s row mapping (`grep -rln "getPublicStorefront" src/**/__tests__` to locate; add there)

**Interfaces:**
- Produces: `PublicStorefront.hideBranding: boolean` (false = show). Tasks 10–11 consume it.

- [ ] **Step 1: The plan capability**

`20261101000100_plans_hide_storefront_branding.sql`:

```sql
-- Branding removal is a CAPABILITY on the plan row, not a key comparison in
-- code -- plans get retired and hopped to successors (20260824000100), so a
-- planKey === 'pro' test breaks the first time Pro is renamed. Default false:
-- the perk is HIDING the mark, so an unknown or missing plan shows it.
alter table public.plans
  add column hide_storefront_branding boolean not null default false;

update public.plans set hide_storefront_branding = true where key = 'pro';
```

- [ ] **Step 2: The RPC column**

`20261101000200_storefront_public_hide_branding.sql`: locate the **latest** definition —

Run: `grep -rln "get_public_storefront" supabase/migrations/ | sort | tail -1`
Expected: `20261025000000_what_a_shop_sells_and_how_to_reach_it.sql`.

Copy that migration's full `get_public_storefront` recreation forward verbatim (drop + create, explicit column list, `security definer`, its `set search_path`), adding one return column and one select expression:

```sql
-- in the returns table(...): after the last existing column
  hide_branding boolean
-- in the select list: after the corresponding last expression
  , coalesce(pl.hide_storefront_branding, false) as hide_branding
-- in the from clause: join the effective plan through the helper that
-- already resolves trialing/active/grace and retired-plan hops
  left join lateral public.shop_effective_plan(s.shop_id) pl on true
```

(`s` here is whatever alias the copied body already uses for the shops/storefronts row carrying `shop_id` — keep the body's own alias.) Finish the file with the same grants the copied body carries, re-stated:

```sql
grant execute on function public.get_public_storefront(text) to anon, authenticated;
```

A shop in `grace` is fully usable by design (mobile money confirmed by hand), and `shop_effective_plan` already treats grace as entitled — so branding stays hidden through grace and returns on expiry with no extra code here. That behaviour is why the join is to the *effective* plan and not the subscription row.

- [ ] **Step 3: Apply and verify**

Run: `npx supabase migration up`
Verify in SQL: `select hide_branding from public.get_public_storefront('<a-published-slug>');` returns `false` for a free/trial shop; flip a test shop to the pro plan and it returns `true`.

- [ ] **Step 4: The client mapping — failing test first**

In the suite that mocks `get_public_storefront` rows, add:

```ts
it('maps hide_branding, and a client shipped ahead of its database shows branding', () => {
  // row WITH the column
  expect(mapRow({ ...baseRow, hide_branding: true }).hideBranding).toBe(true);
  // row WITHOUT the column at all (old database): undefined must arrive as
  // false -- branding SHOWN -- the same fail-open-for-display,
  // fail-closed-for-perks shape offersDelivery already uses.
  expect(mapRow({ ...baseRow }).hideBranding).toBe(false);
});
```

(Use the suite's existing row-fixture and mapping harness; `mapRow`/`baseRow` stand for its local names — match them.)

Run it, expect FAIL. Then in `src/types/models.ts` add to `PublicStorefront`:

```ts
  // True only when the shop's effective plan buys the mark off. Boolean(...)
  // at the mapping: a client shipped ahead of its database must SHOW branding,
  // not hide it -- hiding is the perk.
  hideBranding: boolean;
```

and in `src/lib/storefront.ts`'s return object:

```ts
    hideBranding: Boolean(row.hide_branding),
```

- [ ] **Step 5: Run, typecheck, commit**

```bash
npx jest storefront && npx tsc --noEmit
git add supabase/migrations/20261101000100_plans_hide_storefront_branding.sql supabase/migrations/20261101000200_storefront_public_hide_branding.sql src/lib/storefront.ts src/types/models.ts
git commit -m "feat(storefront): hide-branding travels as a plan capability on the public read"
```

---

### Task 10: "Powered by kaiibi" in the footer

The footer is the page's `ink` bookend and already ends with a terms line. The mark goes **below** it as a colophon lockup — the mark at real size, a caps eyebrow in the letterspaced meta style the footer's place line already wears, the wordmark in `ground`. Not appended to the terms row: that saved height but wrapped into a stray third line on any narrow footer. Costs ~24px; reads as a signature. Drawn entirely from the palette's own on-ink ramp plus the monochrome white mark asset, so it recolours seven ways for free. Never the shop's accent, never kaiibi blue.

**Files:**
- Modify: `src/components/storefront/shop-footer.tsx`
- Test: `src/components/__tests__/storefront-shop-footer.test.tsx` (create; or extend the existing footer suite if `grep -rln "ShopFooter" src/components/__tests__` finds one)

- [ ] **Step 1: Failing test**

```tsx
import { render, screen } from '@testing-library/react-native';

import { ShopFooter } from '@/components/storefront/shop-footer';
import { paletteColors } from '@/lib/storefront-catalog';

const shop = (over: Partial<Parameters<typeof ShopFooter>[0]['storefront']> = {}) =>
  ({ shopName: 'Test Shop', city: 'Hargeisa', whatsappE164: null, hideBranding: false, ...over }) as never;

describe('footer branding', () => {
  it('shows the mark on a plan that includes it', () => {
    render(<ShopFooter storefront={shop()} colors={paletteColors('ink')} />);
    expect(screen.getByTestId('storefront-powered-by')).toBeTruthy();
  });

  it('hides the mark when the plan buys it off', () => {
    render(<ShopFooter storefront={shop({ hideBranding: true })} colors={paletteColors('ink')} />);
    expect(screen.queryByTestId('storefront-powered-by')).toBeNull();
  });
});
```

Run: `npx jest storefront-shop-footer` — expected FAIL.

- [ ] **Step 2: Implement**

In `shop-footer.tsx`, extend imports (`Image`, `Linking`, `Pressable` from `react-native`). The existing terms `<Text>` and its style stay untouched — the lockup is purely additive, directly after it:

```tsx
      {/* ATTRIBUTION, not acquisition: a colophon lockup below the terms --
          the confirmation screen is where the one ask lives. The eyebrow
          reuses the caps meta treatment the place line above already wears,
          so the signature belongs to this page's own type system. Drawn from
          the on-ink ramp + the monochrome mark: recolours with the palette
          and never outranks the shop's own accent. */}
      {storefront.hideBranding ? null : (
        <Pressable
          testID="storefront-powered-by"
          accessibilityRole="link"
          onPress={() => Linking.openURL('https://kaiibi.com')}
          style={styles.brand}
        >
          <Image source={require('@/assets/images/kaiibi-mark-white.png')} style={styles.brandMark} />
          <View>
            <Text style={[styles.brandEyebrow, { color: colors.onDarkMuted }]}>Powered by</Text>
            <Text style={[styles.brandName, { color: colors.ground }]}>kaiibi</Text>
          </View>
        </Pressable>
      )}
```

New styles (the eyebrow mirrors `place`'s meta treatment above it):

```ts
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 19, alignSelf: 'flex-start' },
  brandMark: { width: 21, height: 21 },
  brandEyebrow: {
    fontSize: TYPE.metaSmall - 1, fontWeight: '800',
    letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  brandName: { fontSize: 14.5, fontWeight: '800', letterSpacing: LETTER.display, marginTop: 1 },
```

- [ ] **Step 3: Run, typecheck, commit**

```bash
npx jest storefront && npx tsc --noEmit
git add src/components/storefront/shop-footer.tsx src/components/__tests__/storefront-shop-footer.test.tsx
git commit -m "feat(storefront): a powered-by kaiibi colophon closes the footer"
```

---

### Task 11: The one acquisition ask, on the confirmation

The customer has ordered; the shop has what it wanted — the only moment an ask on kaiibi's behalf costs the merchant nothing. Outlined button, **below** the order link, plan-aware. The flag threads `ConfirmationScreen → OrderPlaced` because `OrderPlaced` deliberately has no storefront prop.

**Files:**
- Modify: `src/components/storefront/order-placed.tsx`
- Modify: `src/components/storefront/theme-shared.tsx` (`ConfirmationScreen` at :1063 passes it through; its own callers already hold the storefront)
- Test: the existing order-placed/confirmation suite (locate: `grep -rln "OrderPlaced" src/components/__tests__ src/__tests__`)

- [ ] **Step 1: Failing test** (in the located suite, with its existing fixtures)

```tsx
it('offers the one acquisition ask, and drops it when branding is bought off', () => {
  const base = { order, shopName: 'Test Shop', collectLocation: null, colors: paletteColors('ink') };
  const { rerender } = render(<OrderPlaced {...base} hideBranding={false} />);
  expect(screen.getByTestId('storefront-acquisition')).toBeTruthy();
  rerender(<OrderPlaced {...base} hideBranding />);
  expect(screen.queryByTestId('storefront-acquisition')).toBeNull();
});
```

Run to FAIL.

- [ ] **Step 2: Implement**

`order-placed.tsx` — add to `Props`: `hideBranding?: boolean;` (optional so a caller that predates this still type-checks, matching `collectLocation`'s own precedent). After the pay-total block, before the card closes:

```tsx
      {hideBranding ? null : (
        <View style={[styles.acq, { borderTopColor: colors.hairline }]} testID="storefront-acquisition">
          <View style={styles.acqWho}>
            <Text style={[styles.acqLead, { color: colors.ink }]}>Run a shop yourself?</Text>
            <Text style={[styles.acqSub, { color: colors.muted }]}>Take orders like this one on kaiibi.</Text>
          </View>
          {/* Outlined, never accent-filled: the accent belongs to the shop
              and to buying, and this is neither. */}
          <Pressable
            accessibilityRole="link"
            onPress={() => Linking.openURL('https://kaiibi.com')}
            style={[styles.acqButton, { borderColor: colors.edge }]}
          >
            <Text style={[styles.acqButtonText, { color: colors.ink }]}>See how</Text>
          </Pressable>
        </View>
      )}
```

Styles:

```ts
  acq: {
    borderTopWidth: 1, marginTop: 18, paddingTop: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
  },
  acqWho: { flexShrink: 1 },
  acqLead: { fontSize: 13.5, fontWeight: '800' },
  acqSub: { fontSize: 12.5, marginTop: 2 },
  acqButton: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  acqButtonText: { fontSize: 12.5, fontWeight: '800' },
```

`theme-shared.tsx` `ConfirmationScreen` (:1063): add `hideBranding?: boolean;` to its props and pass `hideBranding={hideBranding}` into its `<OrderPlaced ... />`; at `ConfirmationScreen`'s callsites in the three themes, pass `hideBranding={storefront.hideBranding}`.

- [ ] **Step 3: Run, typecheck, commit**

```bash
npx jest storefront && npx tsc --noEmit
git add src/components/storefront/order-placed.tsx src/components/storefront/theme-shared.tsx src/components/storefront/theme-market.tsx src/components/storefront/theme-counter.tsx src/components/storefront/theme-window.tsx
git commit -m "feat(storefront): one acquisition ask on the confirmation, gone on pro"
```

---

### Task 12: The mark on the order-status page

`kaiibi.com/o/<code>` is the link a customer saves and reopens — the highest repeat exposure in the product. It renders from its own `get_public_order` RPC, so the flag rides that payload the same way Task 9 rode `get_public_storefront`.

**Files:**
- Create: `supabase/migrations/20261101000300_public_order_hide_branding.sql`
- Modify: `src/components/storefront/public-order-view.tsx` (and the lib that maps `get_public_order` — locate with `grep -rn "get_public_order" src/lib src/components/storefront`)

- [ ] **Step 1: RPC migration** — same recipe as Task 9 Step 2: find the latest `get_public_order` definition (`grep -rln "get_public_order" supabase/migrations/ | sort | tail -1`), copy it forward, add `hide_branding boolean` to the returns table, `coalesce(pl.hide_storefront_branding, false)` to the select, `left join lateral public.shop_effective_plan(<order alias>.shop_id) pl on true` to the from clause, and re-grant to `anon, authenticated`.

- [ ] **Step 2: Client** — in the `get_public_order` mapping add `hideBranding: Boolean(row.hide_branding)`; in `public-order-view.tsx`, at the bottom of the rendered card, the same quiet row as the footer but on light ground (black mark, palette `muted` text):

```tsx
      {order.hideBranding ? null : (
        <View style={styles.poweredRow} testID="storefront-order-powered-by">
          <Image source={require('@/assets/images/kaiibi-mark-black.png')} style={styles.poweredMark} />
          <Text style={[styles.poweredText, { color: colors.muted }]}>
            Powered by <Text style={{ fontWeight: '800', color: colors.ink }}>kaiibi</Text>
          </Text>
        </View>
      )}
```

```ts
  poweredRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 18, justifyContent: 'center' },
  poweredMark: { width: 14, height: 14 },
  poweredText: { fontSize: 11.5, fontWeight: '600' },
```

- [ ] **Step 3: Run migrations + suites, typecheck, commit**

```bash
npx supabase migration up && npx jest storefront && npx tsc --noEmit
git add supabase/migrations/20261101000300_public_order_hide_branding.sql src/components/storefront/public-order-view.tsx src/lib
git commit -m "feat(storefront): the saved order link carries the mark, gone on pro"
```

---


## Final verification

- [ ] `npx jest storefront` — all suites green (worktree baseline 223 suites / 4,099 tests, plus the suites this plan adds).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx supabase migration up` applied cleanly in order 20261101000000 → 20261101000300.
- [ ] **On device/web via `/testing-kaiibi`:** pick Azure in the editor and confirm the save persists (Task 1); add-first-item does not jump the grid (Task 5); at a wide window the slip sits inside the goods column (Tasks 6–7); the slip's Checkout button and the place-order button are apple blue on a Palm shop and on a Plum shop — while Add buttons and the active category pill stay that shop's accent (Task 7 Steps 0/6); at ≥1600px the shop fills a 1320px column and the grid runs five columns (Task 8); footer colophon present on a free shop, absent on a pro shop (Tasks 9–10).

## Non-goals (explicitly out)

- Any admin surface: Accounting hubs, POS, `theme.ts` tokens, tab pills, the storefront **editor** UI.
- **An eighth palette** — two candidates explored and gate-validated 2026-09-05, both **rejected**: Slate (cool graphite, `#34495e` accent) and Lagoon (teal set, `#008080` accent, composed from a user-provided swatch family). The existing seven cover the need; apple blue is the direction. Both live in the design doc's record if ever wanted.
- **Flipping `DEFAULT_PALETTE` to azure** — deferred (2026-09-05 simplification): shops pick. If wanted later it is one migration (`alter column palette set default 'azure'`) plus one constant, and no existing row changes colour.
- **The slip's "closed now" hint** and **drawing in-stock dots in `ink`** — deferred polish, cut for simplicity. Both remain worth doing; neither blocks anything here.
- **Catalogue fetch pagination** — `get_public_storefront_products` returns the whole catalogue in one call. Rendering already copes (Market/Window are virtualized FlatLists; Counter is a price-list scroll; search appears at 12+ items) — fine at hundreds of products, a task of its own at thousands.
- The anchor-card duplicated-tagline / grey-scrim defect — real, untraced, and a debugging session of its own (`superpowers:systematic-debugging`), not a design task.
- The desktop docked-cart variant (option C) — revisit only with desktop traffic data.
- A "Verified shop" badge — needs a checkable definition of *verified* first.
