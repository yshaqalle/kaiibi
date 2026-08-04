import {
  formatDayHours,
  isOpenAt,
  isValidRange,
  isValidTime,
  rangesFor,
  weekdayKeyFor,
  type OpeningHours,
} from '@/lib/store-hours';

// 2026-08-03 is a Monday. Every date below is chosen from that week so the
// weekday is obvious from the day-of-month.
const MONDAY = '2026-08-03';

function at(day: string, time: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}

const NINE_TO_SIX: OpeningHours = { mon: [{ open: '09:00', close: '18:00' }] };

describe('weekdayKeyFor', () => {
  // Date.getDay() returns 0 for SUNDAY, not Monday. Getting this wrong shifts
  // every day by one and is invisible until someone checks a real date.
  it('maps each day of the week correctly', () => {
    expect(weekdayKeyFor(at('2026-08-03', '12:00'))).toBe('mon');
    expect(weekdayKeyFor(at('2026-08-04', '12:00'))).toBe('tue');
    expect(weekdayKeyFor(at('2026-08-05', '12:00'))).toBe('wed');
    expect(weekdayKeyFor(at('2026-08-06', '12:00'))).toBe('thu');
    expect(weekdayKeyFor(at('2026-08-07', '12:00'))).toBe('fri');
    expect(weekdayKeyFor(at('2026-08-08', '12:00'))).toBe('sat');
    expect(weekdayKeyFor(at('2026-08-09', '12:00'))).toBe('sun');
  });
});

describe('isValidTime', () => {
  it('accepts a zero-padded 24-hour time', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('09:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
  });

  it('rejects an out-of-range hour or minute', () => {
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('25:00')).toBe(false);
    expect(isValidTime('12:60')).toBe(false);
  });

  it('rejects anything not exactly HH:MM', () => {
    expect(isValidTime('9:00')).toBe(false);
    expect(isValidTime('0900')).toBe(false);
    expect(isValidTime('')).toBe(false);
    expect(isValidTime('09:00:00')).toBe(false);
    expect(isValidTime('nine')).toBe(false);
  });
});

describe('isValidRange', () => {
  it('accepts a range that closes after it opens', () => {
    expect(isValidRange({ open: '09:00', close: '18:00' })).toBe(true);
  });

  // Overnight opening is out of scope, so an end at or before the start is a
  // typo rather than a shape to interpret.
  it('rejects a zero-length or backwards range', () => {
    expect(isValidRange({ open: '09:00', close: '09:00' })).toBe(false);
    expect(isValidRange({ open: '18:00', close: '09:00' })).toBe(false);
  });

  it('rejects a range containing an invalid time', () => {
    expect(isValidRange({ open: '9:00', close: '18:00' })).toBe(false);
    expect(isValidRange({ open: '09:00', close: '25:00' })).toBe(false);
  });
});

describe('isOpenAt', () => {
  it('is open inside the range', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '12:00'))).toBe(true);
  });

  it('is closed before and after the range', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '08:59'))).toBe(false);
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '18:01'))).toBe(false);
  });

  // The boundary rule scheduling depends on: a shift ending at closing time
  // must be valid, so `close` is exclusive and `open` is inclusive.
  it('is open at exactly the opening time and closed at exactly the closing time', () => {
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '09:00'))).toBe(true);
    expect(isOpenAt(NINE_TO_SIX, at(MONDAY, '18:00'))).toBe(false);
  });

  it('is closed on a day with an empty range list', () => {
    expect(isOpenAt({ mon: [] }, at(MONDAY, '12:00'))).toBe(false);
  });

  it('is closed on a day absent from the object', () => {
    expect(isOpenAt({}, at(MONDAY, '12:00'))).toBe(false);
    expect(isOpenAt(NINE_TO_SIX, at('2026-08-04', '12:00'))).toBe(false);
  });

  // The stored shape allows two ranges per day before the editor offers them.
  // This proves the shape works ahead of the UI.
  it('handles a split day, and is closed in the gap', () => {
    const split: OpeningHours = { mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '18:00' }] };
    expect(isOpenAt(split, at(MONDAY, '10:00'))).toBe(true);
    expect(isOpenAt(split, at(MONDAY, '14:00'))).toBe(false);
    expect(isOpenAt(split, at(MONDAY, '16:00'))).toBe(true);
  });

  // A malformed range must not accidentally open the shop.
  it('ignores an invalid range rather than treating it as open', () => {
    expect(isOpenAt({ mon: [{ open: '18:00', close: '09:00' }] }, at(MONDAY, '12:00'))).toBe(false);
  });
});

describe('rangesFor', () => {
  it('returns an empty array for a day that is absent', () => {
    expect(rangesFor({}, 'mon')).toEqual([]);
  });

  it('returns the day ranges', () => {
    expect(rangesFor(NINE_TO_SIX, 'mon')).toEqual([{ open: '09:00', close: '18:00' }]);
  });
});

describe('formatDayHours', () => {
  it('formats one range in 24-hour time', () => {
    expect(formatDayHours([{ open: '09:00', close: '18:00' }])).toBe('09:00 – 18:00');
  });

  it('joins two ranges', () => {
    expect(formatDayHours([{ open: '09:00', close: '13:00' }, { open: '15:00', close: '18:00' }])).toBe(
      '09:00 – 13:00, 15:00 – 18:00'
    );
  });

  it('says Closed for no ranges', () => {
    expect(formatDayHours([])).toBe('Closed');
  });

  it('says Closed when every range is invalid', () => {
    expect(formatDayHours([{ open: '18:00', close: '09:00' }])).toBe('Closed');
  });
});
