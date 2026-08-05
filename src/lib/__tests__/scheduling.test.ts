import {
  addDaysToDate,
  buildBulkShifts,
  clashesWith,
  hasBlockingProblem,
  membersForLocation,
  shiftMinutes,
  shiftsToCopy,
  startOfWeek,
  validateShift,
  validateShiftBlocks,
  weekDaysFrom,
  type Shift,
  type ValidationContext,
} from '@/lib/scheduling';
import type { OpeningHours } from '@/lib/store-hours';

// 2026-08-03 is a Monday.
const MONDAY = '2026-08-03';

const OPEN_9_TO_6: OpeningHours = {
  mon: [{ open: '09:00', close: '18:00' }],
  tue: [{ open: '09:00', close: '18:00' }],
};

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 's1',
    shopId: 'shop1',
    locationId: 'loc1',
    shopMemberId: 'm1',
    date: MONDAY,
    start: '09:00',
    end: '13:00',
    note: null,
    ...overrides,
  };
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { hours: OPEN_9_TO_6, onLeave: new Set<string>(), sameDayShifts: [], ...overrides };
}

describe('validateShift — overlap', () => {
  it('blocks a shift overlapping another for the same member that day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '12:00', end: '17:00' },
      context({ sameDayShifts: [makeShift()] })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'overlap', blocking: true });
  });

  // The boundary rule: back-to-back shifts are normal and must be allowed.
  it('allows a shift starting exactly when another ends', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '13:00', end: '17:00' },
      context({ sameDayShifts: [makeShift()] })
    );
    expect(problems).toEqual([]);
  });

  it('ignores a shift belonging to a different member', () => {
    const problems = validateShift(
      { shopMemberId: 'm2', locationId: 'loc1', date: MONDAY, start: '12:00', end: '17:00' },
      context({ sameDayShifts: [makeShift({ shopMemberId: 'm1' })] })
    );
    expect(problems).toEqual([]);
  });

  it('ignores a shift on a different day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: '2026-08-04', start: '09:00', end: '13:00' },
      context({ sameDayShifts: [makeShift({ date: MONDAY })] })
    );
    expect(problems).toEqual([]);
  });
});

describe('validateShift — opening hours', () => {
  it('warns when the shift falls outside opening hours', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '07:00', end: '10:00' },
      context()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'outside_hours', blocking: false });
  });

  it('does not warn for a shift inside opening hours', () => {
    const problems = validateShift({ shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '09:00', end: '18:00' }, context());
    expect(problems).toEqual([]);
  });

  // opening_hours defaults to {} with no backfill, so without this guard every
  // shop that never opened Settings would warn on every shift it ever created.
  it('skips the hours check entirely when the shop has no hours configured', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '03:00', end: '05:00' },
      context({ hours: {} })
    );
    expect(problems).toEqual([]);
  });

  it('warns on a day the shop is closed', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: '2026-08-09', start: '09:00', end: '13:00' },
      context()
    );
    expect(problems[0]).toMatchObject({ kind: 'outside_hours' });
  });
});

describe('validateShift — leave', () => {
  it('warns when the member has approved leave that day', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '09:00', end: '13:00' },
      context({ onLeave: new Set(['m1']) })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'on_leave', blocking: false });
  });

  it('reports an overlap and leave together', () => {
    const problems = validateShift(
      { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '12:00', end: '17:00' },
      context({ onLeave: new Set(['m1']), sameDayShifts: [makeShift()] })
    );
    expect(problems.map((p) => p.kind).sort()).toEqual(['on_leave', 'overlap']);
  });
});

describe('hasBlockingProblem', () => {
  it('is true only when something blocking is present', () => {
    expect(hasBlockingProblem([{ kind: 'on_leave', blocking: false, message: 'x' }])).toBe(false);
    expect(hasBlockingProblem([{ kind: 'overlap', blocking: true, message: 'x' }])).toBe(true);
    expect(hasBlockingProblem([])).toBe(false);
  });
});

describe('shiftMinutes', () => {
  it('measures the shift in minutes', () => {
    expect(shiftMinutes({ shopMemberId: 'm1', locationId: 'loc1', date: MONDAY, start: '09:00', end: '13:30' })).toBe(270);
  });
});

describe('startOfWeek and weekDaysFrom', () => {
  it('returns the Monday of a mid-week date', () => {
    expect(startOfWeek('2026-08-06')).toBe('2026-08-03');
  });

  it('treats Monday as its own week start', () => {
    expect(startOfWeek(MONDAY)).toBe(MONDAY);
  });

  // Date.getDay() returns 0 for Sunday, so Sunday belongs to the week that
  // began six days earlier, not to the one starting the next day.
  it('puts Sunday in the week that started the preceding Monday', () => {
    expect(startOfWeek('2026-08-09')).toBe(MONDAY);
  });

  it('crosses a month boundary', () => {
    expect(startOfWeek('2026-09-02')).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
  });

  it('returns seven consecutive days from the Monday', () => {
    expect(weekDaysFrom(MONDAY)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('spans a month end', () => {
    expect(weekDaysFrom('2026-08-31')[6]).toBe('2026-09-06');
  });
});

describe('addDaysToDate', () => {
  it('steps forward across a month boundary', () => {
    expect(addDaysToDate('2026-08-28', 7)).toBe('2026-09-04');
  });

  it('steps backward', () => {
    expect(addDaysToDate('2026-08-03', -7)).toBe('2026-07-27');
  });

  it('handles a leap day', () => {
    expect(addDaysToDate('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('shiftsToCopy', () => {
  it('shifts every date forward by a week', () => {
    const { copy, skipped } = shiftsToCopy([makeShift()], []);
    expect(skipped).toBe(0);
    expect(copy).toEqual([{ shopMemberId: 'm1', locationId: 'loc1', date: '2026-08-10', start: '09:00', end: '13:00' }]);
  });

  it('skips one that would clash with a shift already there', () => {
    const existing = [makeShift({ id: 'e1', date: '2026-08-10', start: '12:00', end: '17:00' })];
    const { copy, skipped } = shiftsToCopy([makeShift()], existing);
    expect(copy).toEqual([]);
    expect(skipped).toBe(1);
  });

  // Two source shifts landing on the same slot must not both copy: the second
  // has to see the first, which isn't in `existing` yet.
  it('skips a clash against another shift it is about to copy', () => {
    const previous = [makeShift({ id: 's1' }), makeShift({ id: 's2', start: '12:00', end: '17:00' })];
    const { copy, skipped } = shiftsToCopy(previous, []);
    expect(copy).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('copies a same-day shift for a different member', () => {
    const previous = [makeShift({ id: 's1' }), makeShift({ id: 's2', shopMemberId: 'm2' })];
    const { copy } = shiftsToCopy(previous, []);
    expect(copy).toHaveLength(2);
  });
});

describe('clashesWith', () => {
  it('finds an overlap for the same member on the same day', () => {
    expect(clashesWith({ shopMemberId: 'm1', date: MONDAY, start: '12:00', end: '17:00' }, [makeShift()])).toBe(true);
  });

  it('is false for a different member, a different day, or a touching boundary', () => {
    const candidate = { shopMemberId: 'm1', date: MONDAY, start: '13:00', end: '17:00' };
    expect(clashesWith(candidate, [makeShift()])).toBe(false);
    expect(clashesWith({ ...candidate, start: '09:00', end: '13:00', shopMemberId: 'm2' }, [makeShift()])).toBe(false);
    expect(clashesWith({ ...candidate, start: '09:00', end: '13:00', date: '2026-08-04' }, [makeShift()])).toBe(false);
  });

  it('is false against nothing', () => {
    expect(clashesWith({ shopMemberId: 'm1', date: MONDAY, start: '09:00', end: '13:00' }, [])).toBe(false);
  });
});

describe('validateShiftBlocks', () => {
  const base = { shopMemberId: 'm1', locationId: 'loc1', date: MONDAY };

  // The whole point of split days: a morning and an evening block, with the
  // shop closed in between, must be accepted.
  it('accepts two non-overlapping blocks on one day', () => {
    const problems = validateShiftBlocks([{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }], base, context());
    expect(problems).toHaveLength(0);
  });

  it('accepts blocks that touch at the boundary', () => {
    const problems = validateShiftBlocks([{ start: '09:00', end: '13:00' }, { start: '13:00', end: '18:00' }], base, context());
    expect(problems).toHaveLength(0);
  });

  it('blocks two blocks that overlap each other', () => {
    const problems = validateShiftBlocks([{ start: '09:00', end: '14:00' }, { start: '13:00', end: '18:00' }], base, context());
    expect(problems).toHaveLength(1);
    expect(problems[0].blocking).toBe(true);
    expect(problems[0].message).toContain('overlap each other');
  });

  // Self-contradiction is the more useful thing to say, so it wins the dedupe
  // over "overlaps a stored shift".
  it('prefers the blocks-overlap message when a stored shift also clashes', () => {
    const problems = validateShiftBlocks(
      [{ start: '09:00', end: '14:00' }, { start: '13:00', end: '18:00' }],
      base,
      context({ sameDayShifts: [makeShift()] })
    );
    expect(problems.filter((p) => p.kind === 'overlap')).toHaveLength(1);
    expect(problems[0].message).toContain('overlap each other');
  });

  it('still catches a clash with a stored shift', () => {
    const problems = validateShiftBlocks([{ start: '12:00', end: '17:00' }], base, context({ sameDayShifts: [makeShift()] }));
    expect(problems.map((p) => p.kind)).toEqual(['overlap']);
  });

  // One message per kind: two blocks outside opening hours is one thing to say,
  // and `kind` is the editor's React key.
  it('reports each kind of problem once', () => {
    const problems = validateShiftBlocks(
      [{ start: '06:00', end: '08:00' }, { start: '20:00', end: '22:00' }],
      base,
      context({ onLeave: new Set(['m1']) })
    );
    expect(problems.map((p) => p.kind)).toEqual(['outside_hours', 'on_leave']);
  });
});

describe('membersForLocation', () => {
  const alice = { id: 'm1', locationIds: [] as string[] };
  const bob = { id: 'm2', locationIds: ['loc1'] };
  const cara = { id: 'm3', locationIds: ['loc2', 'loc3'] };

  // An empty set means "every store", not "no store" -- so Alice belongs on
  // every board, which is the trap this function exists to avoid.
  it('keeps unrestricted members on every store', () => {
    expect(membersForLocation([alice, bob, cara], 'loc1').map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(membersForLocation([alice, bob, cara], 'loc2').map((m) => m.id)).toEqual(['m1', 'm3']);
  });

  it('returns everyone for the all-stores view', () => {
    expect(membersForLocation([alice, bob, cara], null)).toHaveLength(3);
  });

  it('returns a copy rather than the original array', () => {
    const members = [alice];
    expect(membersForLocation(members, null)).not.toBe(members);
  });
});

describe('buildBulkShifts', () => {
  const selection = {
    memberIds: ['m1', 'm2'],
    dates: [MONDAY, '2026-08-04'],
    blocks: [{ start: '09:00', end: '17:00' }],
    locationId: 'loc1',
  };

  it('is the cross product of people, days and blocks', () => {
    const { create, skipped } = buildBulkShifts(selection, []);
    expect(create).toHaveLength(4);
    expect(skipped).toBe(0);
  });

  it('creates both blocks of a split day', () => {
    const { create } = buildBulkShifts(
      { ...selection, memberIds: ['m1'], dates: [MONDAY], blocks: [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }] },
      []
    );
    expect(create.map((d) => `${d.start}-${d.end}`)).toEqual(['09:00-13:00', '17:00-21:00']);
  });

  // Partial work beats refusing the batch: one person already having Monday
  // shouldn't stop the other three slots being filled.
  it('skips only what clashes with a stored shift', () => {
    const { create, skipped } = buildBulkShifts(selection, [makeShift({ start: '09:00', end: '17:00' })]);
    expect(create).toHaveLength(3);
    expect(skipped).toBe(1);
    expect(create.some((d) => d.shopMemberId === 'm1' && d.date === MONDAY)).toBe(false);
  });

  it('skips a clash against something queued in the same run', () => {
    const { create, skipped } = buildBulkShifts(
      { ...selection, memberIds: ['m1'], dates: [MONDAY], blocks: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '18:00' }] },
      []
    );
    expect(create).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('carries the note onto every draft', () => {
    const { create } = buildBulkShifts({ ...selection, note: 'stock take' }, []);
    expect(create.every((d) => d.note === 'stock take')).toBe(true);
  });

  it('defaults the note to null rather than leaving it undefined', () => {
    const { create } = buildBulkShifts(selection, []);
    expect(create[0].note).toBeNull();
  });

  it('creates nothing from an empty selection', () => {
    expect(buildBulkShifts({ ...selection, memberIds: [] }, []).create).toHaveLength(0);
  });
});
