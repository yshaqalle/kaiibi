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
