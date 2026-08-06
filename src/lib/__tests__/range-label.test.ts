import { formatRangeLabel, type LabelPreset } from '@/lib/range-label';

const PRESETS: LabelPreset[] = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

// Fixed so the "days ago" arithmetic is checkable rather than relative to
// whenever the suite happens to run.
const TODAY = new Date(2026, 7, 5, 14, 30); // 5 Aug 2026, mid-afternoon

function daysAgo(days: number): Date {
  const since = new Date(TODAY);
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);
  return since;
}

describe('formatRangeLabel', () => {
  it('names a range by its preset when one matches', () => {
    expect(formatRangeLabel({ since: daysAgo(7) }, PRESETS, TODAY)).toBe('7 days');
    expect(formatRangeLabel({ since: daysAgo(30) }, PRESETS, TODAY)).toBe('30 days');
    expect(formatRangeLabel({ since: daysAgo(1) }, PRESETS, TODAY)).toBe('Today');
  });

  it('matches a preset regardless of the time of day on `since`', () => {
    const midMorning = daysAgo(7);
    midMorning.setHours(9, 15, 0, 0);

    expect(formatRangeLabel({ since: midMorning }, PRESETS, TODAY)).toBe('7 days');
  });

  it('spells out the dates when no preset matches', () => {
    expect(formatRangeLabel({ since: daysAgo(14) }, PRESETS, TODAY)).toBe('Jul 23 – Aug 5');
  });

  it('never borrows a preset name for an explicit end date', () => {
    // Same start as the 7-day preset, but a closed window — "7 days" would
    // claim it runs to today, which it does not.
    const label = formatRangeLabel({ since: daysAgo(7), until: new Date(2026, 7, 2) }, PRESETS, TODAY);

    expect(label).toBe('Jul 30 – Aug 2');
  });

  it('falls back to dates when given no presets at all', () => {
    expect(formatRangeLabel({ since: daysAgo(7) }, [], TODAY)).toBe('Jul 30 – Aug 5');
  });
});
