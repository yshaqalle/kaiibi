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
