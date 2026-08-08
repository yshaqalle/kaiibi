import type { ParsedCsv } from '@/lib/csv';
import { parseScheduleRows, scheduleTemplateRows, type ScheduleImportContext } from '@/lib/schedule-import';
import type { Shift } from '@/lib/scheduling';
import type { ShopLocation, StaffMember } from '@/types/models';

const HEADERS = ['Date', 'Staff Email', 'Start', 'End', 'Store', 'Note'];

function csv(rows: Record<string, string>[]): ParsedCsv {
  return { headers: HEADERS, rows } as ParsedCsv;
}

function member(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'm1',
    shopId: 'shop1',
    userId: 'u1',
    roleId: 'r1',
    roleName: 'Cashier',
    locationIds: [],
    active: true,
    fullName: 'Hamse Jibril',
    email: 'hamse@example.com',
    phone: null,
    photoUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hireDate: null,
    payType: null,
    payRateCents: null,
    payCadence: 'monthly',
    ...overrides,
  };
}

function location(overrides: Partial<ShopLocation> = {}): ShopLocation {
  return {
    id: 'loc1',
    shopId: 'shop1',
    name: 'Main',
    isPrimary: true,
    active: true,
    ...overrides,
  } as ShopLocation;
}

function shift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 's1',
    shopId: 'shop1',
    shopMemberId: 'm1',
    locationId: 'loc1',
    date: '2026-08-10',
    start: '09:00',
    end: '17:00',
    note: null,
    ...overrides,
  };
}

const singleStore: ScheduleImportContext = { members: [member()], locations: [location()], existingShifts: [] };

const goodRow = { Date: '2026-08-10', 'Staff Email': 'hamse@example.com', Start: '09:00', End: '17:00', Store: '', Note: '' };

describe('parseScheduleRows — happy path', () => {
  it('turns a row into a draft', () => {
    const { drafts, rejected } = parseScheduleRows(csv([goodRow]), singleStore);
    expect(rejected).toHaveLength(0);
    expect(drafts).toEqual([
      { shopMemberId: 'm1', locationId: 'loc1', date: '2026-08-10', start: '09:00', end: '17:00', note: null },
    ]);
  });

  it('carries a note', () => {
    const { drafts } = parseScheduleRows(csv([{ ...goodRow, Note: 'stock take' }]), singleStore);
    expect(drafts[0].note).toBe('stock take');
  });

  // The format's whole trick: a split day is just two ordinary rows, so an
  // exported week round-trips without special syntax.
  it('accepts two non-overlapping rows for the same person on the same day', () => {
    const { drafts, rejected } = parseScheduleRows(
      csv([
        { ...goodRow, Start: '09:00', End: '13:00' },
        { ...goodRow, Start: '17:00', End: '21:00' },
      ]),
      singleStore
    );
    expect(rejected).toHaveLength(0);
    expect(drafts).toHaveLength(2);
  });

  it('matches a staff member by name when the email column is blank', () => {
    const { drafts, rejected } = parseScheduleRows(
      csv([{ ...goodRow, 'Staff Email': '', 'Staff Name': 'Hamse Jibril' }]),
      singleStore
    );
    expect(rejected).toHaveLength(0);
    expect(drafts[0].shopMemberId).toBe('m1');
  });

  it('is case- and space-insensitive about emails', () => {
    const { rejected } = parseScheduleRows(csv([{ ...goodRow, 'Staff Email': '  HAMSE@example.com ' }]), singleStore);
    expect(rejected).toHaveLength(0);
  });
});

describe('parseScheduleRows — rejections', () => {
  const reasonFor = (row: Record<string, string>, context = singleStore) =>
    parseScheduleRows(csv([row]), context).rejected[0]?.reason ?? '';

  it('rejects a missing or malformed date', () => {
    expect(reasonFor({ ...goodRow, Date: '' })).toBe('Date is required.');
    expect(reasonFor({ ...goodRow, Date: '10/08/2026' })).toContain('YYYY-MM-DD');
    // Shaped right, but no such day.
    expect(reasonFor({ ...goodRow, Date: '2026-02-30' })).toContain('not a real date');
  });

  it('rejects an unknown staff member', () => {
    expect(reasonFor({ ...goodRow, 'Staff Email': 'nobody@example.com' })).toContain('No active staff member has the email');
  });

  it('rejects a row that identifies nobody', () => {
    expect(reasonFor({ ...goodRow, 'Staff Email': '' })).toBe('Staff Email is required.');
  });

  // Guessing between two people called the same thing is how someone ends up
  // rostered for a shift they never see.
  it('rejects an ambiguous name rather than guessing', () => {
    const context = {
      ...singleStore,
      members: [member({ id: 'm1', email: 'a@example.com' }), member({ id: 'm2', email: 'b@example.com' })],
    };
    expect(reasonFor({ ...goodRow, 'Staff Email': '', 'Staff Name': 'Hamse Jibril' }, context)).toContain('More than one');
  });

  it('ignores a deactivated member', () => {
    const context = { ...singleStore, members: [member({ active: false })] };
    expect(reasonFor(goodRow, context)).toContain('No active staff member has the email');
  });

  it('rejects bad times', () => {
    expect(reasonFor({ ...goodRow, Start: '9am' })).toContain('24-hour time');
    expect(reasonFor({ ...goodRow, End: '25:00' })).toContain('24-hour time');
  });

  it('rejects an end that is not after the start', () => {
    expect(reasonFor({ ...goodRow, Start: '17:00', End: '09:00' })).toContain('End must be after Start');
    expect(reasonFor({ ...goodRow, Start: '09:00', End: '09:00' })).toContain('End must be after Start');
  });

  it('rejects an unknown store', () => {
    expect(reasonFor({ ...goodRow, Store: 'Berbera' })).toContain('No active store is called');
  });

  it('demands a store when the shop has more than one', () => {
    const context = { ...singleStore, locations: [location(), location({ id: 'loc2', name: 'Berbera', isPrimary: false })] };
    expect(reasonFor({ ...goodRow, Store: '' }, context)).toContain('has to say which');
  });

  // An empty locationIds means "every store", so only an explicit assignment
  // can exclude someone.
  it('rejects a member who is not assigned to that store', () => {
    const context = {
      ...singleStore,
      members: [member({ locationIds: ['loc2'] })],
      locations: [location(), location({ id: 'loc2', name: 'Berbera', isPrimary: false })],
    };
    expect(reasonFor({ ...goodRow, Store: 'Main' }, context)).toContain('not assigned to Main');
  });

  it('accepts an unrestricted member at any store', () => {
    const context = {
      ...singleStore,
      locations: [location(), location({ id: 'loc2', name: 'Berbera', isPrimary: false })],
    };
    expect(parseScheduleRows(csv([{ ...goodRow, Store: 'Berbera' }]), context).rejected).toHaveLength(0);
  });

  it('rejects a row clashing with a stored shift', () => {
    const context = { ...singleStore, existingShifts: [shift()] };
    expect(reasonFor({ ...goodRow, Start: '12:00', End: '18:00' }, context)).toContain('already has a shift overlapping');
  });

  it('allows a row that starts exactly when a stored shift ends', () => {
    const context = { ...singleStore, existingShifts: [shift({ start: '09:00', end: '13:00' })] };
    expect(parseScheduleRows(csv([{ ...goodRow, Start: '13:00', End: '18:00' }]), context).rejected).toHaveLength(0);
  });

  // The second of two colliding rows can't see the first in the database.
  it('rejects a row clashing with an earlier row in the same file', () => {
    const { drafts, rejected } = parseScheduleRows(
      csv([
        { ...goodRow, Start: '09:00', End: '13:00' },
        { ...goodRow, Start: '12:00', End: '18:00' },
      ]),
      singleStore
    );
    expect(drafts).toHaveLength(1);
    expect(rejected[0].reason).toContain('overlaps another row in the file');
  });

  it('reports the spreadsheet row number, counting the header as row 1', () => {
    const { rejected } = parseScheduleRows(csv([goodRow, { ...goodRow, Date: 'nope' }]), singleStore);
    expect(rejected[0].row).toBe(3);
  });

  it('keeps the original row data for the rejected-rows download', () => {
    const bad = { ...goodRow, Date: 'nope' };
    expect(parseScheduleRows(csv([bad]), singleStore).rejected[0].data).toEqual(bad);
  });

  // A bad row must not take the good ones down with it.
  it('accepts the good rows around a bad one', () => {
    const { drafts, rejected } = parseScheduleRows(
      csv([goodRow, { ...goodRow, Date: 'nope' }, { ...goodRow, Date: '2026-08-12' }]),
      singleStore
    );
    expect(drafts).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });
});

// ─── The pre-filled template ─────────────────────────────────────────────

describe('scheduleTemplateRows', () => {
  const week = ['2026-08-10', '2026-08-11', '2026-08-12'];

  it('writes one row per person per day, with the dates and store filled in', () => {
    const rows = scheduleTemplateRows([member()], week, 'Main');
    expect(rows).toEqual([
      { Date: '2026-08-10', 'Staff Name': 'Hamse Jibril', 'Staff Email': 'hamse@example.com', Start: '', End: '', Store: 'Main', Note: '' },
      { Date: '2026-08-11', 'Staff Name': 'Hamse Jibril', 'Staff Email': 'hamse@example.com', Start: '', End: '', Store: 'Main', Note: '' },
      { Date: '2026-08-12', 'Staff Name': 'Hamse Jibril', 'Staff Email': 'hamse@example.com', Start: '', End: '', Store: 'Main', Note: '' },
    ]);
  });

  // A whole person's week together, rather than a whole day's staff together:
  // filling this in means going down one column for one person at a time.
  it('groups a person’s week together', () => {
    const rows = scheduleTemplateRows([member(), member({ id: 'm2', email: 'amina@example.com' })], week, 'Main');
    expect(rows.map((r) => r['Staff Email'])).toEqual([
      'hamse@example.com', 'hamse@example.com', 'hamse@example.com',
      'amina@example.com', 'amina@example.com', 'amina@example.com',
    ]);
  });

  it('leaves out people who are no longer active', () => {
    const rows = scheduleTemplateRows([member(), member({ id: 'm2', email: 'gone@example.com', active: false })], week, 'Main');
    expect(rows.every((r) => r['Staff Email'] === 'hamse@example.com')).toBe(true);
  });

  // Name is the parser's fallback identity, so someone with no email address
  // still gets usable rows instead of rows that can only be rejected.
  it('still writes rows for someone with no email', () => {
    const rows = scheduleTemplateRows([member({ email: null })], week, 'Main');
    expect(rows[0]).toMatchObject({ 'Staff Name': 'Hamse Jibril', 'Staff Email': '' });
  });
});

describe('parseScheduleRows — the blank days of a pre-filled template', () => {
  const blank = { Date: '2026-08-10', 'Staff Email': 'hamse@example.com', Start: '', End: '', Store: '', Note: '' };

  // The whole point of handing over a grid: the days someone is not working are
  // left empty, and empty is an answer, not a mistake.
  it('skips a row with no times at all, without rejecting it', () => {
    const { drafts, rejected } = parseScheduleRows(csv([blank]), singleStore);
    expect(drafts).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('imports the filled days out of a template and ignores the rest', () => {
    const rows = [blank, { ...blank, Date: '2026-08-11', Start: '09:00', End: '17:00' }, { ...blank, Date: '2026-08-12' }];
    const { drafts, rejected } = parseScheduleRows(csv(rows), singleStore);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].date).toBe('2026-08-11');
    expect(rejected).toEqual([]);
  });

  // Half-filled is a mistake, and stays one -- someone typed a start and got
  // distracted, which is not the same as leaving the day empty.
  it('still rejects a row with a start and no end', () => {
    const { rejected } = parseScheduleRows(csv([{ ...blank, Start: '09:00' }]), singleStore);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/End/);
  });
});
