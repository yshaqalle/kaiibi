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

import { parseHex, stepUntilContrast } from '@/lib/contrast';

export type StorefrontTheme = 'market' | 'counter' | 'window';
export type StorefrontPalette = 'ink' | 'palm' | 'clay' | 'sea' | 'saffron' | 'plum';

export type PaletteColors = {
  ground: string; // the page
  soft: string;   // tiles, the no-photo fallback, insets
  ink: string;    // all type
  accent: string; // buttons and the active filter, always with white on it
  muted: string;  // secondary type -- a city subtitle, an about paragraph
  danger: string; // form error text -- never the out-of-stock amber, and never a stray hex at the call site
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

type BasePaletteColors = Omit<PaletteColors, 'muted' | 'danger'>;

const COLORS: Record<StorefrontPalette, BasePaletteColors> = {
  ink:     { ground: '#ffffff', soft: '#f4f4f5', ink: '#141418', accent: '#141418' },
  palm:    { ground: '#fbfcfa', soft: '#eef4ef', ink: '#12211a', accent: '#1f6b45' },
  clay:    { ground: '#fdfaf7', soft: '#f5ede6', ink: '#241a14', accent: '#98452a' },
  sea:     { ground: '#fafcfd', soft: '#eaf1f5', ink: '#101f28', accent: '#155b78' },
  saffron: { ground: '#fdfbf6', soft: '#f6efe0', ink: '#241d10', accent: '#8a5a05' },
  plum:    { ground: '#fdfafc', soft: '#f5ecf2', ink: '#221420', accent: '#8a2c62' },
};

// Secondary type -- a city subtitle, an about paragraph -- needs to read as
// quieter than the shop name without falling below body-text contrast. The
// palette has no fifth token for it, so it is derived: ink blended toward
// ground by a fixed proportion, kept as a hex so it's testable with
// contrastRatio rather than an RN opacity trick that isn't.
//
// 0.34 is tuned, not arbitrary: every palette's ink starts at 7:1+ on its own
// ground (enforced by the 'palette contrast' tests above), and saffron is the
// tightest palette in the set once ink is blended toward ground -- at 0.34 it
// still clears 4.5:1 with headroom (~5.3:1). Raising the blend closes that
// headroom and eventually fails WCAG AA on saffron; lowering it makes muted
// stop reading as quieter than full ink.
const MUTED_BLEND = 0.34;

function blendHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const mix = (x: number, y: number) => clamp(x + (y - x) * amount);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(a.r, b.r))}${hex(mix(a.g, b.g))}${hex(mix(a.b, b.b))}`;
}

// `palette` is an untrusted string from a database row -- a `COLORS[palette]`
// truthiness check resolves through the prototype chain for keys like
// 'constructor', so it must be an OWN-property check, the same discipline
// storefront-view.tsx applies to RENDERERS.
function paletteKey(palette: StorefrontPalette): StorefrontPalette {
  return Object.prototype.hasOwnProperty.call(COLORS, palette) ? palette : DEFAULT_PALETTE;
}

export function mutedInk(palette: StorefrontPalette): string {
  const c = COLORS[paletteKey(palette)];
  return blendHex(c.ink, c.ground, MUTED_BLEND);
}

// Checkout form errors ("Add your name...", a bad phone, a missing landmark)
// used to hard-code clay's own accent (#98452a) as the error colour on every
// palette -- so a shop on ink, palm, sea, saffron or plum saw an unrelated
// rust-brown, off its own palette entirely. Same fix as `muted`: a real
// token, derived rather than picked at the call site.
//
// Anchored on a conventional error red (#b3261e) rather than any palette's
// own accent, so it reads as "something is wrong" on every palette and is
// never confusable with the fixed out-of-stock amber (#8a5a05) product-tile
// and theme-counter already use -- an error and a stock notice must not look
// like the same signal. Blended a small amount toward the palette's own ink
// (DANGER_INK_BLEND) so the token is still genuinely computed FROM that
// palette rather than a single constant reused six times, then walked
// through stepUntilContrast against that palette's own ground so a future
// change to a ground value can't silently drop it below 4.5:1 -- the same
// belt-and-braces the muted-text comment above describes.
const DANGER_BASE = '#b3261e';
const DANGER_INK_BLEND = 0.12;

export function dangerInk(palette: StorefrontPalette): string {
  const c = COLORS[paletteKey(palette)];
  const tinted = blendHex(DANGER_BASE, c.ink, DANGER_INK_BLEND);
  return stepUntilContrast(tinted, c.ground, 4.5);
}

export function paletteColors(palette: StorefrontPalette): PaletteColors {
  const key = paletteKey(palette);
  return { ...COLORS[key], muted: mutedInk(key), danger: dangerInk(key) };
}

// NOT part of any palette, and deliberately not themeable. Green is what makes
// a WhatsApp button get tapped; recolouring it to a shop's accent trades the
// affordance for a colour nobody asked for.
//
// Deliberately its own constant, not a re-export of
// src/components/platform/whatsapp-button.tsx's WHATSAPP_GREEN (#1fa855).
// That one fills the WhatsApp logo path, so it has to be the actual brand
// green. This one is a button background carrying white text, which the
// brand green fails at 4.5:1 -- so it's darkened here to a shade that passes.
// Same affordance, different constraint; do not unify them.
export const WHATSAPP_BUTTON_GREEN = '#1f7a4d';
// The text colour on the fixed WhatsApp green above -- stays fixed for the
// same reason the green does, so it's catalogued rather than a stray literal
// on the button label.
export const WHATSAPP_INK = '#ffffff';
