import { contrastRatio } from '@/lib/contrast';
import {
  THEMES, PALETTES, DEFAULT_THEME, DEFAULT_PALETTE,
  paletteColors, mutedInk, WHATSAPP_BUTTON_GREEN, CHECKOUT_BLUE, CHECKOUT_INK,
  KAIIBI_BLUE, KAIIBI_INK,
  type StorefrontPalette,
} from '@/lib/storefront-catalog';

describe('catalogue shape', () => {
  it('ships three themes and seven palettes', () => {
    expect(THEMES.map((t) => t.key)).toEqual(['market', 'counter', 'window']);
    expect(PALETTES.map((p) => p.key)).toEqual(['ink', 'palm', 'clay', 'sea', 'saffron', 'plum', 'azure']);
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

// TWO TOKENS FOR LINES, BECAUSE A RULE AND A CONTROL EDGE ARE NOT THE SAME JOB.
//
// Both used to be `soft`, and on the ink palette soft-on-ground is 1.04:1 --
// so a card's row rules were invisible, and so was the border on the search
// field. The field was the worse half: bento's own principle is that the page
// tone is the separation, which is true of a CARD (a large filled shape read by
// its mass) and false of a text input, whose fill is 3% from the page and whose
// only remaining cue that it can be typed in is its boundary.
//
// So `hairline` rules a card's rows and separates two bands sharing a tone, and
// stays deliberately faint -- a rule as loud as a word is a border, and bento
// does not border cards. `edge` bounds a CONTROL and is the one place WCAG
// 1.4.11 Non-text Contrast applies: 3:1 against the adjacent colour.
describe('rules and control edges', () => {
  const keys = PALETTES.map((p) => p.key) as StorefrontPalette[];

  it.each(keys)('%s draws a hairline that is not simply the surface it rules', (key) => {
    const c = paletteColors(key);
    expect(c.hairline).not.toBe(c.ground);
    expect(c.hairline).not.toBe(c.soft);
  });

  it.each(keys)('%s keeps the hairline quieter than its muted text', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.hairline, c.ground)).toBeLessThan(contrastRatio(c.muted, c.ground));
  });

  it.each(keys)('%s clears 3:1 for a control edge on the page tone', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.edge, c.soft)).toBeGreaterThanOrEqual(3);
  });

  // Stepped against `soft` rather than `ground` for the reason stockOutInk is:
  // every palette's ground is lighter than its soft, so clearing the ratio on
  // the darker of the two surfaces clears it on both. Asserted from both ends
  // rather than left to that argument.
  it.each(keys)('%s clears 3:1 for a control edge on its card ground too', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.edge, c.ground)).toBeGreaterThanOrEqual(3);
  });

  it.each(keys)('%s makes edge and hairline genuinely different weights', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.edge, c.ground)).toBeGreaterThan(contrastRatio(c.hairline, c.ground));
  });

  // An edge is a boundary, not type. If it ever reaches full ink it has stopped
  // being a line around a control and become the control.
  it.each(keys)('%s keeps the control edge quieter than its own ink', (key) => {
    const c = paletteColors(key);
    expect(contrastRatio(c.edge, c.ground)).toBeLessThan(contrastRatio(c.ink, c.ground));
  });

  // The defect both tokens exist for, pinned so nobody reaches for `soft`
  // again on the assumption that it shows up.
  it('pins why soft could never have been the line: it is invisible on ground', () => {
    const c = paletteColors('ink');
    expect(contrastRatio(c.soft, c.ground)).toBeLessThan(1.1);
    expect(contrastRatio(c.edge, c.ground)).toBeGreaterThanOrEqual(3);
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

  // A FLOOR as well as a ceiling. Without one, a wash that had collapsed onto
  // its own ground -- ratio 1.0, meaning no visible tint at all -- would still
  // pass: 1.0 clears "< 1.6" as comfortably as any real tint does, so the gate
  // would not notice the one failure mode that matters most, the wash
  // disappearing. 1.03 sits meaningfully above 1.0 while every palette's
  // current derivation still clears it (azure is the tightest here, ~1.18).
  it.each(keys)('%s keeps the wash a tint, not a second fill, on ground', (key) => {
    const c = paletteColors(key);
    const ratio = contrastRatio(c.accentWash, c.ground);
    expect(ratio).toBeGreaterThan(1.03);
    expect(ratio).toBeLessThan(1.6);
  });

  // The gate above tests `ground`, but the four controls wearing this tier --
  // the empty-state nudge, the search-clear chip, a category filter chip,
  // "Edit cart" -- all render on the PAGE, and every theme fills the page with
  // `colors.soft`, not `ground` (theme-market.tsx:153, theme-counter.tsx:111,
  // theme-window.tsx:148). A wash tested only against a surface it never sits
  // on is not tested. Same floor, for the same reason: without it a wash that
  // had collapsed onto `soft` would pass silently (saffron is the tightest
  // here, ~1.07, still comfortably above the floor).
  it.each(keys)('%s keeps the wash a tint, not a second fill, on the page it actually sits on', (key) => {
    const c = paletteColors(key);
    const ratio = contrastRatio(c.accentWash, c.soft);
    expect(ratio).toBeGreaterThan(1.03);
    expect(ratio).toBeLessThan(1.6);
  });
});

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

describe("kaiibi's own blue", () => {
  it('carries white text, which is its whole job on the mark plate and the selected chip', () => {
    expect(contrastRatio(KAIIBI_INK, KAIIBI_BLUE)).toBeGreaterThanOrEqual(4.5);
  });

  // Coincidence, not derivation: pinned equal so a future rebrand that moves
  // one without the other is a failing test, not a silent drift, and so
  // whoever reads a red diff here knows to go re-read both comments before
  // "fixing" it back to a shared constant.
  it('coincides with checkout blue today, without being an alias of it', () => {
    expect(KAIIBI_BLUE).toBe(CHECKOUT_BLUE);
    expect(KAIIBI_INK).toBe(CHECKOUT_INK);
  });
});

// REVIEW FINDING (whole-branch pass, item 9): this describe block used to
// assert `DIRECTORY_STATE_OPEN === '#0b7a44'` -- a literal compared to a
// literal written in the same commit, which cannot fail no matter what the
// GRID CARD actually renders -- and a sibling assertion that the pair sits on
// no palette's own `accent`, which is the same defect wearing different
// clothes: a comparison between constants that never touches a render either.
// The rendered dot's own colour is what actually matters, and it already has
// real coverage: `storefront-directory.test.tsx`'s "fills the dot green when
// open and grey when closed" reads the DOT's flattened style off a live
// render and compares it to these same constants. The featured card's
// on-photo pill gets the equivalent render-based coverage in the same file
// ("badges an open/closed shop over its photo" plus the constants import),
// now that `stateOpen`/`stateShut` (shop-directory-card.tsx) import
// DIRECTORY_STATE_OPEN/SHUT directly instead of carrying their own hex
// copies -- so there is nothing left for a description-of-the-code test here
// to add.
