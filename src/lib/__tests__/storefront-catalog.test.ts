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
