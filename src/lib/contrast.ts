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

  // Head toward whichever extreme has the higher ceiling against this ground,
  // not toward whichever the ground's own luminance suggests.
  //
  // Choosing by `relativeLuminance(ground) < 0.5` looks equivalent and is not:
  // on a mid-tone ground it can send a colour that is ALREADY darker than the
  // ground climbing toward white, exhaust the step budget short of the target,
  // and return a colour that fails the ratio the caller asked for -- while
  // darkening would have cleared it comfortably. Comparing the two ceilings
  // cannot make that mistake, because it asks the only question that matters:
  // which direction can actually get there.
  const towardWhite = contrastRatio('#ffffff', against) >= contrastRatio('#000000', against);
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
