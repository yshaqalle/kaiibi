import {
  findDayProblem,
  formatDayHours,
  gapsBetween,
  isConfigured,
  isOpenAt,
  isRangeWithinHours,
  isValidRange,
  isValidTime,
  normalizeDay,
  normalizeHours,
  rangesFor,
  suggestNextRange,
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

describe('isRangeWithinHours', () => {
  const split: OpeningHours = { mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '18:00' }] };

  // A shift spanning the closure between two stored ranges must not validate
  // just because its endpoints each land inside SOME range.
  it('rejects a shift spanning the gap between two ranges', () => {
    expect(isRangeWithinHours(split, 'mon', { open: '10:00', close: '16:00' })).toBe(false);
  });

  it('accepts a shift equal to the whole range', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '09:00', close: '18:00' })).toBe(true);
  });

  it('accepts a shift strictly inside the range', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '10:00', close: '17:00' })).toBe(true);
  });

  // Inclusive at `close`, unlike isOpenAt -- this is the whole point of the
  // predicate existing.
  it('accepts a shift ending exactly at closing time', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '09:00', close: '18:00' })).toBe(true);
  });

  it('rejects a shift starting before the range opens', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '08:00', close: '17:00' })).toBe(false);
  });

  it('rejects a shift ending after the range closes', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '10:00', close: '19:00' })).toBe(false);
  });

  it('rejects on a day with no ranges', () => {
    expect(isRangeWithinHours({}, 'mon', { open: '10:00', close: '11:00' })).toBe(false);
  });

  it('rejects an invalid shift', () => {
    expect(isRangeWithinHours(NINE_TO_SIX, 'mon', { open: '18:00', close: '09:00' })).toBe(false);
  });
});

describe('isConfigured', () => {
  it('is false for an empty object', () => {
    expect(isConfigured({})).toBe(false);
  });

  it('is true when a day is explicitly set to an empty closure', () => {
    expect(isConfigured({ mon: [] })).toBe(true);
  });

  it('is true for a populated week', () => {
    expect(isConfigured(NINE_TO_SIX)).toBe(true);
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

  // A split day with a third block -- a shop that shuts for lunch AND for
  // evening prayer. Nothing caps how many blocks a day may carry.
  it('joins three ranges', () => {
    expect(
      formatDayHours([
        { open: '08:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
        { open: '20:00', close: '23:00' },
      ])
    ).toBe('08:00 – 12:00, 14:00 – 18:00, 20:00 – 23:00');
  });
});

describe('findDayProblem', () => {
  it('finds nothing wrong with a single valid range', () => {
    expect(findDayProblem([{ open: '09:00', close: '18:00' }])).toBeNull();
  });

  it('finds nothing wrong with a closed day', () => {
    expect(findDayProblem([])).toBeNull();
  });

  it('finds nothing wrong with a split day', () => {
    expect(
      findDayProblem([{ open: '09:00', close: '13:00' }, { open: '17:00', close: '21:00' }])
    ).toBeNull();
  });

  // Blocks that touch are legal input -- normalizeDay merges them rather than
  // the editor refusing them, because there is no closure between them to
  // describe and rejecting it would be pedantic.
  it('finds nothing wrong with two blocks that touch', () => {
    expect(
      findDayProblem([{ open: '13:00', close: '17:00' }, { open: '17:00', close: '21:00' }])
    ).toBeNull();
  });

  // The index is what lets the editor put its message under the offending
  // block rather than at the top of the day.
  it('reports an invalid range with its index', () => {
    const problem = findDayProblem([{ open: '09:00', close: '13:00' }, { open: '18:00', close: '15:00' }]);
    expect(problem?.index).toBe(1);
    expect(problem?.message).toContain('24-hour');
  });

  it('reports an unparseable time as invalid rather than as an overlap', () => {
    const problem = findDayProblem([{ open: '9:00', close: '18:00' }]);
    expect(problem?.index).toBe(0);
    expect(problem?.message).toContain('24-hour');
  });

  // Named against the block it collides with, and against the time to type,
  // because "invalid" alone leaves the owner guessing which end to move.
  it('reports an overlap naming the earlier block and the fix', () => {
    const problem = findDayProblem([{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }]);
    expect(problem?.index).toBe(1);
    expect(problem?.message).toBe('This overlaps 09:00 – 13:00. Start at 13:00 or later.');
  });

  // Order in the array is the order typed, not the order in time. A block
  // typed first but starting later must still be caught.
  it('finds an overlap regardless of the order the blocks were entered', () => {
    const problem = findDayProblem([{ open: '12:00', close: '17:00' }, { open: '09:00', close: '13:00' }]);
    expect(problem).not.toBeNull();
    expect(problem?.message).toContain('overlaps');
  });

  it('reports a block fully inside another', () => {
    const problem = findDayProblem([{ open: '09:00', close: '18:00' }, { open: '10:00', close: '11:00' }]);
    expect(problem?.index).toBe(1);
  });

  // An invalid block cannot be meaningfully compared against anything, so it
  // is reported first and the overlap check waits its turn.
  it('reports the invalid block before any overlap', () => {
    const problem = findDayProblem([{ open: '18:00', close: '09:00' }, { open: '10:00', close: '11:00' }]);
    expect(problem?.index).toBe(0);
    expect(problem?.message).toContain('24-hour');
  });
});

describe('normalizeDay', () => {
  it('leaves a single valid range alone', () => {
    expect(normalizeDay([{ open: '09:00', close: '18:00' }])).toEqual([{ open: '09:00', close: '18:00' }]);
  });

  it('leaves an empty day alone', () => {
    expect(normalizeDay([])).toEqual([]);
  });

  it('sorts blocks by opening time', () => {
    expect(normalizeDay([{ open: '17:00', close: '21:00' }, { open: '09:00', close: '13:00' }])).toEqual([
      { open: '09:00', close: '13:00' },
      { open: '17:00', close: '21:00' },
    ]);
  });

  // Two blocks that touch describe no closure at all, so storing both would
  // print "13:00 – 17:00, 17:00 – 21:00" on a receipt -- a lie about a break
  // that does not exist.
  it('merges two blocks that touch into one', () => {
    expect(normalizeDay([{ open: '13:00', close: '17:00' }, { open: '17:00', close: '21:00' }])).toEqual([
      { open: '13:00', close: '21:00' },
    ]);
  });

  it('merges a chain of touching blocks', () => {
    expect(
      normalizeDay([
        { open: '09:00', close: '12:00' },
        { open: '12:00', close: '15:00' },
        { open: '15:00', close: '18:00' },
      ])
    ).toEqual([{ open: '09:00', close: '18:00' }]);
  });

  it('keeps a real closure between two blocks', () => {
    expect(normalizeDay([{ open: '09:00', close: '13:00' }, { open: '17:00', close: '21:00' }])).toEqual([
      { open: '09:00', close: '13:00' },
      { open: '17:00', close: '21:00' },
    ]);
  });

  // Reached only if a caller skips findDayProblem. Merging to the later close
  // is the safe reading: it never invents opening time the owner did not type.
  it('merges overlapping blocks to the later close', () => {
    expect(normalizeDay([{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }])).toEqual([
      { open: '09:00', close: '17:00' },
    ]);
  });

  // Sorting and merging garbage produces different garbage. The editor gates
  // Save on findDayProblem, so this path means a bug upstream -- returning the
  // input untouched keeps what the owner typed visible so they can fix it.
  it('returns the day untouched when any block is invalid', () => {
    const bad = [{ open: '18:00', close: '09:00' }, { open: '09:00', close: '13:00' }];
    expect(normalizeDay(bad)).toEqual(bad);
  });
});

describe('normalizeHours', () => {
  it('normalizes every day it holds', () => {
    expect(
      normalizeHours({
        mon: [{ open: '17:00', close: '21:00' }, { open: '09:00', close: '13:00' }],
        tue: [{ open: '13:00', close: '17:00' }, { open: '17:00', close: '21:00' }],
      })
    ).toEqual({
      mon: [{ open: '09:00', close: '13:00' }, { open: '17:00', close: '21:00' }],
      tue: [{ open: '13:00', close: '21:00' }],
    });
  });

  // The distinction isConfigured and the scheduler depend on: a day set to []
  // is "closed", a day absent is "never configured". Normalising must not
  // quietly turn one into the other.
  it('keeps an explicitly closed day and does not invent absent ones', () => {
    expect(normalizeHours({ mon: [] })).toEqual({ mon: [] });
    expect(Object.keys(normalizeHours({ mon: [] }))).toEqual(['mon']);
  });

  it('leaves a never-configured week empty', () => {
    expect(normalizeHours({})).toEqual({});
  });
});

describe('suggestNextRange', () => {
  it('suggests the default for a day with no hours yet', () => {
    expect(suggestNextRange([])).toEqual({ open: '09:00', close: '18:00' });
  });

  // The block must not touch the one before it: normalizeDay would merge it
  // away on Done and the owner would see their tap do nothing.
  it('leaves a closure after the last block', () => {
    expect(suggestNextRange([{ open: '09:00', close: '13:00' }])).toEqual({ open: '14:00', close: '18:00' });
  });

  it('follows the latest block, not the last one in the list', () => {
    expect(
      suggestNextRange([{ open: '17:00', close: '21:00' }, { open: '09:00', close: '13:00' }])
    ).toEqual({ open: '22:00', close: '23:59' });
  });

  it('clamps the close to the end of the day', () => {
    expect(suggestNextRange([{ open: '09:00', close: '20:30' }])).toEqual({ open: '21:30', close: '23:59' });
  });

  // A visible overlap that findDayProblem explains beats Add doing nothing.
  it('falls back to the default when the day has no room left', () => {
    expect(suggestNextRange([{ open: '09:00', close: '23:00' }])).toEqual({ open: '09:00', close: '18:00' });
  });

  it('ignores invalid blocks when deciding where to start', () => {
    expect(suggestNextRange([{ open: '18:00', close: '09:00' }])).toEqual({ open: '09:00', close: '18:00' });
  });
});

describe('gapsBetween', () => {
  it('reports the closure between two blocks', () => {
    expect(gapsBetween([{ open: '09:00', close: '13:00' }, { open: '17:00', close: '21:00' }])).toEqual([
      { open: '13:00', close: '17:00' },
    ]);
  });

  it('reports both closures on a three-block day', () => {
    expect(
      gapsBetween([
        { open: '08:00', close: '12:00' },
        { open: '14:00', close: '18:00' },
        { open: '20:00', close: '23:00' },
      ])
    ).toEqual([{ open: '12:00', close: '14:00' }, { open: '18:00', close: '20:00' }]);
  });

  it('reports nothing for a single block or a closed day', () => {
    expect(gapsBetween([{ open: '09:00', close: '18:00' }])).toEqual([]);
    expect(gapsBetween([])).toEqual([]);
  });

  // Touching blocks have no closure to describe -- they are one block that
  // normalizeDay has not merged yet.
  it('reports nothing between two touching blocks', () => {
    expect(gapsBetween([{ open: '13:00', close: '17:00' }, { open: '17:00', close: '21:00' }])).toEqual([]);
  });

  it('reports nothing when a block is invalid', () => {
    expect(gapsBetween([{ open: '18:00', close: '09:00' }, { open: '10:00', close: '11:00' }])).toEqual([]);
  });
});
