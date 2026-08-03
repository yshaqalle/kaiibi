import { dayKeyFor, endOfDay, fromDateColumn, isDateColumnInRange, startOfDay, toDateColumn } from '@/lib/period';

describe('startOfDay / endOfDay', () => {
  it('snaps to the local day boundaries', () => {
    const evening = new Date(2026, 7, 2, 23, 14, 30, 250);
    expect(startOfDay(evening).getHours()).toBe(0);
    expect(startOfDay(evening).getMinutes()).toBe(0);
    expect(startOfDay(evening).getMilliseconds()).toBe(0);
    expect(endOfDay(evening).getHours()).toBe(23);
    expect(endOfDay(evening).getMinutes()).toBe(59);
    expect(endOfDay(evening).getMilliseconds()).toBe(999);
  });

  // Callers share Date instances between tabs (RangeSelector hands the same
  // object to several consumers), so a mutating helper would corrupt them.
  it('does not mutate its argument', () => {
    const original = new Date(2026, 7, 2, 14, 30, 0, 0);
    const snapshot = original.getTime();
    startOfDay(original);
    endOfDay(original);
    expect(original.getTime()).toBe(snapshot);
  });
});

describe('dayKeyFor', () => {
  it('buckets two times on the same local day identically', () => {
    const morning = new Date(2026, 7, 2, 8, 0, 0);
    const lateEvening = new Date(2026, 7, 2, 23, 45, 0);
    expect(dayKeyFor(morning)).toBe(dayKeyFor(lateEvening));
  });

  it('separates adjacent days', () => {
    expect(dayKeyFor(new Date(2026, 7, 2, 23, 59, 59))).not.toBe(dayKeyFor(new Date(2026, 7, 3, 0, 0, 1)));
  });
});

describe('toDateColumn / fromDateColumn', () => {
  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(toDateColumn(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateColumn(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  // The trap this avoids: toISOString() converts to UTC first, so an evening
  // date west of Greenwich would serialise as the following day.
  it('uses the local date even late in the evening', () => {
    expect(toDateColumn(new Date(2026, 7, 2, 23, 30, 0))).toBe('2026-08-02');
  });

  it('round-trips through local midnight', () => {
    const parsed = fromDateColumn('2026-08-02');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(2);
    expect(parsed.getHours()).toBe(0);
    expect(toDateColumn(parsed)).toBe('2026-08-02');
  });
});

describe('isDateColumnInRange', () => {
  const since = new Date(2026, 7, 1, 9, 30, 0);
  const until = new Date(2026, 7, 31, 14, 0, 0);

  it('includes both boundary days regardless of the range times', () => {
    expect(isDateColumnInRange('2026-08-01', since, until)).toBe(true);
    expect(isDateColumnInRange('2026-08-31', since, until)).toBe(true);
  });

  it('excludes days outside the range', () => {
    expect(isDateColumnInRange('2026-07-31', since, until)).toBe(false);
    expect(isDateColumnInRange('2026-09-01', since, until)).toBe(false);
  });

  it('treats an omitted upper bound as open-ended', () => {
    expect(isDateColumnInRange('2027-01-01', since)).toBe(true);
  });
});


