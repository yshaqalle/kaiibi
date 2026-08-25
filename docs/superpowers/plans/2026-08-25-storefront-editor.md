# Storefront Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop owner can claim `<slug>.kaiibi.com`, choose a design and colours, write their page, set the areas they deliver to and what they charge, and publish — without anyone writing SQL.

**Architecture:** A dedicated full-screen editor route under `(admin)`, not a settings panel: picker strips across the top, actions in a bar, and the real `StorefrontView` from plan 1 rendering live underneath as the preview. **Edit text & images** opens a form drawer over that preview rather than making it editable in place. All shop-side writes go through one data-layer module so the editor screen holds layout and state, not queries.

**Tech Stack:** Expo SDK 57 / Expo Router, React Native Web (`web.output: "single"`), Supabase Postgres + RLS, Jest with `react-test-renderer`, psql verify scripts.

## How this plan is written, and why

Plan 1 shipped with four defects that all originated in *its own example code*, not in implementer error, and all four shared one shape: a guard that a sibling had and this one didn't. It also asserted four repo facts that turned out to be stale.

So this plan does two things differently, and an implementer should read them as binding:

1. **Code blocks marked *illustrative* are a starting point, not a specification.** Where a step states a PROPERTY the code must satisfy, satisfy the property and write the guard yourself. Copying a snippet verbatim reproduces its bugs. Test code is the exception — use those exactly.
2. **Every repo fact below carries a `file:line` citation, verified on 2026-08-25.** If a citation does not match what you find, stop and report it rather than adapting silently.

## Global Constraints

- **Expo SDK 57.** Read `https://docs.expo.dev/versions/v57.0.0/` before writing framework code (`AGENTS.md`).
- **This is an admin screen, so it is bento**: grey page (`bentoPage`), borderless 26px white cards, `const theme = Colors.light` pinned, tokens from `src/constants/theme.ts`, never a hex literal. See `.claude/skills/building-bento-screens/SKILL.md`. The PREVIEW inside it is exempt — it renders the shop's own palette from `src/lib/storefront-catalog.ts`.
- **`Caveat` takes `tone: 'wrong' | 'context' | 'partial'` and an optional `action: { label, onPress }`** (`src/components/ui/caveat.tsx:32,40-48`). A `wrong` tone must always name its fix.
- **`BentoCard` takes `title?`, `scope?`, `actions?`, `children`, `style?`, `bodyStyle?`** (`src/components/ui/bento-card.tsx:18-33`).
- **Modules gate by trigger, never by policy** (`supabase/migrations/20260818000400_module_write_gates.sql`). `storefronts` and `storefront_delivery_areas` already carry those triggers (`20260924000000_storefront.sql`).
- **`security definer` functions must `revoke execute … from public` BEFORE granting**, because Postgres grants EXECUTE to PUBLIC by default and the grant is otherwise a no-op. This is the house convention (`20260924000100_storefront_public_read.sql:103-109`, and every sibling in `supabase/migrations/20260825*`).
- **Migrations are `YYYYMMDDHHMMSS_name.sql`.** This plan uses the `20260925*` series. `20260908*`–`20260909*` are occupied by the unmerged `auto-posting-plan` branch.
- **Unit tests:** `npm test`. **DB tests:** `npm run test:db` (`--no-reset` while iterating; the local stack is shared with other sessions).
- **Component tests use `react-test-renderer`** with a `textsIn` flattening helper — `@testing-library/react-native` is NOT a dependency. Copy the pattern from `src/components/__tests__/list-card.test.tsx:1-11`.
- **`src/lib/storefront.ts` imports the real Supabase client**, which throws at module load without env vars. Test files that reach it need `jest.mock('@/lib/supabase', () => ({ supabase: {} }));` — the convention in `src/lib/__tests__/support.test.ts:5`.

## What plan 1 already provides

Do not rebuild any of this. Exact signatures, verified:

| From | Exports |
|---|---|
| `src/lib/storefront-slug.ts` | `normalizeSlug(input: string): string`, `validateSlug(input: string): SlugProblem \| null`, `RESERVED_SLUGS`, `type SlugProblem = 'too_short' \| 'too_long' \| 'bad_characters' \| 'edge_hyphen' \| 'reserved'` |
| `src/lib/storefront-catalog.ts` | `THEMES`, `PALETTES`, `DEFAULT_THEME`, `DEFAULT_PALETTE`, `paletteColors(p): PaletteColors`, `mutedInk(p): string`, `WHATSAPP_BUTTON_GREEN`, `WHATSAPP_INK`, types `StorefrontTheme` / `StorefrontPalette` / `PaletteColors` |
| `src/lib/phone-e164.ts` | `toE164(input, defaultCountry?): string \| null`, `formatE164ForDisplay(e164): string` |
| `src/lib/storefront.ts` | `getPublicStorefront`, `getPublicStorefrontProducts`, `waLink(e164, message)` |
| `src/components/storefront/storefront-view.tsx` | `StorefrontView({ storefront, products })` |
| `src/types/models.ts` | `PublicStorefront`, `StorefrontProduct` |

Schema: `shops.slug` (unique, DNS-shaped CHECK, reserved-name CHECK), `shops.whatsapp_e164` (E.164 CHECK), `storefronts` (theme, palette, headline, about, hero_image_url, offers_delivery, payment_mode, published_at), `storefront_delivery_areas` (name, `fee_cents >= 0`, sort_order, unique per shop).

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/storefront-admin.ts` | Every shop-side read and write. The editor screen contains no queries. |
| `src/components/storefront/editor/design-strip.tsx` | Theme tiles and the colour row. Presentational. |
| `src/components/storefront/editor/content-drawer.tsx` | The form: slug, headline, about, hero image, WhatsApp number. |
| `src/components/storefront/editor/delivery-editor.tsx` | Offer-delivery switch, area rows with fees. |
| `src/components/storefront/editor/publish-bar.tsx` | Top bar: status pill, Edit, phone/desktop toggle, Publish. |
| `src/app/(admin)/storefront.tsx` | The editor route. Layout and state only. |
| `supabase/migrations/20260925000000_storefront_slug_claim.sql` | `claim_shop_slug` RPC. |
| `supabase/tests/verify-storefront-editor.sql` | DB checks for slug claiming and publish preconditions. |

**Modified**

| File | Change |
|---|---|
| `src/components/settings/settings-sidebar.tsx:75-79` | Add the nav item, gated by `module: 'storefront'`. |
| `src/app/(admin)/settings.tsx:178` | Route that nav id to the editor. |
| `src/app/_layout.tsx` | Resolve the hostname before first render, killing the marketing-page flash. |
| `src/lib/storefront-host.ts` | No change expected; cited so its behaviour is not duplicated. |

---

### Task 1: Claiming a slug without leaking who owns what

A slug is globally unique, so "is this free?" is a question about rows the asker cannot see. Answering it with a plain `select` would either return nothing useful under RLS or expose other shops.

**Files:**
- Create: `supabase/migrations/20260925000000_storefront_slug_claim.sql`
- Create: `supabase/tests/verify-storefront-editor.sql`

**Interfaces:**
- Produces: `public.is_slug_available(p_slug text) returns boolean`, `public.claim_shop_slug(p_shop_id uuid, p_slug text) returns text`.

**Properties the SQL must satisfy** — write the guards yourself:

1. `is_slug_available` returns false for any slug already taken by ANY shop, and false for a reserved name, and true otherwise. It must reveal nothing beyond that boolean — no shop id, no name, no error text that differs between "taken" and "reserved".
2. It is `security definer` with `set search_path = public`, because it necessarily reads rows the caller cannot see under RLS.
3. It compares case-insensitively. Slugs are lowercased on the way in, but a caller may not have done that.
4. `claim_shop_slug` must be callable ONLY by a member of `p_shop_id`. It is `security definer`, so RLS does not protect it — it must check membership itself with `public.is_shop_member(p_shop_id)` (`supabase/migrations/0018_staff_shop_access.sql:10`) and raise otherwise.
5. It must also check the shop has the `storefront` module via `public.shop_has_module(p_shop_id, 'storefront')` (`supabase/migrations/20260818000200_entitlement_resolution.sql:61`). The table triggers gate `storefronts`, but this function writes `shops`, which they do not cover.
6. Losing a race must raise a distinguishable, typed error rather than a raw `unique_violation`, so the client can say "someone just took that" rather than a constraint name.
7. **Follow the house grant convention**: `revoke execute … from public` first, then `grant execute … to authenticated`. NOT to `anon` — this is a shop-side function.

Illustrative shape only — the guards above are the specification:

```sql
create or replace function public.claim_shop_slug(p_shop_id uuid, p_slug text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_slug text := lower(trim(p_slug));
begin
  -- membership, module, availability guards go here
  update public.shops set slug = v_slug where id = p_shop_id;
  return v_slug;
exception when unique_violation then
  raise exception 'slug_taken' using errcode = 'P0001';
end;
$$;
```

- [ ] **Step 1: Write the failing checks**

Create `supabase/tests/verify-storefront-editor.sql`. Follow the DO-block-with-rollback shape of `supabase/tests/verify-storefront.sql`, including how it creates an `auth.users` row before a shop. Assert:

- a fresh slug is available; after claiming, it is not
- a reserved name (`api`) is never available
- availability is case-insensitive (`XAMDI` is unavailable once `xamdi` is taken)
- `claim_shop_slug` raises when called by a non-member — set `local role` / `request.jwt.claims` the way the existing suite establishes identity, or create a second shop under a second user and attempt a cross-claim
- `claim_shop_slug` raises when the shop's plan lacks the `storefront` module (move it to the `free` plan; `20260923000000_storefront_module_grant.sql` grants the module to `trial` and `pro` only)
- claiming a slug another shop already holds raises `slug_taken`, not a bare constraint error

- [ ] **Step 2: Run and watch it fail**

```bash
npm run test:db -- --no-reset
```

Expected: FAIL — `function public.is_slug_available(unknown) does not exist`.

- [ ] **Step 3: Write the migration, satisfying every property above**

- [ ] **Step 4: Prove the grants are real**

Not optional. Revoke `execute` on `claim_shop_slug` from `authenticated`, confirm the suite goes RED, restore, confirm GREEN. If revoking changes nothing, the `revoke … from public` is missing — that exact gap shipped in plan 1.

- [ ] **Step 5: Run and watch it pass**

```bash
npm run test:db -- --no-reset
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260925000000_storefront_slug_claim.sql supabase/tests/verify-storefront-editor.sql
git commit -m "feat(storefront): claim a slug without leaking who owns what"
```

---

### Task 2: The shop-side data layer

**Files:**
- Create: `src/lib/storefront-admin.ts`
- Test: `src/lib/__tests__/storefront-admin.test.ts`

**Interfaces:**
- Consumes: `validateSlug`, `normalizeSlug` (`src/lib/storefront-slug.ts`); `toE164` (`src/lib/phone-e164.ts`); `DEFAULT_THEME`, `DEFAULT_PALETTE` (`src/lib/storefront-catalog.ts`).
- Produces:

```ts
export type ShopStorefront = {
  shopId: string;
  slug: string | null;
  whatsappE164: string | null;
  theme: StorefrontTheme;
  palette: StorefrontPalette;
  headline: string | null;
  about: string | null;
  heroImageUrl: string | null;
  offersDelivery: boolean;
  publishedAt: string | null;
};
export type DeliveryArea = { id: string; name: string; feeCents: number; sortOrder: number };
export type PublishBlocker = 'no_slug' | 'no_whatsapp' | 'no_products';

export function publishBlockers(input: {
  slug: string | null;
  whatsappE164: string | null;
  onlineProductCount: number;
}): PublishBlocker[];

export async function getMyStorefront(shopId: string): Promise<ShopStorefront | null>;
export async function ensureStorefront(shopId: string): Promise<ShopStorefront>;
export async function saveStorefront(shopId: string, patch: Partial<Omit<ShopStorefront, 'shopId' | 'slug' | 'publishedAt'>>): Promise<void>;
export async function checkSlug(slug: string): Promise<'available' | 'taken' | SlugProblem>;
export async function claimSlug(shopId: string, slug: string): Promise<string>;
export async function listDeliveryAreas(shopId: string): Promise<DeliveryArea[]>;
export async function saveDeliveryArea(shopId: string, area: { id?: string; name: string; feeCents: number; sortOrder: number }): Promise<void>;
export async function deleteDeliveryArea(id: string): Promise<void>;
export async function setPublished(shopId: string, published: boolean): Promise<void>;
```

Only the two pure functions are unit-tested here. The async ones hit Supabase and are covered by Task 1's DB checks; do not build a mock harness for them.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/storefront-admin.test.ts`:

```ts
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import { publishBlockers } from '@/lib/storefront-admin';

describe('publishBlockers', () => {
  it('lets a complete shop publish', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 3 })).toEqual([]);
  });

  it('blocks without a slug', () => {
    expect(publishBlockers({ slug: null, whatsappE164: '+252634456789', onlineProductCount: 3 })).toContain('no_slug');
  });

  it('blocks without a WhatsApp number, because every button on the page opens that chat', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: null, onlineProductCount: 3 })).toContain('no_whatsapp');
  });

  it('blocks with nothing listed, because an empty page helps nobody', () => {
    expect(publishBlockers({ slug: 'xamdi', whatsappE164: '+252634456789', onlineProductCount: 0 })).toContain('no_products');
  });

  it('reports every blocker at once rather than one at a time', () => {
    const blockers = publishBlockers({ slug: null, whatsappE164: null, onlineProductCount: 0 });
    expect(blockers).toEqual(expect.arrayContaining(['no_slug', 'no_whatsapp', 'no_products']));
    expect(blockers).toHaveLength(3);
  });
});
```

That last test is the point of the function: a shop that fixes one blocker and is then told about a second has been made to do the work twice.

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- storefront-admin
```

- [ ] **Step 3: Implement the module**

`publishBlockers` is pure and returns all blockers. The async functions:

- `getMyStorefront` selects the shop's `slug`/`whatsapp_e164` alongside its `storefronts` row. `ensureStorefront` inserts a default row when none exists and returns it — the module trigger will refuse if the plan lacks `storefront`, and that error must propagate unchanged so `describePlanError` can turn it into an upgrade prompt (`src/lib/entitlements.ts:247,279`).
- `checkSlug` runs `validateSlug` FIRST and returns the `SlugProblem` without a round trip when it fails; only a structurally valid slug reaches `is_slug_available`. This is the wiring that makes plan 1's `validateSlug` reachable.
- `claimSlug` calls the RPC and maps the `slug_taken` error to a thrown `Error('slug_taken')`.
- `setPublished` writes `published_at = now()` or `null`.

- [ ] **Step 4: Run and watch it pass**

```bash
npm test -- storefront-admin
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/storefront-admin.ts src/lib/__tests__/storefront-admin.test.ts
git commit -m "feat(storefront): shop-side data layer for the editor"
```

---

### Task 3: The design strip

**Files:**
- Create: `src/components/storefront/editor/design-strip.tsx`
- Test: `src/components/__tests__/storefront-design-strip.test.tsx`

**Interfaces:**
- Consumes: `THEMES`, `PALETTES`, `paletteColors` (`src/lib/storefront-catalog.ts`).
- Produces: `<DesignStrip theme palette neverPublished onThemeChange onPaletteChange />` where the handlers are `(key) => void` and `neverPublished: boolean` says the shop has never published.

**Correction, found during implementation:** an earlier draft gated the "Chosen for you" badge on `publishedAt` while passing no such prop, so the first implementer derived it from `theme === DEFAULT_THEME && palette === DEFAULT_PALETTE`. That conflates "never touched" with "currently equals the default", so a shop that deliberately returns to Market/Ink after customising is wrongly told the design was chosen for it. `neverPublished` is the fix, and **Task 7 must pass it** as `storefront.publishedAt === null`.

**Properties:**

1. Renders every entry in `THEMES` and every entry in `PALETTES` — derived from the catalogues, never a hardcoded list, so adding a seventh palette needs no change here.
2. The selected theme and palette are distinguishable to a screen reader, not by colour alone: set `accessibilityState={{ selected: true }}`.
3. Each colour swatch shows that palette's actual `ground`/`soft`/`accent` from `paletteColors`, so the choice is visible before it is applied.
3a. The badge shows only when `neverPublished` is true, and depends on nothing else. It means "we picked this so you wouldn't have to"; once a shop has published, it has chosen, whatever it chose.
4. Horizontally scrollable — on a 380px phone the three themes and six palettes do not fit, and this must stay usable on a phone-only shop.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/storefront-design-strip.test.tsx`, using the `react-test-renderer` + `textsIn` pattern from `src/components/__tests__/list-card.test.tsx:1-11`:

```tsx
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { DesignStrip } from '@/components/storefront/editor/design-strip';
import { THEMES, PALETTES } from '@/lib/storefront-catalog';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function render(theme = 'market', palette = 'ink') {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(
      <DesignStrip theme={theme as never} palette={palette as never} onThemeChange={() => {}} onPaletteChange={() => {}} />,
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

describe('DesignStrip', () => {
  it('offers every theme in the catalogue', () => {
    const texts = render();
    for (const t of THEMES) expect(texts).toContain(t.label);
  });

  it('offers every palette in the catalogue', () => {
    const texts = render();
    for (const p of PALETTES) expect(texts).toContain(p.label);
  });

  it('says which design is chosen for a shop that has not chosen one', () => {
    expect(render()).toContain('Chosen for you');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- storefront-design-strip
```

- [ ] **Step 3: Implement it**

Bento tokens for the strip chrome; palette colours only inside the swatches. The "Chosen for you" badge appears on the default theme when `publishedAt` has never been set — a shop should understand it already has a working design rather than believing it must choose before anything works.

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/editor/design-strip.tsx src/components/__tests__/storefront-design-strip.test.tsx
git commit -m "feat(storefront): theme and colour picker strip"
```

---

### Task 4: The content drawer

**Files:**
- Create: `src/components/storefront/editor/content-drawer.tsx`
- Test: `src/components/__tests__/storefront-content-drawer.test.tsx`

**Interfaces:**
- Consumes: `normalizeSlug`, `validateSlug`, `type SlugProblem` (`src/lib/storefront-slug.ts`); `toE164`, `formatE164ForDisplay` (`src/lib/phone-e164.ts`); `checkSlug` (Task 2).
- Produces: `<ContentDrawer value onChange onClaimSlug slugState />` where `value: { slug, headline, about, heroImageUrl, whatsappE164 }`, `slugState: 'idle' | 'checking' | 'available' | 'taken' | SlugProblem`.

**Properties:**

1. As the shop types a name, the slug field SUGGESTS `normalizeSlug(name)` but never silently rewrites what they typed into the slug field itself. An address is a thing they will print on a card; changing it under them is worse than rejecting it.
2. Every `SlugProblem` maps to a sentence a shopkeeper can act on. `'reserved'` must not say "reserved" — say the name is not available and suggest another. `'too_short'`, `'too_long'`, `'bad_characters'` and `'edge_hyphen'` each get their own wording.
3. The WhatsApp field stores `toE164(input)` and DISPLAYS `formatE164ForDisplay`. A number that fails to normalise is rejected with an explanation, never stored raw.
4. Changing the slug when one is already set warns that the old address stops working immediately — anything already shared or printed breaks.
5. The opening photo uploads through the existing `uploadImage(path, localUri)` (`src/lib/storage.ts:26`), the same helper `uploadShopLogo` uses (`src/lib/shops.ts:55-57`). Do not add a second upload path. Only `Window` reads this image, so say so beside the field — a shop on `Market` should not be left wondering why their photo never appears.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/storefront-content-drawer.test.tsx` with the same `textsIn` helper. Assert:

```tsx
it('explains every slug problem in words a shopkeeper can act on', () => {
  const problems = ['too_short', 'too_long', 'bad_characters', 'edge_hyphen', 'reserved'] as const;
  for (const p of problems) {
    const texts = renderDrawer({ slugState: p });
    const joined = texts.join(' ');
    expect(joined).not.toContain(p);           // never leak the enum
    expect(joined.length).toBeGreaterThan(0);
  }
});

it('warns that changing an existing address breaks what was already shared', () => {
  expect(renderDrawer({ slug: 'xamdi' }).join(' ')).toMatch(/stops working|already shared|printed/i);
});

it('shows a stored number in readable form', () => {
  expect(renderDrawer({ whatsappE164: '+252634456789' })).toContain('+252 63 4456789');
});
```

```tsx
it('suggests a slug from the shop name but never rewrites what was typed', () => {
  const onChange = jest.fn();
  const texts = renderDrawer({ shopName: "Xamdi's Electronics", slug: '' , onChange });
  // The suggestion is offered as text the shop can accept...
  expect(texts.join(' ')).toContain('xamdis-electronics');
  // ...and nothing was written into the slug field on their behalf.
  expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ slug: 'xamdis-electronics' }));
});

it('rejects a phone number it cannot normalise instead of storing it raw', () => {
  const onChange = jest.fn();
  const texts = renderDrawer({ whatsappE164: null, draftPhone: 'call me', onChange });
  expect(texts.join(' ')).toMatch(/not a (valid )?number|check the number/i);
  expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ whatsappE164: 'call me' }));
});

it('stores a typed local number in E.164', () => {
  const onChange = jest.fn();
  renderDrawer({ draftPhone: '0634456789', onChange, commitPhone: true });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ whatsappE164: '+252634456789' }));
});
```

`renderDrawer` is your own helper over `act`/`create`, returning `textsIn(tree.toJSON())`. Give it the props each assertion needs; the shape above is what the component must support.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/editor/content-drawer.tsx src/components/__tests__/storefront-content-drawer.test.tsx
git commit -m "feat(storefront): content drawer with slug claiming"
```

---

### Task 5: Delivery areas and fees

**Files:**
- Create: `src/components/storefront/editor/delivery-editor.tsx`
- Test: `src/components/__tests__/storefront-delivery-editor.test.tsx`

**Interfaces:**
- Consumes: `DeliveryArea`, `saveDeliveryArea`, `deleteDeliveryArea` (Task 2); `formatCents` (`src/lib/currency.ts:9`), `toCents` (`src/lib/currency.ts:1`).
- Produces: `<DeliveryEditor offersDelivery areas onToggle onSave onDelete />`.

**Properties:**

1. With `offersDelivery` false, no area fields render at all. Checkout becomes collection-only; showing a disabled area list would suggest otherwise.
2. A fee of `$0.00` is valid and means free to that area. It must be enterable and must not read as "unset".
3. A negative fee is impossible to enter. The DB CHECK (`fee_cents >= 0`) is the backstop, not the interface.
4. Money is entered through `toCents` and displayed through `formatCents`. Do not add a third money path.
5. Turning delivery ON with no areas listed shows a `wrong` caveat naming its fix — that state produces a checkout offering delivery to nowhere.

- [ ] **Step 1: Write the failing test**

```tsx
it('hides the area list entirely when delivery is off', () => {
  const texts = renderEditor({ offersDelivery: false, areas: [{ id: '1', name: 'Ahmed Dhagah', feeCents: 100, sortOrder: 0 }] });
  expect(texts).not.toContain('Ahmed Dhagah');
});

it('shows a zero fee as free rather than as blank', () => {
  const texts = renderEditor({ offersDelivery: true, areas: [{ id: '1', name: 'Ahmed Dhagah', feeCents: 0, sortOrder: 0 }] });
  expect(texts.join(' ')).toMatch(/\$0\.00|Free/);
});

it('warns when delivery is on with nowhere to deliver to', () => {
  expect(renderEditor({ offersDelivery: true, areas: [] }).join(' ')).toMatch(/add.*area|nowhere|no areas/i);
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/editor/delivery-editor.tsx src/components/__tests__/storefront-delivery-editor.test.tsx
git commit -m "feat(storefront): delivery areas and per-area fees"
```

---

### Task 6: The publish bar

**Files:**
- Create: `src/components/storefront/editor/publish-bar.tsx`
- Test: `src/components/__tests__/storefront-publish-bar.test.tsx`

**Interfaces:**
- Consumes: `PublishBlocker`, `publishBlockers` (Task 2).
- Produces: `<PublishBar status blockers dirty onEdit onTogglePreview onPublish onUnpublish />` where `status: 'draft' | 'live'`.

**Properties:**

1. **Publish is NEVER disabled.** Pressing it with blockers opens the drawer and focuses the first blocker's `wrong` caveat. A greyed-out button with no explanation is the failure this screen exists to prevent, and the bento rule requires a `wrong` tone to name its fix.
2. Status reads `Draft`, `Live`, or `Unsaved changes` — the last of these only when `dirty`, so a shop can tell "not published" from "published, with edits not yet pushed".
3. Unpublishing is possible and reversible, and says plainly that the page will stop being reachable.

- [ ] **Step 1: Write the failing test**

```tsx
it('never disables Publish, even with every blocker present', () => {
  const tree = renderBar({ blockers: ['no_slug', 'no_whatsapp', 'no_products'] });
  const publish = findByText(tree, 'Publish');
  expect(publish.props.accessibilityState?.disabled).toBeFalsy();
  expect(publish.props.disabled).toBeFalsy();
});

it('distinguishes a draft from a live page with unsaved edits', () => {
  expect(renderBarTexts({ status: 'draft', dirty: false })).toContain('Draft');
  expect(renderBarTexts({ status: 'live', dirty: true })).toContain('Unsaved changes');
});
```

Write a `findByText` helper alongside `textsIn` that returns the node rather than its text, so the disabled assertion can inspect props.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/editor/publish-bar.tsx src/components/__tests__/storefront-publish-bar.test.tsx
git commit -m "feat(storefront): publish bar that always explains itself"
```

---

### Task 7: The editor screen

**Files:**
- Create: `src/app/(admin)/storefront.tsx`
- Test: `src/__tests__/storefront-editor-screen.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2–6, plus `StorefrontView` (`src/components/storefront/storefront-view.tsx`) and `getPublicStorefrontProducts` (`src/lib/storefront.ts`).

**Properties:**

0. Pass `neverPublished={storefront.publishedAt === null}` to `DesignStrip`. Task 3 shipped a stand-in derivation that is wrong for a shop returning to the defaults after customising; this is where the real signal lives.
1. **The preview is the real page.** Render the actual `StorefrontView` against the shop's real `is_listed_online` products. There must be no second storefront implementation that exists only in the editor — that is how a preview starts lying.
2. The preview reflects UNSAVED edits; customers keep seeing the published version until Publish. Say so on screen.
3. A shop without the `storefront` module never reaches this screen — but if it somehow does, a module error from `ensureStorefront` must surface as the upgrade prompt (`describePlanError`, `src/lib/entitlements.ts:279`), not as a crash.
4. The screen holds layout and state. Every query lives in `storefront-admin.ts`.
5. On a phone the drawer becomes a full-height sheet and the preview moves below the strips — no capability is removed.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/storefront-editor-screen.test.tsx`:

```tsx
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/storefront-admin');
jest.mock('@/lib/storefront', () => ({
  getPublicStorefrontProducts: jest.fn().mockResolvedValue([]),
  waLink: (e: string, m: string) => `https://wa.me/${e.replace(/^\+/, '')}?text=${encodeURIComponent(m)}`,
}));

import { ensureStorefront, getMyStorefront } from '@/lib/storefront-admin';
import StorefrontEditor from '@/app/(admin)/storefront';

const BASE = {
  shopId: 's1', slug: 'xamdi', whatsappE164: '+252634456789',
  theme: 'market' as const, palette: 'ink' as const,
  headline: 'Everything for the house and the phone.', about: null,
  heroImageUrl: null, offersDelivery: false, publishedAt: null,
};

describe('storefront editor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('previews the real page, not a mock of it', async () => {
    (getMyStorefront as jest.Mock).mockResolvedValue(BASE);
    (ensureStorefront as jest.Mock).mockResolvedValue(BASE);
    const texts = await renderScreen();
    expect(texts.join(' ')).toContain('Everything for the house and the phone.');
  });

  it('turns a module error into the upgrade prompt rather than throwing', async () => {
    const err = Object.assign(new Error('module_not_included'), {
      message: 'module_not_included',
      details: JSON.stringify({ module: 'storefront' }),
    });
    (getMyStorefront as jest.Mock).mockResolvedValue(null);
    (ensureStorefront as jest.Mock).mockRejectedValue(err);
    const texts = await renderScreen();
    expect(texts.join(' ')).toMatch(/plan|upgrade/i);
  });
});
```

`renderScreen` wraps `create` in `act`, flushes pending promises, and returns `textsIn(tree.toJSON())`. Add a third test of your own proving property 2: an unsaved headline edit reaches the preview without any call to `saveStorefront`.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement it**

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Commit**

```bash
git add src/app/\(admin\)/storefront.tsx src/__tests__/storefront-editor-screen.test.tsx
git commit -m "feat(storefront): the editor screen, previewing the real page"
```

---

### Task 8: Reaching it from Settings

**Files:**
- Modify: `src/components/settings/settings-sidebar.tsx:75-79` and its `SETTINGS_NAV_IDS` guard at `:31`
- Modify: `src/app/(admin)/settings.tsx:178`
- Test: `src/components/settings/panels/__tests__/` — follow the existing pattern there

**Interfaces:**
- Consumes: `Module` from `src/lib/entitlements.ts`.

`NavItem` already supports a `module?: Module` field (`src/components/settings/settings-sidebar.tsx:45`), and `promotions` uses it (`:92`). So the entry gates itself.

**Properties:**

1. The nav item carries `module: 'storefront'` so a shop without the module never sees it.
2. Its id is added to `SETTINGS_NAV_IDS` (`:31`) — that list is deliberately written out rather than derived, so a new id that is not added there fails its guard.
3. Selecting it navigates to the `(admin)/storefront` route rather than rendering a panel inline. The editor is full-screen; a settings panel would not fit the picker strip and preview.

- [ ] **Step 1: Write the failing test**

Add to the settings sidebar's existing test file (find it under `src/components/settings/panels/__tests__/` or alongside `settings-sidebar.tsx`; follow whichever convention is already there):

```tsx
import { SETTINGS_NAV, isSettingsNavId } from '@/components/settings/settings-sidebar';

describe('storefront nav entry', () => {
  const item = SETTINGS_NAV.flatMap((g) => g.items).find((i) => i.id === 'storefront');

  it('exists and is labelled for a shopkeeper', () => {
    expect(item).toBeDefined();
    expect(item!.label).toBe('Storefront');
  });

  it('is gated on the storefront module, so an unentitled shop never sees it', () => {
    expect(item!.module).toBe('storefront');
  });

  it('passes the id guard, which is written out by hand and easy to forget', () => {
    expect(isSettingsNavId('storefront')).toBe(true);
  });
});
```

If `SETTINGS_NAV` or `isSettingsNavId` are not exported, export them — the guard at `settings-sidebar.tsx:31` exists precisely so a forgotten id is caught, and a test cannot check it otherwise.

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- settings-sidebar
```

- [ ] **Step 3: Implement it**

Add `{ id: 'storefront', label: 'Storefront', icon: 'globe-outline', module: 'storefront' }` to the Shop group (`settings-sidebar.tsx:75-79`), add `'storefront'` to `SETTINGS_NAV_IDS` (`:31`), and route the id to the editor in `settings.tsx`'s switch (`:178`) with `router.push('/storefront')` rather than returning a panel.

- [ ] **Step 4: Run and watch it pass**

```bash
npm test -- settings-sidebar
```

- [ ] **Step 5: Commit**

```bash
git add src/components/settings src/app/\(admin\)/settings.tsx
git commit -m "feat(storefront): reach the editor from Settings"
```

---

### Task 9: Kill the marketing-page flash, and the leftover WhatsApp duplication

Two loose ends from plan 1, grouped because both are small and both touch shared code.

**Files:**
- Modify: `src/app/_layout.tsx`
- Modify: `src/lib/storefront.ts` and/or `src/lib/whatsapp.ts`
- Test: `src/__tests__/storefront-route.test.tsx` (existing)

**Properties:**

1. **The hostname must be resolved before the first route renders.** Today the redirect runs in a post-mount `useEffect`, so `xamdi.kaiibi.com/` paints kaiibi's marketing page and then replaces it. A customer's first impression of a shop is currently a POS advert. Resolve it during the initial render pass instead — and keep `slugFromHostname`'s fail-closed behaviour exactly as it is (`src/lib/storefront-host.ts`), so localhost and preview hosts still load the admin app.
2. **Three WhatsApp link builders now coexist**: `whatsappLink` (`src/lib/whatsapp.ts`), `waLink` (`src/lib/storefront.ts`), and `toE164` (`src/lib/phone-e164.ts`, strict). Collapse to two — one strict normaliser and one link builder — before a fourth appears. Keep every existing caller working; this is a consolidation, not a behaviour change, so existing tests for both must pass unmodified.

- [ ] **Step 1: Establish the baseline** — run `npm test` and record the count before touching anything, so a consolidation regression is visible.
- [ ] **Step 2: Write the failing test** for the pre-render hostname resolution.
- [ ] **Step 3: Run and watch it fail**
- [ ] **Step 4: Implement both**
- [ ] **Step 5: Run the FULL suite** — every pre-existing WhatsApp test must still pass unmodified. If one needs changing, stop and report; it means the consolidation changed behaviour.
- [ ] **Step 6: Commit**

```bash
git add src/app/_layout.tsx src/lib/storefront.ts src/lib/whatsapp.ts src/lib/phone-e164.ts
git commit -m "fix(storefront): resolve the host before first paint, and collapse the WhatsApp helpers"
```

---

### Task 10: Browser verification

Plan 1 shipped three defects that every test passed and only a browser caught: a product name printed twice, a missing `<title>` that made a shared link preview as the kaiibi app, and a theme silently dropping the shop's `about` text. Tests do not see any of that.

**Not optional, and not a code task.** Use `.superpowers/sdd/reseed.sh` to get a seeded shop, run `npx expo start --web`, and check at 390px:

- [ ] Claim a slug end to end. Try a taken one, a reserved one (`api`), and one that is too short — each explains itself in words a shopkeeper could act on.
- [ ] Switch through all three themes and all six palettes. The preview changes; the shop's words and photos survive every switch.
- [ ] Edit the headline. It appears in the preview before saving, and the public page still shows the old one until Publish.
- [ ] Press Publish with no WhatsApp number. The drawer opens and focuses the caveat; the button is not silently dead.
- [ ] Publish, then load the public URL in a second tab and confirm it is live. Unpublish, reload, and confirm it returns the same "no shop at this address" page as an unknown slug.
- [ ] Turn delivery on with no areas, confirm the warning. Add an area at `$0.00` and confirm it reads as free.
- [ ] Confirm the editor is bento — grey page, borderless cards, no cream tiles. `StatTile`, `Badge` and `CategoryChip` hardcode the cream palette and each need a `bento` variant (see the skill's Red Flags).
- [ ] Screenshot each theme and attach to the PR.

---

## Done when

- `npm test` passes with no previously-green test newly failing.
- `npm run test:db` passes, including `verify-storefront-editor`.
- `npx tsc --noEmit` exits 0.
- A shop owner can go from no storefront to a published page without SQL.
- Publishing is impossible without a slug, a WhatsApp number and at least one listed product — and the screen says which is missing, all at once.

## Not in this plan

| Left out | Why |
|---|---|
| Cart, checkout, `orders` | Plan 3. |
| Order inbox, fulfilment, `4300 Delivery Income` | Plan 4. |
| Click-anything inline editing | Its own spec. The button and its position are already right. |
| Wildcard DNS record | Infrastructure, not code. Point `*.kaiibi.com` at the Vercel project once a shop can claim a slug — which this plan delivers. |
| Nothing further | Task 4 ships hero-image upload, so `ThemeWindow`'s hero text can now sit over a photo — the scrim is part of that task, not a deferral. |
