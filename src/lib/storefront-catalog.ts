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

import { parseHex } from '@/lib/contrast';

export type StorefrontTheme = 'market' | 'counter' | 'window';
export type StorefrontPalette = 'ink' | 'palm' | 'clay' | 'sea' | 'saffron' | 'plum';

export type PaletteColors = {
  ground: string; // the page
  soft: string;   // tiles, the no-photo fallback, insets
  ink: string;    // all type
  accent: string; // buttons and the active filter, always with white on it
  muted: string;  // secondary type -- a city subtitle, an about paragraph
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

type BasePaletteColors = Omit<PaletteColors, 'muted'>;

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

export function paletteColors(palette: StorefrontPalette): PaletteColors {
  const key = paletteKey(palette);
  return { ...COLORS[key], muted: mutedInk(key) };
}

// NOT part of any palette, and deliberately not themeable. Green is what makes
// a WhatsApp button get tapped; recolouring it to a shop's accent trades the
// affordance for a colour nobody asked for.
//
// This is a DIFFERENT constant of the same name from
// src/components/platform/whatsapp-button.tsx's WHATSAPP_GREEN (#1fa855).
// That one is the brand green as-is; this one is darkened because this page's
// contrast test demands 4.5:1 for white text on top of it. Import from this
// module for the storefront, not the platform one.
export const WHATSAPP_GREEN = '#1f7a4d';
// The text colour on the fixed WhatsApp green above -- stays fixed for the
// same reason the green does, so it's catalogued rather than a stray literal
// on the button label.
export const WHATSAPP_INK = '#ffffff';
