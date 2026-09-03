import { contrastRatio } from '@/lib/contrast';
import {
  THEMES, PALETTES, DEFAULT_THEME, DEFAULT_PALETTE,
  paletteColors, mutedInk, WHATSAPP_BUTTON_GREEN,
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

describe('muted secondary text', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s keeps muted text readable on its ground', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.muted, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s makes muted text quieter than full ink', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.muted, c.ground)).toBeLessThan(contrastRatio(c.ink, c.ground));
  });
});

// The mirror of the block above, for the shop card -- the one surface on this
// page filled with `ink` instead of `ground`. Asserted in its own right rather
// than assumed to inherit `muted`'s headroom: ground and ink are not
// equidistant from the midpoint on any palette, so running the same blend the
// other way does NOT land on the same ratio.
describe('muted secondary text on the shop card', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s keeps onDarkMuted readable on its ink fill', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.onDarkMuted, c.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s makes onDarkMuted quieter than full ground on that fill', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.onDarkMuted, c.ink)).toBeLessThan(contrastRatio(c.ground, c.ink));
  });

  // The failure this guards is not a ratio at all: reaching for `muted` on the
  // shop card compiles, renders, and is illegible -- it is ink blended toward
  // ground, so on an ink fill it is very nearly the fill itself.
  it.each(keys)('%s would fail if muted were used on the shop card instead', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.muted, c.ink)).toBeLessThan(4.5);
  });
});

describe('danger text (form errors)', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s keeps danger text readable on its ground', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.danger, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s gives danger text a colour distinct from the out-of-stock amber', (key) => {
    const c = paletteColors(key);
    expect(c.danger.toLowerCase()).not.toBe('#8a5a05');
  });
});

// The out-of-stock colour used to be the literal '#8a5a05', typed straight
// into product-tile.tsx and theme-counter.tsx and identical on all six
// palettes. On SAFFRON that literal IS the palette's own accent, byte for
// byte -- so "Out of stock" rendered in the colour of the Add button and the
// section rule, and the notice read as an action. The `danger` suite above
// already guards against colliding with this amber; the guard went on danger
// and never on the amber itself.
//
// Now derived per palette, the same way muted and danger are. The pill it
// paints sits on `soft` (not `ground`), so it is stepped against soft -- the
// surface it is actually on. Ground is lighter than soft in every palette, so
// clearing 4.5:1 on soft clears it on ground too.
describe('out-of-stock text', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s keeps out-of-stock readable on the pill it sits on', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.stockOut, c.soft)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(keys)('%s keeps it readable on the page ground too', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.stockOut, c.ground)).toBeGreaterThanOrEqual(4.5);
  });

  // The Saffron collision, pinned so it cannot come back.
  it.each(keys)('%s does not paint out-of-stock in its own accent', (key) => {
    const c = paletteColors(key);
    expect(c.stockOut.toLowerCase()).not.toBe(c.accent.toLowerCase());
  });

  // Saffron by name as well as by rule -- it is the palette the rule exists
  // for, and a future change to the anchor should fail loudly here.
  it('saffron no longer renders out-of-stock as its accent', () => {
    const c = paletteColors('saffron');
    expect(c.accent).toBe('#8a5a05');
    expect(c.stockOut).not.toBe('#8a5a05');
  });

  // An error and a stock notice must not look like the same signal -- the
  // rule storefront-catalog.ts states on dangerInk, asserted from both ends.
  it.each(keys)('%s keeps out-of-stock distinct from the error colour', (key) => {
    const c = paletteColors(key);
    expect(c.stockOut.toLowerCase()).not.toBe(c.danger.toLowerCase());
  });
});

// There is deliberately NO `stockOk`. In-stock is the state nearly every
// product is in, so a colour on it would be spent where it carries no
// information -- and the green it would have been derived from lands within
// ~4% of WHATSAPP_BUTTON_GREEN on every palette, which would put a passive
// status label in the colour of a tappable affordance. In-stock is set in
// `ink` instead: the words stay, the colour goes. See product-tile.tsx.
describe('in-stock carries no colour of its own', () => {
  it('the palette offers no stockOk token to reach for', () => {
    const c = paletteColors('ink') as Record<string, unknown>;
    expect(c.stockOk).toBeUndefined();
  });
});

describe('WhatsApp green', () => {
  it('is fixed, because it is a recognised affordance and not a brand colour', () => {
    expect(WHATSAPP_BUTTON_GREEN).toBe('#1f7a4d');
    expect(contrastRatio(WHATSAPP_BUTTON_GREEN, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('is in no palette, so no shop can recolour it by picking one', () => {
    for (const p of PALETTES) {
      const c = paletteColors(p.key);
      expect(c.ground).not.toBe(WHATSAPP_BUTTON_GREEN);
      expect(c.soft).not.toBe(WHATSAPP_BUTTON_GREEN);
      expect(c.ink).not.toBe(WHATSAPP_BUTTON_GREEN);
      expect(c.accent).not.toBe(WHATSAPP_BUTTON_GREEN);
    }
  });
});

// paletteColors and mutedInk both look up an untrusted string key in COLORS, a
// plain object. `COLORS['constructor']` resolves through the prototype chain
// to Object's constructor -- a function, which is truthy -- so a `?`/`??`
// check that only asks "is this falsy" treats 'constructor' as a hit rather
// than an unknown key, and spreads a function into the palette instead of
// falling back to DEFAULT_PALETTE. Same hole StorefrontView was already fixed
// for (Object.prototype.hasOwnProperty.call(RENDERERS, ...)); this asserts the
// other half, at the two functions that actually own the palette fallback.
describe('palette lookup does not fall through the prototype chain', () => {
  const poisoned = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'not-a-real-palette'];

  it.each(poisoned)('paletteColors(%s) falls back to the ink palette', (bad) => {
    const c = paletteColors(bad as StorefrontPalette);
    expect(c).toEqual(paletteColors('ink'));
    expect(c.ground).toBe('#ffffff');
    expect(c.soft).toBe('#f4f4f5');
    expect(c.ink).toBe('#141418');
    expect(c.accent).toBe('#141418');
    expect(typeof c.muted).toBe('string');
    expect(typeof c.danger).toBe('string');
  });

  it.each(poisoned)('mutedInk(%s) falls back to the ink palette blend', (bad) => {
    expect(mutedInk(bad as StorefrontPalette)).toBe(mutedInk('ink'));
  });
});
