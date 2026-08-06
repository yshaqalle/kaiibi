// How a date range is named on screen.
//
// Preset-aware, which is the whole point. The Dashboard's pill said "7 days"
// while Accounting's said "7/30/2026 – today" for the identical range, because
// each screen wrote its own label: Accounting always spelled out the dates,
// and the Dashboard knew about the presets. Same range, same shop, two names.
//
// Structural types rather than importing DateRange/RangePreset from
// components/range-selector.tsx: this module stays free of React Native so it
// can be unit-tested, and the shapes are what actually matter here.

export type LabelRange = { since: Date; until?: Date };
export type LabelPreset = { label: string; days: number };

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** The `since` a preset of `days` resolves to, relative to `today`. */
function presetSince(days: number, today: Date): Date {
  const since = startOfDay(today);
  // (days - 1), matching RangeSelector and RangeMenu: `days: 1` is today
  // alone, so the window opens at this morning's midnight.
  since.setDate(since.getDate() - (days - 1));
  return since;
}

function formatShort(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * "7 days" when the range is one of `presets`, otherwise "30 Jul – 5 Aug".
 *
 * A range with an explicit `until` is never a preset — presets are open-ended
 * windows ending now, so a custom range that happens to start on the same day
 * must not borrow a preset's name.
 */
export function formatRangeLabel(range: LabelRange, presets: readonly LabelPreset[] = [], today = new Date()): string {
  if (!range.until) {
    const since = startOfDay(range.since).getTime();
    const preset = presets.find((option) => presetSince(option.days, today).getTime() === since);
    if (preset) return preset.label;
  }

  const until = range.until ?? today;
  return `${formatShort(range.since)} – ${formatShort(until)}`;
}
