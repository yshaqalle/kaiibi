# Promotion Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a promotion the shop already has into a poster it can print for the door and post to Facebook, Instagram, TikTok or WhatsApp status itself.

**Architecture:** Phase 2 of [`docs/superpowers/specs/2026-08-12-marketing-and-offers-design.md`](../specs/2026-08-12-marketing-and-offers-design.md). The poster is **one React component**, not an HTML string — `captureRef` rasterises it to PNG, and the PDF is that same PNG wrapped in a minimal HTML page handed to `expo-print`. One renderer, two outputs, nothing to drift. Everything on the poster comes from the promotion, the shop's receipt branding and the location, so a poster can never contradict the till.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, Supabase, Jest. `expo-print`, `expo-sharing`, `expo-file-system` already installed; `react-native-view-shot` is new.

## Global Constraints

- **Expo docs:** Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Export is native-only, and the UI must say so rather than fail.** Verified against the SDK 57 pages: `react-native-view-shot` is **Android and iOS only**, and `expo-print`'s `printToFileAsync` on web "opens the print dialog" instead of returning a file. Web shows the preview and no Save/Share buttons. A control that silently does nothing is the specific outcome to avoid.
- **Install with `npx expo install react-native-view-shot`**, never plain `npm install` — the Expo CLI pins the version matching SDK 57.
- **`PixelRatio.get()` must be divided out** when sizing a capture, or the exported image is the device's pixel ratio times too large. See the SDK 57 `captureRef` page.
- **The shop picks a colour; it never picks the text colour.** Ink is computed from the chosen colour's relative luminance. A brand yellow with white type on it is the failure this exists to prevent.
- **Never hardcode a hex in a screen.** Screen colours come from `Colors.light` in `src/constants/theme.ts`. The poster is the sole exception: it renders the *shop's* brand colour and its own computed ink, which are data, not theme tokens.
- **No dark mode.** Screens pin `Colors.light`.
- **The Marketing tab is a bento screen** — use `theme.bento*`. (People was converted; the older skill doc saying otherwise is stale.)
- **The Kaiibi mark follows the existing rule**, not a new one: `receipt_branding_removal` in `src/lib/entitlements.ts`, with the inlined asset in `src/lib/kaiibi-mark.ts`.
- **Migration ordering:** newest existing is `20260826000100`. Use `20260827000000`.
- **Tests:** `npm test` (Jest). Unit tests in `src/lib/__tests__/<name>.test.ts`. Jest pins `TZ=America/New_York`, so any date assertion must be timezone-independent.
- **Never `git add -A`** — a concurrent session may share this repository. Never push.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/contrast.ts` | Hex parsing, WCAG relative luminance, `inkFor`, `stepUntilContrast`. Pure, no React |
| `src/lib/__tests__/contrast.test.ts` | Its tests, against known WCAG pairs |
| `supabase/migrations/20260827000000_shop_brand_color.sql` | `shops.brand_color` |
| `src/lib/poster.ts` | Turns a `Promotion` + shop + location into the strings the poster renders. Pure |
| `src/lib/__tests__/poster.test.ts` | Its tests |
| `src/components/marketing/poster-canvas.tsx` | The poster itself — four templates × three shapes. Presentational only |
| `src/components/marketing/poster-export.ts` | `captureRef` → PNG, PNG → PDF, save and share |
| `src/components/marketing/poster-sheet.tsx` | The screen: pick template, colour, toggles, preview, export |
| `src/components/color-picker.tsx` | Presets, hue/depth/light sliders, hex field |
| `src/types/models.ts` | `Shop.brandColor` |
| `src/lib/shops.ts` | Maps and saves it |

---

### Task 1: Contrast — the rule that makes any colour safe

Pure functions, no React, no database. This is the phase's only real algorithm and the one thing that silently ruins a poster, so it goes first and is fully test-driven.

**Files:**
- Create: `src/lib/contrast.ts`
- Test: `src/lib/__tests__/contrast.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseHex(hex: string): { r: number; g: number; b: number } | null`
  - `relativeLuminance(rgb: { r: number; g: number; b: number }): number`
  - `contrastRatio(a: string, b: string): number`
  - `inkFor(background: string): '#ffffff' | '#141210'`
  - `stepUntilContrast(color: string, against: string, minRatio: number): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/contrast.test.ts`:

```ts
import { contrastRatio, inkFor, parseHex, relativeLuminance, stepUntilContrast } from '@/lib/contrast';

describe('parseHex', () => {
  it('reads a six-digit hex', () => {
    expect(parseHex('#5B31B5')).toEqual({ r: 91, g: 49, b: 181 });
  });

  it('reads a three-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('tolerates a missing hash and mixed case', () => {
    expect(parseHex('ffD400')).toEqual({ r: 255, g: 212, b: 0 });
  });

  it('returns null for anything that is not a colour', () => {
    expect(parseHex('not a colour')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  // The two anchors of the WCAG scale.
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#5B31B5', '#5B31B5')).toBeCloseTo(1, 5);
  });

  it('does not care which way round the pair is given', () => {
    expect(contrastRatio('#5B31B5', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#5B31B5'), 5);
  });
});

describe('inkFor', () => {
  it('puts white type on a deep ground', () => {
    expect(inkFor('#0F2B5B')).toBe('#ffffff');
    expect(inkFor('#5B31B5')).toBe('#ffffff');
  });

  it('puts black type on a bright ground — the whole reason this exists', () => {
    expect(inkFor('#FFD400')).toBe('#141210');
    expect(inkFor('#faf8f4')).toBe('#141210');
  });

  it('always returns an ink that clears 4.5:1 on its own ground', () => {
    for (const ground of ['#FFD400', '#0F2B5B', '#5B31B5', '#12A15E', '#808080', '#ffffff', '#000000']) {
      expect(contrastRatio(inkFor(ground), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('stepUntilContrast', () => {
  it('leaves a colour alone when it already clears the bar', () => {
    expect(stepUntilContrast('#FFD400', '#0b0b0d', 4.5)).toBe('#FFD400');
  });

  it('lightens a colour too dark for a dark ground until it clears', () => {
    const stepped = stepUntilContrast('#0F2B5B', '#0b0b0d', 4.5);
    expect(stepped).not.toBe('#0F2B5B');
    expect(contrastRatio(stepped, '#0b0b0d')).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a colour too light for a light ground until it clears', () => {
    const stepped = stepUntilContrast('#FFD400', '#faf8f4', 4.5);
    expect(contrastRatio(stepped, '#faf8f4')).toBeGreaterThanOrEqual(4.5);
  });

  it('gives up at black or white rather than looping forever', () => {
    // 21:1 is the theoretical maximum, so nothing can clear a higher bar.
    const stepped = stepUntilContrast('#808080', '#808080', 21);
    expect(['#ffffff', '#000000']).toContain(stepped.toLowerCase());
  });

  it('returns the input unchanged when it is not a colour', () => {
    expect(stepUntilContrast('nonsense', '#000000', 4.5)).toBe('nonsense');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx jest src/lib/__tests__/contrast.test.ts`
Expected: FAIL — `Cannot find module '@/lib/contrast'`.

- [ ] **Step 3: Implement**

Create `src/lib/contrast.ts`:

```ts
// Whether type can be read on a colour, decided rather than hoped.
//
// A shop picks its own brand colour for a poster, and the poster puts words on
// it. Left free, a bright brand yellow gets white type on a sheet meant to be
// read from across a street. So the shop chooses the GROUND and this file
// chooses the INK -- the same split theme.ts already makes when it solves its
// own steps against a known surface.
//
// The maths is WCAG 2.1's relative luminance and contrast ratio, which is the
// standard the rest of this codebase's colour comments reference.

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null;
  const raw = hex.trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

// WCAG 2.1 relative luminance: each channel is linearised before weighting,
// which is why this is not simply (r+g+b)/3. Yellow and blue of the same
// arithmetic mean are nowhere near the same brightness to an eye.
export function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Near-black rather than pure black: on a bright ground pure black is harsh at
// poster scale, and #141210 is the same warm near-black the Quiet template
// uses for its paper.
const DARK_INK = '#141210';
const LIGHT_INK = '#ffffff';

export function inkFor(background: string): typeof LIGHT_INK | typeof DARK_INK {
  return contrastRatio(LIGHT_INK, background) >= contrastRatio(DARK_INK, background) ? LIGHT_INK : DARK_INK;
}

// Walks a colour toward white or black until it clears `minRatio` against the
// ground it has to sit on. Used for the ACCENT role, where the shop's colour is
// type rather than ground -- a deep navy accent vanishes on the Bold template's
// near-black, and refusing the shop's colour outright would be worse than
// nudging it.
export function stepUntilContrast(color: string, against: string, minRatio: number): string {
  const rgb = parseHex(color);
  const ground = parseHex(against);
  if (!rgb || !ground) return color;
  if (contrastRatio(color, against) >= minRatio) return color;

  // Move away from the ground: lighten on a dark ground, darken on a light one.
  const towardWhite = relativeLuminance(ground) < 0.5;
  let current = { ...rgb };
  // 24 steps of ~4% covers the full range; the loop is bounded so an
  // unreachable ratio (nothing clears 21:1 but pure black or white) ends at the
  // extreme rather than spinning.
  for (let i = 0; i < 24; i++) {
    current = towardWhite
      ? { r: current.r + (255 - current.r) * 0.12, g: current.g + (255 - current.g) * 0.12, b: current.b + (255 - current.b) * 0.12 }
      : { r: current.r * 0.88, g: current.g * 0.88, b: current.b * 0.88 };
    const candidate = toHex(current);
    if (contrastRatio(candidate, against) >= minRatio) return candidate;
  }
  return towardWhite ? LIGHT_INK : '#000000';
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest src/lib/__tests__/contrast.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Confirm nothing else broke**

Run: `npx tsc --noEmit` → no errors.
Run: `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/contrast.ts src/lib/__tests__/contrast.test.ts
git commit -m "feat(contrast): the shop picks the colour, we pick the ink"
```

---

### Task 2: The shop's colour

**Files:**
- Create: `supabase/migrations/20260827000000_shop_brand_color.sql`
- Modify: `src/types/models.ts` (the `Shop` type), `src/lib/shops.ts` (mapper + update)

**Interfaces:**
- Consumes: nothing.
- Produces: `Shop.brandColor: string | null`, readable and writable through the existing `updateShop`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260827000000_shop_brand_color.sql`:

```sql
-- The shop's own colour, for the things it shows the world.
--
-- Shops carry a logo (shops.logo_url) and nothing else about how they look, so
-- every poster would otherwise open on the same purple and an owner would
-- re-pick their own brand every time they ran a sale. On the shop rather than
-- on each poster for exactly that reason.
--
-- Null means "we have not been told", which the poster reads as its template
-- default -- not as black. A shop that never opens Settings still gets a
-- poster that looks deliberate.
--
-- Text on it is NOT stored: it is computed from this colour's luminance (see
-- src/lib/contrast.ts). Storing both would let them drift into an unreadable
-- pair that nothing would catch until it was printed and on a door.
alter table public.shops add column brand_color text;

alter table public.shops
  add constraint shops_brand_color_is_hex
    check (brand_color is null or brand_color ~* '^#[0-9a-f]{6}$');
```

- [ ] **Step 2: Apply it locally and verify the constraint**

**Never run `npx supabase db push`** — this repo is linked to a live project. Apply locally only:

Run: `npx supabase migration up --local`
Expected: applies with no error.

Then check the constraint actually refuses junk:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "do \$\$ begin
     begin
       update public.shops set brand_color = 'purple';
       raise notice 'FAIL: a non-hex colour was accepted';
     exception when check_violation then raise notice 'PASS: non-hex refused';
     end;
   end \$\$;"
```

Expected: `PASS: non-hex refused`. (If the local database has no shops the update touches nothing and raises nothing — seed one first, or accept that the constraint is verified by the schema itself.)

- [ ] **Step 3: Add it to the model**

In `src/types/models.ts`, inside the `Shop` type immediately after `logoUrl`:

```ts
  // The shop's own colour, used by the poster (src/components/marketing/
  // poster-canvas.tsx). Null means "never set" -- the poster falls back to its
  // template's own colour rather than to black. The text colour that goes on it
  // is computed, never stored: see src/lib/contrast.ts.
  brandColor: string | null;
```

- [ ] **Step 4: Map and save it**

In `src/lib/shops.ts`, find the row mapper and add, beside the `logoUrl` line:

```ts
    brandColor: row.brand_color ?? null,
```

Then find `updateShop`'s payload construction and add the same conditional-spread shape the neighbouring fields use:

```ts
    ...(input.brandColor !== undefined && { brand_color: input.brandColor }),
```

Read the function first and match its existing style exactly — if it takes a `Partial<Shop>`-shaped input, the key is `brandColor`; if it takes snake_case, follow that.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. If a test fixture constructs a whole `Shop`, it will need `brandColor: null` — add it; that is a required consequence of widening the type, not scope creep.

Run: `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260827000000_shop_brand_color.sql src/types/models.ts src/lib/shops.ts
git commit -m "feat(shops): a shop gets a colour, and only a colour"
```

---

### Task 3: What the poster says

Pure data shaping — no React. Everything the poster prints comes from records that already exist, so a poster can never claim a discount the till will not give.

**Files:**
- Create: `src/lib/poster.ts`
- Test: `src/lib/__tests__/poster.test.ts`

**Interfaces:**
- Consumes: `Promotion` (with `startsAt`/`endsAt`/`autoApply`/`archivedAt`), `instantToEndDateInput` from `src/lib/promotion-dates.ts`.
- Produces:
  - `type PosterCopy = { headline: string | null; value: string; scope: string; when: string | null; shopName: string; branch: string | null; address: string | null; hours: string | null; phone: string | null }`
  - `posterCopyFor(input: PosterCopyInput): PosterCopy`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/poster.test.ts`:

```ts
import { posterCopyFor } from '@/lib/poster';
import type { Promotion } from '@/types/models';

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'p1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

const BASE = { shopName: 'Suuqa Xamar', branch: null, address: null, hours: null, phone: null, headline: null };

describe('posterCopyFor', () => {
  it('prints a percentage as a percentage', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).value).toBe('20%');
  });

  it('prints a fixed discount as money', () => {
    const promo = makePromotion({ discountType: 'fixed', discountValue: 250 });
    expect(posterCopyFor({ ...BASE, promotion: promo }).value).toBe('$2.50');
  });

  it('says what a store-wide offer applies to', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).scope).toBe('Everything in store');
  });

  it('names the category a category offer applies to', () => {
    const promo = makePromotion({ scope: 'category', scopeValue: 'Shoes' });
    expect(posterCopyFor({ ...BASE, promotion: promo }).scope).toBe('All Shoes');
  });

  it('names the brand a brand offer applies to', () => {
    const promo = makePromotion({ scope: 'brand', scopeValue: 'Somtel' });
    expect(posterCopyFor({ ...BASE, promotion: promo }).scope).toBe('Anything by Somtel');
  });

  it('prints no date line at all when the offer has no window', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).when).toBeNull();
  });

  it('prints an end-only window as "until" the inclusive last day', () => {
    // Stored exclusive (the instant it stops), shown inclusive -- see
    // src/lib/promotion-dates.ts. An offer stored as ending at midnight on the
    // 17th ran through the 16th, and that is what a customer must read.
    const promo = makePromotion({ endsAt: new Date(2026, 7, 17).toISOString() });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Until Sunday 16 August');
  });

  it('prints a closed window as a range', () => {
    const promo = makePromotion({
      startsAt: new Date(2026, 7, 14).toISOString(),
      endsAt: new Date(2026, 7, 17).toISOString(),
    });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Friday 14 — Sunday 16 August');
  });

  it('prints a start-only window as "from"', () => {
    const promo = makePromotion({ startsAt: new Date(2026, 7, 14).toISOString() });
    expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('From Friday 14 August');
  });

  it('carries the shop and branch details through untouched', () => {
    const copy = posterCopyFor({
      ...BASE, promotion: makePromotion(), branch: 'Xamar branch',
      address: 'Sooq Bakaaro', hours: '08:00 – 21:00', phone: '063 442 1180',
    });
    expect(copy.shopName).toBe('Suuqa Xamar');
    expect(copy.branch).toBe('Xamar branch');
    expect(copy.address).toBe('Sooq Bakaaro');
    expect(copy.hours).toBe('08:00 – 21:00');
    expect(copy.phone).toBe('063 442 1180');
  });

  it('keeps a headline the owner wrote, and trims it', () => {
    const copy = posterCopyFor({ ...BASE, promotion: makePromotion(), headline: '  Ciid wanaagsan  ' });
    expect(copy.headline).toBe('Ciid wanaagsan');
  });

  it('treats a blank headline as none', () => {
    expect(posterCopyFor({ ...BASE, promotion: makePromotion(), headline: '   ' }).headline).toBeNull();
  });
});
```

Note the date tests build instants with `new Date(year, monthIndex, day)` — local midnight, matching how `promotion-dates.ts` writes them — so they pass under Jest's pinned `TZ=America/New_York` and anywhere else.

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/lib/__tests__/poster.test.ts`
Expected: FAIL — `Cannot find module '@/lib/poster'`.

- [ ] **Step 3: Implement**

Create `src/lib/poster.ts`:

```ts
import { formatCents } from '@/lib/currency';
import { instantToEndDateInput, instantToStartDateInput } from '@/lib/promotion-dates';
import type { Promotion } from '@/types/models';

// Every word a poster prints, derived from records that already exist.
//
// The point of generating this rather than asking the owner to type it is that
// a poster then cannot contradict the till: if the offer says 20% and runs
// through Saturday, so does the paper on the door. The single free-text field
// is the headline, because "Ciid wanaagsan" is not derivable from a discount
// row.
export type PosterCopy = {
  headline: string | null;
  value: string;
  scope: string;
  when: string | null;
  shopName: string;
  branch: string | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
};

export type PosterCopyInput = {
  promotion: Promotion;
  shopName: string;
  headline?: string | null;
  branch?: string | null;
  address?: string | null;
  hours?: string | null;
  phone?: string | null;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// 'YYYY-MM-DD' -> "Saturday 16 August". Built from the parts rather than
// toLocaleDateString: the poster's wording has to be identical on every device
// regardless of the phone's locale, because the shop is printing one sheet.
function longDate(dateInput: string): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const at = new Date(year, month - 1, day);
  return `${DAYS[at.getDay()]} ${day} ${MONTHS[month - 1]}`;
}

// Same, minus the month -- for the left half of a range that ends in the same
// month, so "Friday 14 — Sunday 16 August" rather than saying August twice.
function shortDate(dateInput: string): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const at = new Date(year, month - 1, day);
  return `${DAYS[at.getDay()]} ${day}`;
}

function windowLine(promotion: Promotion): string | null {
  const from = promotion.startsAt ? instantToStartDateInput(promotion.startsAt) : null;
  // Stored exclusive, printed inclusive: an offer stored as ending at midnight
  // on the 17th ran through the whole of the 16th, and the 16th is what a
  // customer standing in front of the sheet needs to read.
  const to = promotion.endsAt ? instantToEndDateInput(promotion.endsAt) : null;

  if (!from && !to) return null;
  if (from && !to) return `From ${longDate(from)}`;
  if (!from && to) return `Until ${longDate(to)}`;

  const sameMonth = from!.slice(0, 7) === to!.slice(0, 7);
  return `${sameMonth ? shortDate(from!) : longDate(from!)} — ${longDate(to!)}`;
}

function scopeLine(promotion: Promotion): string {
  if (promotion.scope === 'category' && promotion.scopeValue) return `All ${promotion.scopeValue}`;
  if (promotion.scope === 'brand' && promotion.scopeValue) return `Anything by ${promotion.scopeValue}`;
  return 'Everything in store';
}

export function posterCopyFor(input: PosterCopyInput): PosterCopy {
  const { promotion } = input;
  const headline = input.headline?.trim();
  return {
    headline: headline ? headline : null,
    value: promotion.discountType === 'percentage' ? `${promotion.discountValue}%` : formatCents(promotion.discountValue),
    scope: scopeLine(promotion),
    when: windowLine(promotion),
    shopName: input.shopName,
    branch: input.branch ?? null,
    address: input.address ?? null,
    hours: input.hours ?? null,
    phone: input.phone ?? null,
  };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx jest src/lib/__tests__/poster.test.ts`
Expected: PASS — 13 tests.

If `formatCents` renders differently from `$2.50` (check `src/lib/currency.ts` — it may take a currency argument), adjust the **test** to the real output rather than wrapping the helper. The rule is that money on a poster looks exactly like money everywhere else in this app.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/lib/poster.ts src/lib/__tests__/poster.test.ts
git commit -m "feat(poster): every word on the sheet comes from the offer"
```

---

### Task 4: The poster itself

One presentational component. No data loading, no export logic — it takes copy and colours and draws. Keeping it pure is what lets Task 5 rasterise it without a screenshot of the whole screen.

**Files:**
- Create: `src/components/marketing/poster-canvas.tsx`

**Interfaces:**
- Consumes: `PosterCopy` from Task 3; `inkFor`, `stepUntilContrast` from Task 1; `KAIIBI_MARK_DATA_URI` from `src/lib/kaiibi-mark.ts`.
- Produces:
  - `type PosterTemplate = 'bold' | 'market' | 'quiet' | 'week'`
  - `type PosterShape = 'square' | 'story' | 'sheet'`
  - `POSTER_SHAPES: Record<PosterShape, { ratio: number; label: string }>` — `square` 1, `story` 9/16, `sheet` 1/1.414
  - `<PosterCanvas copy width shape template color showMark weekOffers? />`

- [ ] **Step 1: Build the component**

Create `src/components/marketing/poster-canvas.tsx`. It must satisfy all of the following, which are the review criteria:

1. **Sizes derive from `width`, never from the screen.** Every font size, padding and radius is a fraction of the `width` prop, so the same component renders identically at 300px on screen and at 1240px for an export. A `StyleSheet` with fixed pixel sizes cannot do this — compute the style objects inline from `width`.
2. **Four templates**, differing in ground, ink and emphasis:
   - `bold` — near-black ground (`#0b0b0d`), the discount value is the poster, accent is the shop colour stepped to clear 4.5:1 against that ground via `stepUntilContrast(color, '#0b0b0d', 4.5)`.
   - `market` — the shop colour IS the ground; ink is `inkFor(color)`; accent is the ink at reduced opacity.
   - `quiet` — paper ground (`#faf8f4`), near-black ink, hairline rules above and below the middle block, lighter weights.
   - `week` — white ground, a list of offers rather than one number. Takes `weekOffers: { value: string; scope: string; when: string | null }[]`.
3. **Three shapes** via `POSTER_SHAPES[shape].ratio`, applied as `aspectRatio`. The story shape gets more vertical air around the value; the sheet gets a larger address block. These are three layouts, not one scaled.
4. **Nothing optional prints when absent.** `copy.when === null` renders no date line — not an empty `<Text>` that leaves a gap. Same for branch, address, hours, phone, headline.
5. **The Kaiibi mark** renders only when `showMark` is true, as `<Image source={{ uri: KAIIBI_MARK_DATA_URI }} />` plus the words "Made with Kaiibi".
6. **No hardcoded hex outside this file's template definitions.** The template grounds above are the poster's own design, not theme tokens — that is the documented exception. Everything else comes from `color` and the computed ink.
7. **Long values must not clip.** `numberOfLines` plus `adjustsFontSizeToFit` on the value and scope lines, so `$1,250.00` and `5%` both fit.

- [ ] **Step 2: Prove it renders at every combination**

There is no snapshot infrastructure for this and adding one would test the framework rather than the poster. Instead verify by eye in Task 6's screen, and assert the one thing that is genuinely computable — that the component exports the shapes the rest of the code expects:

Create `src/components/marketing/__tests__/poster-canvas.test.ts`:

```ts
import { POSTER_SHAPES } from '@/components/marketing/poster-canvas';

describe('POSTER_SHAPES', () => {
  it('offers a square, a story and a sheet', () => {
    expect(Object.keys(POSTER_SHAPES).sort()).toEqual(['sheet', 'square', 'story']);
  });

  it('uses the real aspect ratios, so an export is not a squashed square', () => {
    expect(POSTER_SHAPES.square.ratio).toBeCloseTo(1, 5);
    expect(POSTER_SHAPES.story.ratio).toBeCloseTo(9 / 16, 5);
    expect(POSTER_SHAPES.sheet.ratio).toBeCloseTo(1 / 1.414, 3);
  });
});
```

- [ ] **Step 3: Verify and commit**

Run: `npx jest src/components/marketing/__tests__/poster-canvas.test.ts` → PASS.
Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/components/marketing/poster-canvas.tsx src/components/marketing/__tests__/poster-canvas.test.ts
git commit -m "feat(poster): four templates, three shapes, one component"
```

---

### Task 5: Getting it off the phone

**Files:**
- Create: `src/components/marketing/poster-export.ts`
- Modify: `package.json` (via `npx expo install`)

**Interfaces:**
- Consumes: a `ref` to the rendered `PosterCanvas`.
- Produces:
  - `POSTER_EXPORT_SUPPORTED: boolean` — false on web
  - `capturePosterPng(ref, shape, targetWidthPx): Promise<string>` — resolves to a file URI; height follows the shape's ratio
  - `posterPdfFromPng(pngUri, shape): Promise<string>` — resolves to a PDF file URI
  - `sharePoster(uri, mimeType): Promise<void>`

- [ ] **Step 1: Install the dependency**

Run: `npx expo install react-native-view-shot`

**Not `npm install`** — the Expo CLI resolves the version that matches SDK 57. Confirm `package.json` gained it, and that no other dependency version moved.

- [ ] **Step 2: Read the docs before writing against them**

Read https://docs.expo.dev/versions/v57.0.0/sdk/captureRef/ and https://docs.expo.dev/versions/v57.0.0/sdk/print/ . Two things from those pages drive the code below: `captureRef` needs `PixelRatio` divided out to hit a target pixel size, and `printToFileAsync` takes `width`/`height` in points at 72 PPI.

- [ ] **Step 3: Implement**

Create `src/components/marketing/poster-export.ts`:

```ts
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { PixelRatio, Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { POSTER_SHAPES, type PosterShape } from '@/components/marketing/poster-canvas';

// react-native-view-shot is Android and iOS only, and expo-print's
// printToFileAsync on web opens the print dialog rather than returning a file.
// So saving a poster is something the app does on a phone. The screen reads
// this and offers Print alone in a browser, rather than a Save button that
// quietly does nothing -- which is the failure this constant exists to prevent.
export const POSTER_EXPORT_SUPPORTED = Platform.OS !== 'web';

// A4 at 72 PPI, which is the unit printToFileAsync works in.
const A4_POINTS = { width: 595, height: 842 };

// captureRef sizes in LOGICAL pixels, so a target of 1080 physical pixels on a
// 3x device is 360 logical. Skipping this is how an export comes out three
// times the intended size (and several megabytes) on one phone and correct on
// another.
export async function capturePosterPng(
  ref: React.RefObject<unknown>,
  shape: PosterShape,
  targetWidthPx: number
): Promise<string> {
  const density = PixelRatio.get();
  // Height follows the shape, not the width. A square target on a 9:16 story
  // would capture a squashed poster -- and it would look fine in the preview,
  // because only the export is wrong.
  const targetHeightPx = Math.round(targetWidthPx / POSTER_SHAPES[shape].ratio);
  return captureRef(ref as never, {
    result: 'tmpfile',
    format: 'png',
    quality: 1,
    width: targetWidthPx / density,
    height: targetHeightPx / density,
  });
}

// The PDF is the captured image on a page, not a second rendering of the
// poster. One renderer means the sheet on the door and the square in the feed
// cannot drift apart -- and expo-print cannot lay out a React tree anyway.
export async function posterPdfFromPng(pngUri: string, shape: PosterShape): Promise<string> {
  const ratio = POSTER_SHAPES[shape].ratio;
  const page = shape === 'sheet'
    ? A4_POINTS
    : { width: A4_POINTS.width, height: Math.round(A4_POINTS.width / ratio) };

  // Margin-free and edge-to-edge: a poster is the whole page. The @page rule is
  // what Android's WebView honours; iOS takes the margins option, and both are
  // set so neither platform adds a white border of its own.
  const html = `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
  <style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; }
  </style>
  <body><img src="${pngUri}" /></body>
</html>`;

  const { uri } = await Print.printToFileAsync({
    html,
    width: page.width,
    height: page.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  return uri;
}

export async function sharePoster(uri: string, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) return;
  await Sharing.shareAsync(uri, { mimeType, UTI: mimeType === 'application/pdf' ? '.pdf' : '.png' });
}
```

Note the `img src` uses the captured file URI directly. If the PDF comes out blank on a device, the cause is that the platform's print WebView cannot read a `file://` URI — in that case capture with `result: 'base64'` instead and inline it as `data:image/png;base64,...`. Verify which is needed in Step 5 rather than guessing now.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS (no new tests; this module is entirely native I/O and is verified on a device in Step 5).

- [ ] **Step 5: Verify on a device — this step is the test**

This module cannot be unit-tested meaningfully: every line is a native call. It must be exercised on a real platform once Task 6's screen exists. Defer this step's verification until then, and record in the report that it is pending. When you run it, confirm: a saved PNG opens and is the expected pixel size, a saved PDF opens and has no white border, and the share sheet appears.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/marketing/poster-export.ts
git commit -m "feat(poster): one rendering, a PNG for the feed and a PDF for the door"
```

---

### Task 6: The screen

**Files:**
- Create: `src/components/marketing/poster-sheet.tsx`, `src/components/color-picker.tsx`
- Modify: `src/components/marketing/promotions-tab.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: a poster sheet opened from a promotion row.

- [ ] **Step 1: Build the colour picker**

Create `src/components/color-picker.tsx`: six preset swatches, a hex text field, and three sliders (hue, saturation, lightness) built from plain `View`s and `PanResponder` — no new dependency, and easier to hit on a counter tablet than a wheel. On web, additionally render `<input type="color">` via `Platform.OS === 'web'`.

It reports through `onChange(hex: string)` and shows the resulting ink beside the swatch (`inkFor(color)`) with its contrast ratio, so the owner sees the consequence of their choice rather than discovering it in print.

- [ ] **Step 2: Build the sheet**

Create `src/components/marketing/poster-sheet.tsx`. It takes a `Promotion` and renders:

- a live `PosterCanvas` preview at the selected template/shape/colour
- template picker (Bold / Market / Quiet / This week)
- shape picker (Square / Story / Sheet)
- the colour picker, seeded from `shop.brandColor`, saving back through `updateShop` so the choice sticks
- a short headline field, capped at 28 characters
- toggles for dates, branch and address, hours, phone — each defaulting on, each hidden from the poster when off
- **when `POSTER_EXPORT_SUPPORTED`**: Save image, Save sheet (PDF), Share
- **when not** (web): the preview, and one line of copy saying saving and sharing happen in the app on a phone. No disabled buttons.

The Kaiibi mark toggle is shown only when the shop's plan grants `receipt_branding_removal`; otherwise the mark is on and the toggle is absent — matching how receipts already treat it.

For the `week` template, load every promotion that is currently live (`isPromotionLive` from `src/lib/discounts.ts`) and pass them as `weekOffers`.

- [ ] **Step 3: Open it from a promotion**

In `src/components/marketing/promotions-tab.tsx`, add a **Poster** action to the selected promotion's detail pane, opening the sheet for that promotion. Match the existing action styling in that file exactly.

- [ ] **Step 4: Verify on device — required**

Run the app and confirm with screenshots:

1. Every template at every shape renders with no clipped text, tested with **both** a `5%` promotion and a `$1,250.00` one.
2. A promotion with no window prints no date line and leaves no gap where it would have been.
3. Picking a bright yellow flips the type to black; picking a navy flips it to white.
4. Saved PNG and PDF open correctly, and the PDF has no white border.
5. On web, no Save or Share button appears — and the explanation does.

Use the project's `/testing-kaiibi` skill.

- [ ] **Step 5: Commit**

```bash
git add src/components/color-picker.tsx src/components/marketing/poster-sheet.tsx src/components/marketing/promotions-tab.tsx
git commit -m "feat(marketing): a promotion becomes a poster"
```

---

## Definition of done

- [ ] Any colour a shop picks produces readable type, verified by `contrast.ts`'s tests and by eye on a bright yellow.
- [ ] Every template renders at all three shapes without clipping at `5%` and at `$1,250.00`.
- [ ] A promotion with no window prints no date line.
- [ ] An end date prints the inclusive last day the offer runs, not the stored exclusive instant.
- [ ] PNG and PDF both save and share on a phone; the browser offers neither and says why.
- [ ] A shop on a branding-removal plan gets no Kaiibi mark; every other shop does.
- [ ] The brand colour persists on the shop and seeds the next poster.

## Out of scope

Posting to any network on the shop's behalf · product photography on the poster · scheduling a post · image export on web · per-poster colour (it lives on the shop).

**Somali template copy is deliberately deferred**, and this is a departure from the spec, which promised "Somali, English, or both stacked". The headline field already accepts Somali, so a shop can put "Ciid wanaagsan" on the sheet today. What is not being built is translated *template* copy — "Everything in store", "Until Sunday 16 August" — because a fixed phrase per language has to be checked by someone who speaks it, and a poster is the worst place to discover a clumsy translation. It wants a native speaker's review, not a guess, and that is a separate small task once someone can read it.
