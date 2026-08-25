# Storefront Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop can publish a public page at `<slug>.kaiibi.com` that renders its `is_listed_online` products in one of three themes and six palettes, readable with no session.

**Architecture:** A `storefronts` row per shop holds content, theme and palette; themes are React components that render through four CSS-variable-equivalent palette tokens, so three themes × six palettes is nine units to build. The public read path is a `security definer` RPC with an explicit column list — never `select *` — because `products.cost_cents` sits one column from `price_cents`. Hostname resolution happens once at boot from `window.location.hostname`.

**Tech Stack:** Expo SDK 57 / Expo Router, React Native Web (`web.output: "single"`), Supabase Postgres + RLS, Jest (`jest-expo`), psql verify scripts.

## Global Constraints

- **Expo SDK 57.** Read `https://docs.expo.dev/versions/v57.0.0/` before writing framework code (`AGENTS.md`).
- **Never hardcode a hex in an app screen.** Tokens come from `src/constants/theme.ts`. Storefront palettes are the one exception and live in their own catalogue — they are the *shop's* brand, not kaiibi's.
- **Admin screens are bento:** grey page, borderless 26px white cards, `Colors.light` pinned. See `.claude/skills/building-bento-screens/SKILL.md`.
- **Module and permission are orthogonal** and both must pass. Modules gate by trigger, not by policy (`20260818000400_module_write_gates.sql`).
- **Migrations are `YYYYMMDDHHMMSS_name.sql`** under `supabase/migrations/`. This plan uses the `20260924…` series.
- **Unit tests:** `npm test`. **DB tests:** `npm run test:db` (requires `npx supabase start`).
- **Every new DB check is a `verify-*.sql` added to `supabase/tests/`** and picked up by `run-all.sh`. A check that fails must `raise exception 'FAIL: …'`.
- **Payment mode is `'on_collection'` only.** No branch in this plan reads it.

---

## Plan set

The spec is four subsystems. Per the writing-plans scope check it becomes four plans, each leaving the tree working:

| Plan | Delivers | Status |
|---|---|---|
| **1. Foundation and the public page** (this document) | Module, schema, public read, hostname routing, three themes, six palettes. A published page you can visit. | Written |
| 2. The editor | Picker strip, form drawer, live preview, slug claim, publish/unpublish, delivery areas and fees. | To write |
| 3. Cart and checkout | Cart state, checkout, `orders` + `order_items`, anonymous insert with server-side totals, WhatsApp enquiry and WhatsApp checkout. | To write |
| 4. Orders inbox and fulfilment | Inbox, order detail, state machine, `4300 Delivery Income`, completion through `post_complete_sale`. | To write |

Plan 1 ships a page a shop cannot yet edit — seeded by SQL — which is deliberate: it proves the read path, the routing and the themes before any of it has an editing surface to hide behind.

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/storefront-slug.ts` | Slug normalisation, validation, reserved list. Pure. |
| `src/lib/phone-e164.ts` | Somaliland/Somalia phone normalisation to E.164. Pure. |
| `src/lib/storefront-catalog.ts` | The theme and palette catalogues. Pure data + types. |
| `src/lib/storefront-host.ts` | Hostname → slug. Pure. |
| `src/lib/storefront.ts` | Supabase reads for the public page. |
| `src/components/storefront/product-tile.tsx` | One product, photo or typographic fallback. |
| `src/components/storefront/theme-shared.tsx` | `ThemeProps`, the WhatsApp button and the empty state — the parts all three themes need. |
| `src/components/storefront/theme-market.tsx` | Market theme. |
| `src/components/storefront/theme-counter.tsx` | Counter theme. |
| `src/components/storefront/theme-window.tsx` | Window theme. |
| `src/components/storefront/storefront-view.tsx` | Picks the theme component, supplies palette. |
| `src/app/s/[slug].tsx` | The public route. |
| `supabase/migrations/20260924000000_storefront.sql` | Schema, RLS, module gate. |
| `supabase/migrations/20260924000100_storefront_public_read.sql` | The public read RPCs. |
| `supabase/tests/verify-storefront.sql` | DB checks, including that cost never leaks. |

**Modified**

| File | Change |
|---|---|
| `src/lib/entitlements.ts:20-64` | Add the `storefront` module. |
| `src/app/_layout.tsx` | Resolve a storefront host before the normal app shell. |
| `src/types/models.ts` | `Storefront`, `StorefrontProduct` types. |

---

### Task 1: The `storefront` module, in the catalogue *and* in a plan

Adding a module to `entitlements.ts` grants it to nobody. `plans.modules` is a seeded `text[]` (`20260818000000_plans_and_subscriptions.sql:195-219`) and the module gate reads that array — so without the migration below, every `insert into public.storefronts` raises `module_not_included`, including the one in Task 6's DB test.

**Files:**
- Modify: `src/lib/entitlements.ts:20-64`
- Create: `supabase/migrations/20260923000000_storefront_module_grant.sql`
- Create: `supabase/tests/verify-storefront-module-grant.sql`
- Test: `src/lib/__tests__/entitlements.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Module` union gains `'storefront'`; `MODULES` gains an entry with that key; the `trial` and `pro` plans grant it.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/__tests__/entitlements.test.ts`:

```ts
describe('storefront module', () => {
  it('is in the catalog', () => {
    expect(ALL_MODULES).toContain('storefront');
    expect(MODULES.find((m) => m.key === 'storefront')?.label).toBe('Online storefront');
  });

  it('is not in the free fallback', () => {
    expect(FREE_FALLBACK.modules).not.toContain('storefront');
  });

  it('survives a round trip through expandModules', () => {
    expect(expandModules(['storefront', 'not_a_module'])).toEqual(['storefront']);
  });
});
```

Make sure `ALL_MODULES`, `MODULES`, `FREE_FALLBACK` and `expandModules` are in the file's existing import from `@/lib/entitlements`; add any that are missing.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- entitlements
```

Expected: FAIL — `expect(received).toContain('storefront')`.

- [ ] **Step 3: Add the module**

In `src/lib/entitlements.ts`, add to the `Module` union after `'promotions'`:

```ts
  | 'storefront'
```

and to `MODULES`, after the `promotions` entry:

```ts
  { key: 'storefront', label: 'Online storefront', description: 'A public page customers can browse and order from.' },
```

Leave `FREE_FALLBACK.modules` alone — it is deliberately `['pos', 'inventory']`.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- entitlements
```

Expected: PASS.

- [ ] **Step 5: Write the failing DB check**

Create `supabase/tests/verify-storefront-module-grant.sql`:

```sql
-- Adding a module to entitlements.ts grants it to nobody. plans.modules is a
-- seeded array, and the module gate reads that array.

\set ON_ERROR_STOP on

do $$
begin
  if not (select 'storefront' = any(modules) from public.plans where key = 'trial') then
    raise exception 'FAIL: the trial plan does not grant storefront, but its description promises full access';
  end if;

  if not (select 'storefront' = any(modules) from public.plans where key = 'pro') then
    raise exception 'FAIL: the pro plan does not grant storefront, but its description promises every module';
  end if;

  if (select 'storefront' = any(modules) from public.plans where key = 'free') then
    raise exception 'FAIL: the free plan grants storefront';
  end if;

  raise notice 'PASS: storefront module is granted where it should be';
end $$;
```

- [ ] **Step 6: Run it and watch it fail**

```bash
npm run test:db
```

Expected: FAIL — `the trial plan does not grant storefront`.

- [ ] **Step 7: Write the grant migration**

Create `supabase/migrations/20260923000000_storefront_module_grant.sql`. **Use exactly this filename.** The `20260908*` and `20260909*` slots are taken on an unmerged branch; picking a timestamp in that window produces two migrations with the same prefix when the branches meet.

```sql
-- Granting the new module to the plans whose own copy already promises it.
--
-- trial says "Full access while you evaluate Kaiibi." and pro says "Every
-- branch, every module, no caps." Leaving storefront out of either would make
-- the description a lie we charge money for, so these two are not a pricing
-- decision -- they are forced by text already shipped.
--
-- standard is DELIBERATELY EXCLUDED, and that is the pricing decision. The
-- asymmetry decides it: adding storefront to standard later is one more line
-- like these, while removing it after shops have built and published pages is
-- taking away something they are using and may have printed on a card.
--
-- free is excluded for the reason free excludes everything past a till and a
-- product list.
--
-- Idempotent, because array_append would duplicate on a re-run and
-- shop_has_module would still pass -- hiding the bug rather than failing.

update public.plans
set modules = array_append(modules, 'storefront')
where key in ('trial', 'pro')
  and not ('storefront' = any(modules));
```

- [ ] **Step 8: Run both suites and watch them pass**

```bash
npm test -- entitlements && npm run test:db
```

Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/entitlements.ts src/lib/__tests__/entitlements.test.ts \
        supabase/migrations/20260923000000_storefront_module_grant.sql \
        supabase/tests/verify-storefront-module-grant.sql
git commit -m "feat(storefront): add the storefront module and grant it to trial and pro"
```

---

### Task 2: Slug rules

A slug becomes a hostname, so the rules are DNS's, not ours. Reserved names must be blocked or a shop can claim `www.kaiibi.com`.

**Files:**
- Create: `src/lib/storefront-slug.ts`
- Test: `src/lib/__tests__/storefront-slug.test.ts`

**Interfaces:**
- Produces: `normalizeSlug(input: string): string`, `validateSlug(input: string): SlugProblem | null`, `RESERVED_SLUGS: readonly string[]`, `type SlugProblem = 'too_short' | 'too_long' | 'bad_characters' | 'edge_hyphen' | 'reserved'`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/storefront-slug.test.ts`:

```ts
import { normalizeSlug, validateSlug, RESERVED_SLUGS } from '@/lib/storefront-slug';

describe('normalizeSlug', () => {
  it('lowercases and trims', () => {
    expect(normalizeSlug('  Xamdi  ')).toBe('xamdi');
  });

  it('turns spaces and underscores into single hyphens', () => {
    expect(normalizeSlug('Xamdi   Electronics_Shop')).toBe('xamdi-electronics-shop');
  });

  it('drops characters DNS will not carry', () => {
    expect(normalizeSlug("Xamdi's Café!")).toBe('xamdis-caf');
  });

  it('collapses runs of hyphens and strips them from the ends', () => {
    expect(normalizeSlug('--xamdi---shop--')).toBe('xamdi-shop');
  });
});

describe('validateSlug', () => {
  it('accepts an ordinary slug', () => {
    expect(validateSlug('xamdi-electronics')).toBeNull();
  });

  it('rejects one shorter than three characters', () => {
    expect(validateSlug('xa')).toBe('too_short');
  });

  it('rejects one longer than sixty-three, the DNS label limit', () => {
    expect(validateSlug('a'.repeat(64))).toBe('too_long');
  });

  it('rejects uppercase and punctuation rather than silently fixing it', () => {
    expect(validateSlug('Xamdi')).toBe('bad_characters');
    expect(validateSlug('xamdi.shop')).toBe('bad_characters');
  });

  it('rejects a leading or trailing hyphen', () => {
    expect(validateSlug('-xamdi')).toBe('edge_hyphen');
    expect(validateSlug('xamdi-')).toBe('edge_hyphen');
  });

  it('rejects every reserved name', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved)).toBe('reserved');
    }
  });

  it('reserves the names the app itself answers on', () => {
    expect(RESERVED_SLUGS).toEqual(expect.arrayContaining(['www', 'app', 'api', 'admin', 'platform']));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-slug
```

Expected: FAIL — `Cannot find module '@/lib/storefront-slug'`.

- [ ] **Step 3: Write it**

Create `src/lib/storefront-slug.ts`:

```ts
// A slug becomes a DNS label -- `<slug>.kaiibi.com` -- so the rules here are
// DNS's, not ours: lowercase, a-z 0-9 and hyphen, no hyphen at either end, and
// 63 characters maximum, which is the hard limit on a single label.
//
// normalizeSlug is what we SUGGEST as someone types their shop name.
// validateSlug is what we ENFORCE. They are deliberately separate: normalising
// a rejected value would silently hand a shop a different address from the one
// they typed, and an address is the thing they are about to print on a card.

export type SlugProblem =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'edge_hyphen'
  | 'reserved';

// Names the platform answers on itself, plus the ones a browser or a mail
// server will assume. A shop holding any of these could intercept traffic
// meant for us.
export const RESERVED_SLUGS = [
  'www', 'app', 'api', 'admin', 'platform', 'dashboard', 'account', 'accounts',
  'billing', 'support', 'help', 'status', 'blog', 'docs', 'mail', 'smtp',
  'ftp', 'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'kaiibi',
] as const;

const RESERVED = new Set<string>(RESERVED_SLUGS);

export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function validateSlug(input: string): SlugProblem | null {
  if (input.length < 3) return 'too_short';
  if (input.length > 63) return 'too_long';
  if (!/^[a-z0-9-]+$/.test(input)) return 'bad_characters';
  if (input.startsWith('-') || input.endsWith('-')) return 'edge_hyphen';
  if (RESERVED.has(input)) return 'reserved';
  return null;
}
```

Note the order: length is checked before character class so `'Xa'` reports `too_short` rather than `bad_characters`, which is the more useful thing to tell someone still typing.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- storefront-slug
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storefront-slug.ts src/lib/__tests__/storefront-slug.test.ts
git commit -m "feat(storefront): slug rules, which are DNS's rules"
```

---

### Task 3: Phone normalisation to E.164

Every WhatsApp link needs E.164. The existing phone is `shop_locations.contact_phone`, free text, and cannot be dialled.

**Files:**
- Create: `src/lib/phone-e164.ts`
- Test: `src/lib/__tests__/phone-e164.test.ts`

**Interfaces:**
- Produces: `toE164(input: string, defaultCountry?: '252'): string | null`, `formatE164ForDisplay(e164: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/phone-e164.test.ts`:

```ts
import { toE164, formatE164ForDisplay } from '@/lib/phone-e164';

describe('toE164', () => {
  it('keeps an already-correct number', () => {
    expect(toE164('+252634456789')).toBe('+252634456789');
  });

  it('strips spaces, hyphens and brackets', () => {
    expect(toE164('+252 63 4 45 67 89')).toBe('+252634456789');
    expect(toE164('+252-63-4456789')).toBe('+252634456789');
  });

  it('turns a 00 prefix into a plus', () => {
    expect(toE164('00252634456789')).toBe('+252634456789');
  });

  it('adds the default country to a local number, dropping the trunk zero', () => {
    expect(toE164('0634456789')).toBe('+252634456789');
    expect(toE164('634456789')).toBe('+252634456789');
  });

  it('rejects something too short to be a number', () => {
    expect(toE164('6344')).toBeNull();
  });

  it('rejects letters', () => {
    expect(toE164('call me')).toBeNull();
    expect(toE164('')).toBeNull();
  });

  it('rejects a plus followed by nothing usable', () => {
    expect(toE164('+')).toBeNull();
  });
});

describe('formatE164ForDisplay', () => {
  it('groups a Somali number readably', () => {
    expect(formatE164ForDisplay('+252634456789')).toBe('+252 63 4456789');
  });

  it('returns anything it does not recognise unchanged', () => {
    expect(formatE164ForDisplay('+4407700900000')).toBe('+4407700900000');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- phone-e164
```

Expected: FAIL — `Cannot find module '@/lib/phone-e164'`.

- [ ] **Step 3: Write it**

Create `src/lib/phone-e164.ts`:

```ts
// WhatsApp deep links take a number in E.164 and nothing else. `wa.me/252634456789`
// works; `wa.me/0634456789` opens a chat with nobody.
//
// Deliberately not a full libphonenumber. This app serves the Horn of Africa and
// the only default that matters is 252; anything already carrying its own country
// code passes through untouched. Adding a 300kB dependency to normalise one field
// would be the wrong trade.

const DEFAULT_COUNTRY = '252';

export function toE164(input: string, defaultCountry: string = DEFAULT_COUNTRY): string | null {
  if (typeof input !== 'string') return null;

  // Keep a leading plus, then digits only.
  const trimmed = input.trim();
  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus && digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (!hadPlus) {
    // A local number: drop the trunk zero, then prepend the country code.
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!digits.startsWith(defaultCountry)) digits = defaultCountry + digits;
  }

  // E.164 allows 15 digits maximum; anything under 8 is not a phone number.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function formatE164ForDisplay(e164: string): string {
  const m = /^\+252(\d{2})(\d{7})$/.exec(e164);
  return m ? `+252 ${m[1]} ${m[2]}` : e164;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- phone-e164
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/phone-e164.ts src/lib/__tests__/phone-e164.test.ts
git commit -m "feat(storefront): normalise phone numbers to E.164 for wa.me links"
```

---

### Task 4: Theme and palette catalogues

A palette is four values. The test asserts contrast rather than trusting the hexes, using the WCAG maths already in `src/lib/contrast.ts`.

**Files:**
- Create: `src/lib/storefront-catalog.ts`
- Test: `src/lib/__tests__/storefront-catalog.test.ts`

**Interfaces:**
- Produces: `type StorefrontTheme = 'market' | 'counter' | 'window'`; `type StorefrontPalette = 'ink' | 'palm' | 'clay' | 'sea' | 'saffron' | 'plum'`; `THEMES`, `PALETTES`, `DEFAULT_THEME`, `DEFAULT_PALETTE`, `paletteColors(p: StorefrontPalette): PaletteColors`, `type PaletteColors = { ground: string; soft: string; ink: string; accent: string }`, `WHATSAPP_GREEN`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/storefront-catalog.test.ts`:

```ts
import { contrastRatio } from '@/lib/contrast';
import {
  THEMES, PALETTES, DEFAULT_THEME, DEFAULT_PALETTE,
  paletteColors, WHATSAPP_GREEN,
  type StorefrontPalette,
} from '@/lib/storefront-catalog';

describe('catalogue shape', () => {
  it('ships three themes and six palettes', () => {
    expect(THEMES.map((t) => t.key)).toEqual(['market', 'counter', 'window']);
    expect(PALETTES.map((p) => p.key)).toEqual(['ink', 'palm', 'clay', 'sea', 'saffron', 'plum']);
  });

  it('defaults to the most forgiving combination', () => {
    expect(DEFAULT_THEME).toBe('market');
    expect(DEFAULT_PALETTE).toBe('ink');
  });

  it('gives every theme and palette a label a shopkeeper can read', () => {
    for (const t of THEMES) expect(t.label.length).toBeGreaterThan(0);
    for (const p of PALETTES) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe('palette contrast', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s puts readable ink on its ground', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.ink, c.ground)).toBeGreaterThanOrEqual(7);
  });

  it.each(keys)('%s carries white text on its accent', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s keeps ink readable on its soft tile', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.ink, c.soft)).toBeGreaterThanOrEqual(7);
  });
});

describe('WhatsApp green', () => {
  it('is fixed, because it is a recognised affordance and not a brand colour', () => {
    expect(WHATSAPP_GREEN).toBe('#1f7a4d');
    expect(contrastRatio(WHATSAPP_GREEN, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('is in no palette, so no shop can recolour it by picking one', () => {
    for (const p of PALETTES) {
      expect(paletteColors(p.key).accent).not.toBe(WHATSAPP_GREEN);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-catalog
```

Expected: FAIL — `Cannot find module '@/lib/storefront-catalog'`.

- [ ] **Step 3: Write it**

Create `src/lib/storefront-catalog.ts`:

```ts
// The two catalogues a shop chooses from, and the four colours a theme renders
// through.
//
// Kept in code rather than a table for the same reason MODULES and PERMISSIONS
// are: `storefronts.theme` and `.palette` store a key, unknown keys fall back to
// the default on read, and a stored row can outlive a catalogue change.
//
// A THEME is a layout. A PALETTE is four values. Themes render through the
// palette, so three themes and six palettes is nine things to build and verify,
// not eighteen.
//
// Every palette is contrast-checked in storefront-catalog.test.ts against the
// WCAG maths in contrast.ts -- the same discipline theme.ts applies to every app
// token. A shop picks from these; it does not get a hex field. A free colour
// picker is how a page ends up yellow on white and published.

export type StorefrontTheme = 'market' | 'counter' | 'window';
export type StorefrontPalette = 'ink' | 'palm' | 'clay' | 'sea' | 'saffron' | 'plum';

export type PaletteColors = {
  ground: string; // the page
  soft: string;   // tiles, the no-photo fallback, insets
  ink: string;    // all type
  accent: string; // buttons and the active filter, always with white on it
};

export const THEMES: { key: StorefrontTheme; label: string; description: string }[] = [
  { key: 'market', label: 'Market', description: 'Even grid, price forward. Works with any number of photos.' },
  { key: 'counter', label: 'Counter', description: 'A price list. Best for a long catalogue with no photos.' },
  { key: 'window', label: 'Window', description: 'Big opening statement, larger tiles. Best when you have photos.' },
];

export const PALETTES: { key: StorefrontPalette; label: string; suits: string }[] = [
  { key: 'ink', label: 'Ink', suits: 'anything' },
  { key: 'palm', label: 'Palm', suits: 'grocery, pharmacy, produce' },
  { key: 'clay', label: 'Clay', suits: 'hardware, furniture, textiles' },
  { key: 'sea', label: 'Sea', suits: 'electronics, phones, tools' },
  { key: 'saffron', label: 'Saffron', suits: 'food, spice, tailoring' },
  { key: 'plum', label: 'Plum', suits: 'cosmetics, clothing, salon' },
];

// Market and Ink: the pair that looks deliberate for a shop that has uploaded
// nothing and chosen nothing, which is every shop on its first day.
export const DEFAULT_THEME: StorefrontTheme = 'market';
export const DEFAULT_PALETTE: StorefrontPalette = 'ink';

const COLORS: Record<StorefrontPalette, PaletteColors> = {
  ink:     { ground: '#ffffff', soft: '#f4f4f5', ink: '#141418', accent: '#141418' },
  palm:    { ground: '#fbfcfa', soft: '#eef4ef', ink: '#12211a', accent: '#1f6b45' },
  clay:    { ground: '#fdfaf7', soft: '#f5ede6', ink: '#241a14', accent: '#98452a' },
  sea:     { ground: '#fafcfd', soft: '#eaf1f5', ink: '#101f28', accent: '#155b78' },
  saffron: { ground: '#fdfbf6', soft: '#f6efe0', ink: '#241d10', accent: '#8a5a05' },
  plum:    { ground: '#fdfafc', soft: '#f5ecf2', ink: '#221420', accent: '#8a2c62' },
};

export function paletteColors(palette: StorefrontPalette): PaletteColors {
  return COLORS[palette] ?? COLORS[DEFAULT_PALETTE];
}

// NOT part of any palette, and deliberately not themeable. Green is what makes
// a WhatsApp button get tapped; recolouring it to a shop's accent trades the
// affordance for a colour nobody asked for.
export const WHATSAPP_GREEN = '#1f7a4d';
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- storefront-catalog
```

Expected: PASS, 23 tests (3 shape + 18 parameterised contrast + 2 WhatsApp).

If a contrast assertion fails, the hex is wrong and must be darkened — do not lower the threshold.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storefront-catalog.ts src/lib/__tests__/storefront-catalog.test.ts
git commit -m "feat(storefront): theme and palette catalogues, contrast asserted not assumed"
```

---

### Task 5: Hostname resolution

**Files:**
- Create: `src/lib/storefront-host.ts`
- Test: `src/lib/__tests__/storefront-host.test.ts`

**Interfaces:**
- Consumes: `RESERVED_SLUGS` from Task 2.
- Produces: `slugFromHostname(hostname: string, appDomain?: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/storefront-host.test.ts`:

```ts
import { slugFromHostname } from '@/lib/storefront-host';

describe('slugFromHostname', () => {
  it('reads the subdomain', () => {
    expect(slugFromHostname('xamdi.kaiibi.com')).toBe('xamdi');
  });

  it('ignores the apex, which is the app itself', () => {
    expect(slugFromHostname('kaiibi.com')).toBeNull();
  });

  it('ignores reserved subdomains', () => {
    expect(slugFromHostname('www.kaiibi.com')).toBeNull();
    expect(slugFromHostname('app.kaiibi.com')).toBeNull();
  });

  it('ignores a host that is not ours at all', () => {
    expect(slugFromHostname('xamdi.example.com')).toBeNull();
  });

  it('ignores localhost and preview hosts, so dev never resolves a shop by accident', () => {
    expect(slugFromHostname('localhost')).toBeNull();
    expect(slugFromHostname('kaiibi-git-branch.vercel.app')).toBeNull();
  });

  it('ignores a nested subdomain rather than guessing which label is the shop', () => {
    expect(slugFromHostname('a.b.kaiibi.com')).toBeNull();
  });

  it('is case insensitive, because hostnames are', () => {
    expect(slugFromHostname('Xamdi.Kaiibi.com')).toBe('xamdi');
  });

  it('takes the domain as an argument so tests and staging can differ', () => {
    expect(slugFromHostname('xamdi.kaiibi.test', 'kaiibi.test')).toBe('xamdi');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-host
```

Expected: FAIL — `Cannot find module '@/lib/storefront-host'`.

- [ ] **Step 3: Write it**

Create `src/lib/storefront-host.ts`:

```ts
// Which shop -- if any -- this browser tab is asking for.
//
// Web ships as an SPA behind a catch-all rewrite (vercel.json), so every host
// serves the same bundle and the hostname is the only thing distinguishing
// `xamdi.kaiibi.com` from the app. This runs once at boot.
//
// Fails CLOSED: anything it does not positively recognise as `<label>.<domain>`
// returns null and the normal app loads. A localhost or preview host that
// resolved a shop would put a public storefront in front of a developer
// expecting the admin app, and worse, would do it on staging data.

import { RESERVED_SLUGS } from '@/lib/storefront-slug';

const APP_DOMAIN = 'kaiibi.com';
const RESERVED = new Set<string>(RESERVED_SLUGS);

export function slugFromHostname(hostname: string, appDomain: string = APP_DOMAIN): string | null {
  if (typeof hostname !== 'string') return null;
  const host = hostname.trim().toLowerCase();
  const suffix = `.${appDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;

  const label = host.slice(0, -suffix.length);
  // Exactly one label. `a.b.kaiibi.com` is not a shop; guessing which half is
  // the slug is how you serve the wrong shop's prices.
  if (!label || label.includes('.')) return null;
  if (RESERVED.has(label)) return null;
  return label;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- storefront-host
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storefront-host.ts src/lib/__tests__/storefront-host.test.ts
git commit -m "feat(storefront): resolve a shop from the hostname, failing closed"
```

---

### Task 6: Schema

**Files:**
- Create: `supabase/migrations/20260924000000_storefront.sql`
- Test: `supabase/tests/verify-storefront.sql` (created here, extended in Task 7)

**Interfaces:**
- Produces: `shops.slug`, `shops.whatsapp_e164`, `public.storefronts`, `public.storefront_delivery_areas`.

- [ ] **Step 1: Write the failing check**

Create `supabase/tests/verify-storefront.sql`:

```sql
-- The storefront schema, checked against a real database.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole lot
-- back, so it leaves no rows behind -- same shape as verify-entitlements.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_other_id uuid;
  v_raised boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sf-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Xamdi Electronics') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_user_id, 'Second Branch') returning id into v_other_id;

  -- ------------------------------------------------ 1. a shop starts with no page
  if exists (select 1 from public.storefronts where shop_id = v_shop_id) then
    raise exception 'FAIL: creating a shop created a storefront; it must be opt-in';
  end if;

  -- ------------------------------------------------ 2. slug is unique platform-wide
  update public.shops set slug = 'xamdi' where id = v_shop_id;
  v_raised := false;
  begin
    update public.shops set slug = 'xamdi' where id = v_other_id;
  exception when unique_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: two shops took the same slug';
  end if;

  -- ------------------------------------------------ 3. theme and palette are constrained
  insert into public.storefronts (shop_id) values (v_shop_id);

  if (select theme from public.storefronts where shop_id = v_shop_id) <> 'market' then
    raise exception 'FAIL: default theme is not market';
  end if;
  if (select palette from public.storefronts where shop_id = v_shop_id) <> 'ink' then
    raise exception 'FAIL: default palette is not ink';
  end if;

  v_raised := false;
  begin
    update public.storefronts set theme = 'editorial_film' where shop_id = v_shop_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown theme was accepted';
  end if;

  v_raised := false;
  begin
    update public.storefronts set payment_mode = 'online' where shop_id = v_shop_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: payment_mode online was accepted before online payment exists';
  end if;

  -- ------------------------------------------------ 4. a page starts unpublished
  if (select published_at from public.storefronts where shop_id = v_shop_id) is not null then
    raise exception 'FAIL: a new storefront was born published';
  end if;

  -- ------------------------------------------------ 5. delivery fees cannot be negative
  v_raised := false;
  begin
    insert into public.storefront_delivery_areas (shop_id, name, fee_cents, sort_order)
      values (v_shop_id, 'Ahmed Dhagah', -100, 0);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative delivery fee was accepted';
  end if;

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents, sort_order)
    values (v_shop_id, 'Ahmed Dhagah', 100, 0);
  if (select fee_cents from public.storefront_delivery_areas where shop_id = v_shop_id) <> 100 then
    raise exception 'FAIL: delivery fee did not round-trip';
  end if;

  raise notice 'PASS: storefront schema';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-storefront: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx supabase start
npm run test:db
```

Expected: FAIL — `column "slug" of relation "shops" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924000000_storefront.sql`:

```sql
-- The shop's public page.
--
-- Two tables and two columns. The reasoning worth keeping:
--
-- SLUG LIVES ON shops, NOT ON storefronts. It is an address, and an address has
-- to be reservable before there is anything at it -- a shop claims its name
-- first and writes its page afterwards. It is also unique platform-wide, which
-- is a property of the shops table and would be a lie enforced anywhere else.
--
-- A BRANCH IS A shops ROW (there is no stores table; multi_location means more
-- than one shop row under one owner). So a two-branch business gets two
-- storefronts and two subdomains, each with its own products, areas and fees.
-- That is right for delivery and right for stock.
--
-- storefronts IS SEPARATE FROM shops so the public, unauthenticated read can be
-- granted on it alone. Granting anonymous select on shops would expose every
-- shop's internals to reach four content columns.

alter table public.shops
  add column slug text unique,
  add column whatsapp_e164 text;

-- Enforced here as well as in storefront-slug.ts: the client rule is for the
-- person typing, this one is for everything else that can write a row.
alter table public.shops
  add constraint shops_slug_is_a_dns_label
  check (slug is null or slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$');

alter table public.shops
  add constraint shops_whatsapp_is_e164
  check (whatsapp_e164 is null or whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$');

create table public.storefronts (
  shop_id uuid primary key references public.shops(id) on delete cascade,

  -- Keys into the catalogues in src/lib/storefront-catalog.ts. CHECK-constrained
  -- rather than free text so a typo cannot render an unstyled page; the client
  -- falls back to the default on an unknown value, and this stops one existing.
  theme text not null default 'market' check (theme in ('market', 'counter', 'window')),
  palette text not null default 'ink' check (palette in ('ink', 'palm', 'clay', 'sea', 'saffron', 'plum')),

  headline text,
  about text,
  hero_image_url text,

  offers_delivery boolean not null default false,

  -- Only one value is permitted today. Adding 'online' later is a constraint
  -- change and a new code path, not a migration across live shops. orders will
  -- COPY this value rather than read it live, so enabling online payment never
  -- rewrites what an earlier customer agreed to.
  payment_mode text not null default 'on_collection' check (payment_mode in ('on_collection')),

  -- Null means draft. A draft page and a nonexistent shop are indistinguishable
  -- to the public, which is enforced by the read path, not by this column.
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.storefront_delivery_areas (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  -- A child table rather than JSON precisely so this is a typed column that can
  -- be checked and summed. Zero is valid: it is how a shop says "free here".
  fee_cents integer not null default 0 check (fee_cents >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);

create index storefront_delivery_areas_shop_idx
  on public.storefront_delivery_areas (shop_id, sort_order);

alter table public.storefronts enable row level security;
alter table public.storefront_delivery_areas enable row level security;

-- Members of the shop manage their own page. The anonymous READ path is granted
-- separately in 20260924000100 and is deliberately not a policy on these tables.
create policy storefronts_member_all on public.storefronts
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

create policy delivery_areas_member_all on public.storefront_delivery_areas
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- Modules gate by trigger, never by policy -- see 20260818000400 for why.
create trigger storefronts_module_gate
  before insert or update on public.storefronts
  for each row execute function public.enforce_shop_module('storefront');

create trigger delivery_areas_module_gate
  before insert or update on public.storefront_delivery_areas
  for each row execute function public.enforce_shop_module('storefront');
```

Both helpers used above already exist and are used verbatim:
`public.is_shop_member(p_shop_id uuid)` (`0018_staff_shop_access.sql:10`) and
`public.enforce_shop_module(...)` (`20260818000400_module_write_gates.sql:38`).

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run test:db
```

Expected: `verify-storefront: all checks passed, rolled back`, and every pre-existing verify script still passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924000000_storefront.sql supabase/tests/verify-storefront.sql
git commit -m "feat(storefront): schema for the shop's public page"
```

---

### Task 7: The public read, which must never leak cost

Every other table here is read by an authenticated member of one shop. This is the first anonymous read in the app, and `products.cost_cents` sits one column from `price_cents`.

**Files:**
- Create: `supabase/migrations/20260924000100_storefront_public_read.sql`
- Modify: `supabase/tests/verify-storefront.sql`

**Interfaces:**
- Produces: `public.get_public_storefront(p_slug text)` returning one row; `public.get_public_storefront_products(p_slug text)` returning a set.

- [ ] **Step 1: Write the failing checks**

In `supabase/tests/verify-storefront.sql`, insert before `raise notice 'PASS: storefront schema';`:

```sql
  -- ------------------------------------------------ 6. a draft page is invisible
  if exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: an unpublished storefront was readable';
  end if;

  update public.storefronts set published_at = now() where shop_id = v_shop_id;

  if not exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: a published storefront was not readable';
  end if;

  -- ------------------------------------------------ 7. an unknown slug is silent
  if exists (select 1 from public.get_public_storefront('no-such-shop')) then
    raise exception 'FAIL: an unknown slug returned a row';
  end if;

  -- ------------------------------------------------ 8. only listed products, never cost
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Anker 20W charger', 1200, 700, 5, true);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Trade-only cable', 500, 100, 5, false);

  if (select count(*) from public.get_public_storefront_products('xamdi')) <> 1 then
    raise exception 'FAIL: the public product list did not honour is_listed_online';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'get_public_storefront_products'
      and column_name like '%cost%'
  ) then
    raise exception 'FAIL: the public product function exposes a cost column';
  end if;

  -- The belt-and-braces version: whatever the function returns, cost must not be
  -- findable in it. A future edit that adds `select p.*` fails here.
  if exists (
    select 1
    from public.get_public_storefront_products('xamdi') pp
    where (to_jsonb(pp) ? 'cost_cents')
  ) then
    raise exception 'FAIL: cost_cents leaked into the public product payload';
  end if;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:db
```

Expected: FAIL — `function public.get_public_storefront(unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924000100_storefront_public_read.sql`:

```sql
-- The one path in this application that answers with no session at all.
--
-- Written as security definer functions with an EXPLICIT COLUMN LIST rather than
-- as an anon RLS policy on products, for one reason that outweighs the rest:
-- `products.cost_cents` sits one column from `price_cents`. A policy makes the
-- whole ROW readable and leaves the column list to whatever the client asks for,
-- so a `select *` anywhere -- ours or a future one -- publishes every shop's
-- margin. A function returns exactly the columns named here and nothing a caller
-- can widen.
--
-- A DRAFT SHOP AND A NONEXISTENT SHOP BOTH RETURN ZERO ROWS. Distinguishing them
-- would turn the subdomain into an oracle: anyone could walk names and learn
-- which shops are on kaiibi, and what they are called, before they open.

create or replace function public.get_public_storefront(p_slug text)
returns table (
  shop_name       text,
  city            text,
  slug            text,
  whatsapp_e164   text,
  theme           text,
  palette         text,
  headline        text,
  about           text,
  hero_image_url  text,
  offers_delivery boolean,
  payment_mode    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, s.city, s.slug, s.whatsapp_e164,
    f.theme, f.palette, f.headline, f.about, f.hero_image_url,
    f.offers_delivery, f.payment_mode
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- Note `stock` is exposed and `cost_cents` is not. A customer needs to know
-- whether it is there; nobody outside the shop needs to know what it cost.
create or replace function public.get_public_storefront_products(p_slug text)
returns table (
  id          uuid,
  name        text,
  description text,
  category    text,
  price_cents integer,
  stock       integer,
  image_url   text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.name, p.description, p.category, p.price_cents, p.stock, p.image_url
  from public.products p
  join public.shops s on s.id = p.shop_id
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and p.is_listed_online
    and public.shop_has_module(s.id, 'storefront')
  order by (p.stock > 0) desc, p.category nulls last, p.name;
$$;

create or replace function public.get_public_delivery_areas(p_slug text)
returns table (name text, fee_cents integer)
language sql
stable
security definer
set search_path = public
as $$
  select a.name, a.fee_cents
  from public.storefront_delivery_areas a
  join public.shops s on s.id = a.shop_id
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and f.offers_delivery
  order by a.sort_order, a.name;
$$;

grant execute on function public.get_public_storefront(text) to anon, authenticated;
grant execute on function public.get_public_storefront_products(text) to anon, authenticated;
grant execute on function public.get_public_delivery_areas(text) to anon, authenticated;
```

Note the ordering in the product function: in-stock first, then category, then name. A page whose first row is sold out reads as a shop that has nothing.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run test:db
```

Expected: `verify-storefront: all checks passed, rolled back`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924000100_storefront_public_read.sql supabase/tests/verify-storefront.sql
git commit -m "feat(storefront): public read by explicit column list, so cost cannot leak"
```

---

### Task 8: The data layer

**Files:**
- Create: `src/lib/storefront.ts`
- Modify: `src/types/models.ts`
- Test: `src/lib/__tests__/storefront.test.ts`

**Interfaces:**
- Consumes: `StorefrontTheme`, `StorefrontPalette`, `DEFAULT_THEME`, `DEFAULT_PALETTE` (Task 4).
- Produces: `getPublicStorefront(slug: string): Promise<PublicStorefront | null>`, `getPublicStorefrontProducts(slug: string): Promise<StorefrontProduct[]>`, `waLink(e164: string, message: string): string`.

- [ ] **Step 1: Add the types**

In `src/types/models.ts`, append:

```ts
export type PublicStorefront = {
  shopName: string;
  city: string | null;
  slug: string;
  whatsappE164: string | null;
  theme: string;
  palette: string;
  headline: string | null;
  about: string | null;
  heroImageUrl: string | null;
  offersDelivery: boolean;
  paymentMode: 'on_collection';
};

export type StorefrontProduct = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  priceCents: number;
  stock: number;
  imageUrl: string | null;
};
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/storefront.test.ts`:

```ts
import { waLink } from '@/lib/storefront';

describe('waLink', () => {
  it('drops the plus, because wa.me takes bare digits', () => {
    expect(waLink('+252634456789', 'hello')).toBe('https://wa.me/252634456789?text=hello');
  });

  it('encodes the message', () => {
    expect(waLink('+252634456789', 'Anker 20W charger — $12')).toBe(
      'https://wa.me/252634456789?text=Anker%2020W%20charger%20%E2%80%94%20%2412',
    );
  });

  it('handles a newline, which a multi-line order message needs', () => {
    expect(waLink('+252634456789', 'a\nb')).toBe('https://wa.me/252634456789?text=a%0Ab');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm test -- storefront.test
```

Expected: FAIL — `Cannot find module '@/lib/storefront'`.

- [ ] **Step 4: Write it**

Create `src/lib/storefront.ts`:

```ts
import { DEFAULT_PALETTE, DEFAULT_THEME } from '@/lib/storefront-catalog';
import { supabase } from '@/lib/supabase';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// Reads the public page. Every one of these calls the RPCs in
// 20260924000100 rather than querying tables: the column list lives in the
// function, so no client -- including a future one written in a hurry -- can
// widen it into products.cost_cents.

export async function getPublicStorefront(slug: string): Promise<PublicStorefront | null> {
  const { data, error } = await supabase.rpc('get_public_storefront', { p_slug: slug });
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    shopName: row.shop_name,
    city: row.city ?? null,
    slug: row.slug,
    whatsappE164: row.whatsapp_e164 ?? null,
    // An unknown key falls back rather than rendering an unstyled page. The DB
    // constrains these, so this is the second line of defence, not the first.
    theme: row.theme ?? DEFAULT_THEME,
    palette: row.palette ?? DEFAULT_PALETTE,
    headline: row.headline ?? null,
    about: row.about ?? null,
    heroImageUrl: row.hero_image_url ?? null,
    offersDelivery: Boolean(row.offers_delivery),
    paymentMode: row.payment_mode,
  };
}

export async function getPublicStorefrontProducts(slug: string): Promise<StorefrontProduct[]> {
  const { data, error } = await supabase.rpc('get_public_storefront_products', { p_slug: slug });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    category: (row.category as string) ?? null,
    priceCents: row.price_cents as number,
    stock: row.stock as number,
    imageUrl: (row.image_url as string) ?? null,
  }));
}

// wa.me takes bare digits -- a leading plus produces a chat with nobody.
export function waLink(e164: string, message: string): string {
  return `https://wa.me/${e164.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
npm test -- storefront.test
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storefront.ts src/types/models.ts src/lib/__tests__/storefront.test.ts
git commit -m "feat(storefront): public read data layer"
```

---

### Task 9: The product tile, where the no-photo case is the design

Half a real catalogue has no image. The fallback is a typographic label, not a broken-image box.

**Files:**
- Create: `src/components/storefront/product-tile.tsx`
- Test: `src/components/__tests__/storefront-product-tile.test.tsx`

**Interfaces:**
- Consumes: `PaletteColors` (Task 4), `StorefrontProduct` (Task 8).
- Produces: `<ProductTile product colors onAsk />` — `onAsk?: (p: StorefrontProduct) => void`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/storefront-product-tile.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import { ProductTile } from '@/components/storefront/product-tile';
import { paletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

const colors = paletteColors('ink');

const base: StorefrontProduct = {
  id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone',
  priceCents: 1200, stock: 5, imageUrl: null,
};

describe('ProductTile', () => {
  it('shows the name and price', () => {
    render(<ProductTile product={base} colors={colors} />);
    expect(screen.getByText('Anker 20W charger')).toBeTruthy();
    expect(screen.getByText('$12.00')).toBeTruthy();
  });

  it('names the product in the tile when there is no photo', () => {
    render(<ProductTile product={base} colors={colors} />);
    // The fallback repeats the name as a label inside the image area, so the
    // tile reads as a price label rather than a missing picture.
    expect(screen.getAllByText('Anker 20W charger').length).toBe(2);
  });

  it('does not repeat the name when there is a photo', () => {
    render(<ProductTile product={{ ...base, imageUrl: 'https://example.test/a.jpg' }} colors={colors} />);
    expect(screen.getAllByText('Anker 20W charger').length).toBe(1);
  });

  it('marks an out-of-stock product without hiding it', () => {
    render(<ProductTile product={{ ...base, stock: 0 }} colors={colors} />);
    expect(screen.getByText('Out of stock — ask us')).toBeTruthy();
  });

  it('says in stock when there is stock', () => {
    render(<ProductTile product={base} colors={colors} />);
    expect(screen.getByText('In stock')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-product-tile
```

Expected: FAIL — `Cannot find module '@/components/storefront/product-tile'`.

- [ ] **Step 3: Write it**

Create `src/components/storefront/product-tile.tsx`:

```tsx
import { Image, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

type Props = {
  product: StorefrontProduct;
  colors: PaletteColors;
};

// The no-photo branch is not an error state.
//
// products.image_url is nullable and most shops fill in a handful at best, so a
// grey box with a broken-image glyph would be the majority case and would make a
// working shop look abandoned. Setting the product name large on the soft tone
// instead gives a tile that reads like a price label -- deliberate at a glance,
// and legible on a phone, which is where nearly all of this traffic will be.
export function ProductTile({ product, colors }: Props) {
  const outOfStock = product.stock <= 0;

  return (
    <View style={[styles.tile, { borderColor: colors.soft }]}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} style={styles.image} resizeMode="cover" />
      ) : (
        <View style={[styles.image, styles.fallback, { backgroundColor: colors.soft }]}>
          <Text style={[styles.fallbackText, { color: colors.ink }]} numberOfLines={3}>
            {product.name}
          </Text>
        </View>
      )}

      <View style={styles.body}>
        <Text style={[styles.name, { color: colors.ink }]} numberOfLines={2}>
          {product.name}
        </Text>
        <Text style={[styles.price, { color: colors.ink }]}>{formatCents(product.priceCents)}</Text>
        <Text style={[styles.stock, { color: outOfStock ? '#8a5a05' : '#1f7a4d' }]}>
          {outOfStock ? 'Out of stock — ask us' : 'In stock'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: 14, overflow: 'hidden' },
  image: { aspectRatio: 1, width: '100%' },
  fallback: { justifyContent: 'flex-end', padding: 10 },
  fallbackText: { fontSize: 13, fontWeight: '800', lineHeight: 17 },
  body: { paddingHorizontal: 10, paddingTop: 9, paddingBottom: 11 },
  name: { fontSize: 12.5, fontWeight: '700', lineHeight: 16, minHeight: 32 },
  price: { fontSize: 15, fontWeight: '800', marginTop: 5 },
  stock: { fontSize: 11, fontWeight: '700', marginTop: 1 },
});
```

`formatCents` is the existing formatter (`src/lib/currency.ts:9`) and returns `"$12.00"` for `1200`. Do not add a second money formatter; `formatCompactCents` is for stat tiles and drops the cents, which is wrong on a price.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- storefront-product-tile
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/storefront/product-tile.tsx src/components/__tests__/storefront-product-tile.test.tsx
git commit -m "feat(storefront): product tile whose no-photo case is the design"
```

---

### Task 10: The three themes and the view that picks one

**Files:**
- Create: `src/components/storefront/theme-shared.tsx`, `theme-market.tsx`, `theme-counter.tsx`, `theme-window.tsx`, `storefront-view.tsx`
- Test: `src/components/__tests__/storefront-view.test.tsx`

**Interfaces:**
- Consumes: `ProductTile` (Task 9), `paletteColors`, `THEMES` (Task 4), `PublicStorefront`, `StorefrontProduct` (Task 8), `waLink` (Task 8).
- Produces: `<StorefrontView storefront products />`. Each theme takes `{ storefront, products, colors }`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/storefront-view.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import { StorefrontView } from '@/components/storefront/storefront-view';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics', city: 'Hargeisa', slug: 'xamdi',
  whatsappE164: '+252634456789', theme: 'market', palette: 'ink',
  headline: 'Everything for the house and the phone.', about: 'Open 8am–9pm.',
  heroImageUrl: null, offersDelivery: true, paymentMode: 'on_collection',
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
  { id: 'p2', name: 'LED bulb 9W', description: null, category: 'Light', priceCents: 600, stock: 0, imageUrl: null },
];

describe('StorefrontView', () => {
  it.each(['market', 'counter', 'window'])('renders every product under the %s theme', (theme) => {
    render(<StorefrontView storefront={{ ...shop, theme }} products={products} />);
    expect(screen.getByText('Xamdi Electronics')).toBeTruthy();
    expect(screen.getAllByText('Anker 20W charger').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LED bulb 9W').length).toBeGreaterThan(0);
  });

  it('falls back to Market when the stored theme is unknown', () => {
    render(<StorefrontView storefront={{ ...shop, theme: 'editorial_film' }} products={products} />);
    expect(screen.getByText('Xamdi Electronics')).toBeTruthy();
    expect(screen.getAllByText('Anker 20W charger').length).toBeGreaterThan(0);
  });

  it('offers WhatsApp when there is a number', () => {
    render(<StorefrontView storefront={shop} products={products} />);
    expect(screen.getAllByText('Message on WhatsApp').length).toBeGreaterThan(0);
  });

  it('offers no WhatsApp button when there is no number', () => {
    render(<StorefrontView storefront={{ ...shop, whatsappE164: null }} products={products} />);
    expect(screen.queryByText('Message on WhatsApp')).toBeNull();
  });

  it('shows an empty shop honestly rather than as a broken page', () => {
    render(<StorefrontView storefront={shop} products={[]} />);
    expect(screen.getByText('Nothing listed yet.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-view
```

Expected: FAIL — `Cannot find module '@/components/storefront/storefront-view'`.

- [ ] **Step 3: Write the shared parts**

Create `src/components/storefront/theme-shared.tsx`:

```tsx
import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { waLink } from '@/lib/storefront';
import { WHATSAPP_GREEN, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
};

// Returns null when the shop has no number. Publishing requires one, so this is
// the belt to that braces -- a page rendered from a row written before that rule
// existed should lose the button, not render one that opens a chat with nobody.
export function WhatsAppButton({ storefront }: { storefront: PublicStorefront }) {
  if (!storefront.whatsappE164) return null;
  const href = waLink(storefront.whatsappE164, `Hello ${storefront.shopName}, I have a question.`);
  return (
    <Pressable style={styles.wa} onPress={() => Linking.openURL(href)} accessibilityRole="link">
      <Text style={styles.waText}>Message on WhatsApp</Text>
    </Pressable>
  );
}

export function EmptyState({ colors }: { colors: PaletteColors }) {
  return <Text style={[styles.empty, { color: colors.ink }]}>Nothing listed yet.</Text>;
}

const styles = StyleSheet.create({
  // Fixed green in every palette: a recognised affordance, not a brand colour.
  wa: { backgroundColor: WHATSAPP_GREEN, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  waText: { color: '#ffffff', fontSize: 12.5, fontWeight: '800' },
  empty: { fontSize: 14, fontWeight: '700', padding: 24, textAlign: 'center' },
});
```

- [ ] **Step 4: Write Market**

Create `src/components/storefront/theme-market.tsx`:

```tsx
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { ProductTile } from '@/components/storefront/product-tile';
import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';

export function ThemeMarket({ storefront, products, colors }: ThemeProps) {
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={styles.sub}>{storefront.city}</Text> : null}
        </View>
        <WhatsAppButton storefront={storefront} />
      </View>

      {storefront.headline ? (
        <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}
      {storefront.about ? <Text style={styles.about}>{storefront.about}</Text> : null}

      {products.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        <FlatList
          data={products}
          numColumns={2}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <View style={styles.cell}>
              <ProductTile product={item} colors={colors} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12 },
  shopName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  sub: { fontSize: 11.5, color: '#6a6a72' },
  headline: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 14, paddingTop: 4 },
  about: { fontSize: 13, color: '#57575e', paddingHorizontal: 14, paddingTop: 5 },
  grid: { padding: 14, gap: 12 },
  row: { gap: 12 },
  cell: { flex: 1 },
});
```

- [ ] **Step 5: Write Counter**

Create `src/components/storefront/theme-counter.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native';

import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';
import { formatCents } from '@/lib/currency';
import type { StorefrontProduct } from '@/types/models';

// A price list, grouped by products.category -- which already exists and is
// already filled in for most shops. This is the theme that makes a 200-line
// pharmacy catalogue readable, and the one that would have been impossible if
// every theme led with photography.
function groupByCategory(products: StorefrontProduct[]): [string, StorefrontProduct[]][] {
  const groups = new Map<string, StorefrontProduct[]>();
  for (const p of products) {
    const key = p.category ?? 'Other';
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()];
}

export function ThemeCounter({ storefront, products, colors }: ThemeProps) {
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={[styles.nav, { borderBottomColor: colors.ink }]}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={styles.sub}>{storefront.city}</Text> : null}
        </View>
        <WhatsAppButton storefront={storefront} />
      </View>

      {storefront.headline ? (
        <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}

      {products.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        groupByCategory(products).map(([category, items]) => (
          <View key={category} style={styles.section}>
            <Text style={[styles.sectionHead, { color: colors.accent }]}>{category.toUpperCase()}</Text>
            {items.map((p) => (
              <View key={p.id} style={[styles.row, { borderBottomColor: colors.soft }]}>
                <View style={styles.rowName}>
                  <Text style={[styles.name, { color: colors.ink }]}>{p.name}</Text>
                  <Text style={[styles.state, { color: p.stock > 0 ? '#1f7a4d' : '#8a5a05' }]}>
                    {p.stock > 0 ? 'In stock' : 'Out of stock — ask us'}
                  </Text>
                </View>
                <Text style={[styles.price, { color: colors.ink }]}>{formatCents(p.priceCents)}</Text>
              </View>
            ))}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 2 },
  shopName: { fontSize: 18, fontWeight: '800', letterSpacing: 0.4 },
  sub: { fontSize: 11.5, color: '#6b675c' },
  headline: { fontSize: 19, fontWeight: '700', paddingHorizontal: 14, paddingTop: 12 },
  section: { paddingHorizontal: 14, paddingTop: 14 },
  sectionHead: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1 },
  rowName: { flex: 1 },
  name: { fontSize: 13.5, fontWeight: '600' },
  state: { fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  price: { fontSize: 14.5, fontWeight: '800' },
});
```

- [ ] **Step 6: Write Window**

Create `src/components/storefront/theme-window.tsx`:

```tsx
import { FlatList, Image, StyleSheet, Text, View } from 'react-native';

import { ProductTile } from '@/components/storefront/product-tile';
import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors }: ThemeProps) {
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName.toUpperCase()}</Text>
        <WhatsAppButton storefront={storefront} />
      </View>

      <View style={[styles.hero, { backgroundColor: colors.soft }]}>
        {storefront.heroImageUrl ? (
          <Image source={{ uri: storefront.heroImageUrl }} style={styles.heroImage} resizeMode="cover" />
        ) : null}
        {storefront.headline ? (
          <Text style={[styles.heroHead, { color: colors.ink }]}>{storefront.headline}</Text>
        ) : null}
        {storefront.about ? <Text style={styles.heroAbout}>{storefront.about}</Text> : null}
      </View>

      {products.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        <FlatList
          data={products}
          numColumns={2}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <View style={styles.cell}>
              <ProductTile product={item} colors={colors} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 12 },
  shopName: { fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  hero: { marginHorizontal: 16, borderRadius: 20, padding: 24, overflow: 'hidden' },
  heroImage: { ...StyleSheet.absoluteFillObject },
  heroHead: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8, lineHeight: 31 },
  heroAbout: { fontSize: 13.5, color: '#4a463d', marginTop: 9 },
  grid: { padding: 16, gap: 16 },
  row: { gap: 16 },
  cell: { flex: 1 },
});
```

- [ ] **Step 7: Write the view that picks one**

Create `src/components/storefront/storefront-view.tsx`:

```tsx
import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import {
  DEFAULT_PALETTE, DEFAULT_THEME, paletteColors,
  type StorefrontPalette, type StorefrontTheme,
} from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

const RENDERERS = {
  market: ThemeMarket,
  counter: ThemeCounter,
  window: ThemeWindow,
} as const;

// The stored theme and palette are CHECK-constrained in the database, so an
// unknown value should be impossible. Falling back anyway costs one line and is
// the difference between a page that looks slightly different from what the shop
// chose and a page that renders unstyled in front of their customers.
export function StorefrontView({
  storefront,
  products,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
}) {
  const themeKey = (storefront.theme in RENDERERS ? storefront.theme : DEFAULT_THEME) as StorefrontTheme;
  const Renderer = RENDERERS[themeKey];
  const colors = paletteColors((storefront.palette ?? DEFAULT_PALETTE) as StorefrontPalette);
  return <Renderer storefront={storefront} products={products} colors={colors} />;
}
```

- [ ] **Step 8: Run the tests and watch them pass**

```bash
npm test -- storefront-view
```

Expected: PASS, 8 tests (3 parameterised + 5).

- [ ] **Step 9: Commit**

```bash
git add src/components/storefront
git commit -m "feat(storefront): three photo-optional themes over six palettes"
```

---

### Task 11: The public route

**Files:**
- Create: `src/app/s/[slug].tsx`
- Modify: `src/app/_layout.tsx`
- Test: `src/__tests__/storefront-route.test.tsx`

**Interfaces:**
- Consumes: `slugFromHostname` (Task 5), `getPublicStorefront`, `getPublicStorefrontProducts` (Task 8), `StorefrontView` (Task 10).
- Produces: route `/s/[slug]`; a hostname redirect at app boot.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/storefront-route.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ slug: 'xamdi' }) }));
jest.mock('@/lib/storefront', () => ({
  getPublicStorefront: jest.fn(),
  getPublicStorefrontProducts: jest.fn(),
  waLink: (e: string, m: string) => `https://wa.me/${e.replace(/^\+/, '')}?text=${encodeURIComponent(m)}`,
}));

import { getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import StorefrontScreen from '@/app/s/[slug]';

const shop = {
  shopName: 'Xamdi Electronics', city: 'Hargeisa', slug: 'xamdi',
  whatsappE164: '+252634456789', theme: 'market', palette: 'ink',
  headline: 'Everything for the house and the phone.', about: null,
  heroImageUrl: null, offersDelivery: true, paymentMode: 'on_collection' as const,
};

describe('storefront route', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the shop once loaded', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValue(shop);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    render(<StorefrontScreen />);
    await waitFor(() => expect(screen.getByText('Xamdi Electronics')).toBeTruthy());
  });

  it('shows the same page for a draft shop as for one that does not exist', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValue(null);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    render(<StorefrontScreen />);
    await waitFor(() => expect(screen.getByText("There's no shop at this address.")).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- storefront-route
```

Expected: FAIL — `Cannot find module '@/app/s/[slug]'`.

- [ ] **Step 3: Write the route**

Create `src/app/s/[slug].tsx`:

```tsx
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { StorefrontView } from '@/components/storefront/storefront-view';
import { getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// A DRAFT SHOP AND A NONEXISTENT SHOP RENDER THE SAME PAGE.
//
// Not a nicety. If "not published yet" were distinguishable from "no such shop",
// the subdomain becomes an oracle: anyone could walk names and learn which shops
// are on kaiibi, and what they are called, before they have opened. One page, one
// message, no leak. The read path returns no row for either case, so this screen
// cannot tell them apart even if a future edit wanted it to.
export default function StorefrontScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'missing' } | { status: 'ready'; shop: PublicStorefront; products: StorefrontProduct[] }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const shop = await getPublicStorefront(String(slug));
        if (cancelled) return;
        if (!shop) {
          setState({ status: 'missing' });
          return;
        }
        const products = await getPublicStorefrontProducts(String(slug));
        if (!cancelled) setState({ status: 'ready', shop, products });
      } catch {
        // A failed read is indistinguishable from an unknown shop on purpose --
        // an error page would confirm the shop exists.
        if (!cancelled) setState({ status: 'missing' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.status === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  if (state.status === 'missing') {
    return (
      <View style={styles.centre}>
        <Text style={styles.mark}>KAIIBI</Text>
        <Text style={styles.title}>There&apos;s no shop at this address.</Text>
        <Text style={styles.body}>Check the spelling, or ask the shop for their link.</Text>
      </View>
    );
  }

  return <StorefrontView storefront={state.shop} products={state.products} />;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  mark: { fontSize: 12, fontWeight: '800', letterSpacing: 2, color: '#9a9aa2' },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, marginTop: 12, textAlign: 'center' },
  body: { fontSize: 13.5, color: '#5e5d65', marginTop: 6, textAlign: 'center' },
});
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm test -- storefront-route
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Send a storefront hostname to that route**

In `src/app/_layout.tsx`, inside the root component and before the existing shell renders, add:

```tsx
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { slugFromHostname } from '@/lib/storefront-host';

// Web ships as one SPA behind a catch-all rewrite, so `xamdi.kaiibi.com` and the
// app itself load the same bundle. The hostname is the only thing that tells
// them apart, and it is read once at boot. slugFromHostname fails closed, so
// localhost and preview hosts always get the app.
useEffect(() => {
  if (Platform.OS !== 'web') return;
  const slug = slugFromHostname(window.location.hostname);
  if (slug && !window.location.pathname.startsWith('/s/')) {
    router.replace(`/s/${slug}`);
  }
}, []);
```

Place it alongside the existing effects in that component, keeping the file's current import style. Do not restructure the layout.

- [ ] **Step 6: Run the whole suite**

```bash
npm test
```

Expected: PASS, with no previously-green test newly failing.

- [ ] **Step 7: Verify it in a browser, because native layout bugs do not show up in tests**

```bash
npm run web
```

Then, with a shop seeded and published in the local database, open `http://localhost:8081/s/<slug>`. Check on a phone-width viewport:

- Products appear two-up and the tiles do not overflow.
- A product with no image shows its name in the tile, not an empty box.
- An out-of-stock product is present and marked.
- **Message on WhatsApp** opens `wa.me` with the shop's number.
- Switching `storefronts.theme` and `.palette` in the database and reloading changes the page.
- An unpublished slug and a nonsense slug produce byte-identical pages.

- [ ] **Step 8: Commit**

```bash
git add src/app/s src/app/_layout.tsx src/__tests__/storefront-route.test.tsx
git commit -m "feat(storefront): serve a published shop at its own subdomain"
```

---

## Done when

- `npm test` passes.
- `npm run test:db` passes, including `verify-storefront`.
- A published shop renders at `/s/<slug>` in all three themes and six palettes.
- An unpublished shop and an unknown slug are indistinguishable.
- No public payload contains `cost_cents`, asserted by a DB test rather than by reading the code.

## What Plan 1 deliberately leaves broken

- **There is no editor.** A storefront row is created and published by SQL. Plan 2 builds the editor.
- **Nothing can be bought.** There is no cart and no `orders` table. Plan 3.
- **The wildcard DNS record is not configured.** `slugFromHostname` and the route work; pointing `*.kaiibi.com` at the Vercel project is an infrastructure step that belongs with Plan 2, when a shop can first claim a slug.
