import { Colors } from '@/constants/theme';

// One colour per category, assigned once and reused everywhere.
//
// The point is cross-chart consistency: if Pantry is blue in the donut, it has
// to be blue in the stacked months and in any breakdown row, or the reader
// re-learns the key on every card. Assigning per-chart from an index is what
// produces that, and it is the default thing to do, so this exists to stop it.
//
// Hues come from the existing chartSeries tokens rather than a new palette —
// those were already chosen for CVD separation and contrast. Grey is reserved
// for the RESIDUAL ("Other", "Not tied to a store") and must never be given to
// a real category, because it reads as "not counted".
//
// Semantic colour is a different axis and stays separate: success/warning/
// danger mean good/attention/bad, and a category must never borrow one, or a
// green slice starts looking like good news.

const SERIES = [
  Colors.light.chartSeries1,
  Colors.light.chartSeries2,
  Colors.light.chartSeries3,
  Colors.light.chartSeries4,
] as const;

/** The residual. Never assigned to a named category. */
export const RESIDUAL_COLOR = Colors.light.textSecondary;

// Stable hashing rather than "index in whatever order this chart received
// them": a category's colour must not change because a quiet week reordered
// the list. Categories are shop-defined strings, so there is no fixed catalog
// to index into.
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * The colour for a category name. Case- and space-insensitive, so "Cold Brew"
 * and "cold brew" don't end up as two different colours in two places.
 */
export function categoryColor(category: string | null | undefined): string {
  const key = (category ?? '').trim().toLowerCase();
  if (!key || key === 'other' || key === 'uncategorised' || key === 'uncategorized') {
    return RESIDUAL_COLOR;
  }
  return SERIES[hash(key) % SERIES.length];
}

/**
 * Colours for a list of categories, avoiding a collision between two that
 * happen to hash to the same slot.
 *
 * `categoryColor` alone is stable but not injective — with four hues and five
 * categories on screen, two sharing a colour makes a chart unreadable. This
 * keeps each name's preferred hue where it can and moves the clashes on.
 * Beyond four named categories a repeat is unavoidable; that is the signal to
 * group the tail into the residual rather than to add a fifth hue.
 */
export function categoryColors(categories: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  const result = new Map<string, string>();

  for (const category of categories) {
    const preferred = categoryColor(category);
    if (preferred === RESIDUAL_COLOR || !taken.has(preferred)) {
      result.set(category, preferred);
      if (preferred !== RESIDUAL_COLOR) taken.add(preferred);
      continue;
    }
    const free = SERIES.find((color) => !taken.has(color));
    const chosen = free ?? preferred;
    result.set(category, chosen);
    taken.add(chosen);
  }

  return result;
}
