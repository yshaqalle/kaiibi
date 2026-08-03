import {
  accruedLaborCents,
  computePayrollDraft,
  draftTotalCents,
  periodDayCount,
  uncoveredDays,
} from '@/lib/payroll-reporting';
import type { PayrollRun, StaffMember, TimeEntry } from '@/types/models';

function makeMember(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'm1',
    shopId: 'shop1',
    userId: 'u1',
    roleId: 'r1',
    roleName: 'Cashier',
    active: true,
    fullName: 'Hodan Ali',
    email: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hireDate: '2026-01-01',
    payType: 'hourly',
    payRateCents: 500,
    ...overrides,
  };
}

// clockIn/clockOut on the same local day, `hours` apart.
function makeEntry(day: string, hours: number, overrides: Partial<TimeEntry> = {}): TimeEntry {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, 9, 0, 0);
  return {
    id: `${day}-${hours}`,
    shopId: 'shop1',
    shopMemberId: 'm1',
    clockIn: start.toISOString(),
    clockOut: new Date(start.getTime() + hours * 3_600_000).toISOString(),
    createdAt: start.toISOString(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<PayrollRun> = {}): PayrollRun {
  return {
    id: 'run1',
    shopId: 'shop1',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-07',
    status: 'posted',
    totalCents: 0,
    expenseId: null,
    postedAt: null,
    postedBy: null,
    createdBy: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('periodDayCount', () => {
  it('counts inclusively', () => {
    expect(periodDayCount('2026-08-01', '2026-08-07')).toBe(7);
    expect(periodDayCount('2026-08-01', '2026-08-01')).toBe(1);
    expect(periodDayCount('2026-08-01', '2026-08-31')).toBe(31);
  });
});

describe('computePayrollDraft', () => {
  it('pays hourly staff for hours actually clocked', () => {
    const lines = computePayrollDraft(
      [makeMember({ payRateCents: 500 })],
      [makeEntry('2026-08-03', 8), makeEntry('2026-08-04', 4)],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].hoursWorked).toBe(12);
    expect(lines[0].amountCents).toBe(6000);
    expect(lines[0].warning).toBeNull();
  });

  it('ignores hours worked outside the period', () => {
    const lines = computePayrollDraft(
      [makeMember()],
      [makeEntry('2026-07-25', 8), makeEntry('2026-08-03', 3)],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].hoursWorked).toBe(3);
  });

  // An in-progress shift isn't hours worked yet, but silently dropping it is
  // how someone gets underpaid without anyone noticing.
  it('excludes open shifts and says so', () => {
    const lines = computePayrollDraft(
      [makeMember()],
      [makeEntry('2026-08-03', 8), { ...makeEntry('2026-08-05', 0), clockOut: null }],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].hoursWorked).toBe(8);
    expect(lines[0].warning).toMatch(/still clocked in/);
  });

  it('flags an hourly member who clocked nothing', () => {
    const lines = computePayrollDraft([makeMember()], [], '2026-08-01', '2026-08-07');
    expect(lines[0].amountCents).toBe(0);
    expect(lines[0].warning).toMatch(/No hours clocked/);
  });

  it('flags a member with no pay rate rather than paying them zero silently', () => {
    const lines = computePayrollDraft([makeMember({ payRateCents: null, payType: null })], [], '2026-08-01', '2026-08-07');
    expect(lines[0].amountCents).toBe(0);
    expect(lines[0].warning).toMatch(/No pay rate/);
  });

  // Was 310000: the old code divided by a nominal 30 days, so a 31-day month
  // paid 31/30 of the monthly salary -- a 3.3% overpayment every long month.
  it('pays a salaried member exactly their monthly rate for a whole month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-31'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a short month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-02-01',
      '2026-02-28'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a 30-day month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-04-01',
      '2026-04-30'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  // Proration over an arbitrary stretch is an approximation, so it asks for a
  // human check instead of presenting a guess as fact.
  it('prorates a part-period salary against the real year and asks for a check', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-07'
    );
    // 300000 x 12 / 365 x 7, rounded once at the end.
    expect(lines[0].amountCents).toBe(69041);
    expect(lines[0].warning).toMatch(/Prorated for 7 days/);
  });

  // 'fixed' now means what its name says: the same amount every pay run,
  // whatever the period length. Previously it prorated like salary, which
  // made it salary under another name.
  it('pays a fixed member the same amount regardless of period length', () => {
    const short = computePayrollDraft(
      [makeMember({ payType: 'fixed', payRateCents: 50000 })],
      [],
      '2026-08-01',
      '2026-08-07'
    );
    const long = computePayrollDraft(
      [makeMember({ payType: 'fixed', payRateCents: 50000 })],
      [],
      '2026-08-01',
      '2026-08-31'
    );
    expect(short[0].amountCents).toBe(50000);
    expect(long[0].amountCents).toBe(50000);
    expect(short[0].warning).toBeNull();
    expect(long[0].warning).toBeNull();
  });

  // The guard rail on this whole change: hourly pay must be untouched.
  it('leaves hourly pay exactly as it was', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'hourly', payRateCents: 500 })],
      [makeEntry('2026-08-03', 8)],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].amountCents).toBe(4000);
    expect(lines[0].hoursWorked).toBe(8);
  });

  it('leaves out inactive staff', () => {
    const lines = computePayrollDraft([makeMember({ active: false })], [], '2026-08-01', '2026-08-07');
    expect(lines).toHaveLength(0);
  });

  it('freezes name, type and rate onto the line', () => {
    const lines = computePayrollDraft([makeMember({ fullName: 'Amran Mohamed', payRateCents: 750 })], [], '2026-08-01', '2026-08-07');
    expect(lines[0]).toMatchObject({ memberName: 'Amran Mohamed', payType: 'hourly', payRateCents: 750 });
  });
});

describe('draftTotalCents', () => {
  it('sums the lines', () => {
    expect(draftTotalCents([{ amountCents: 6000 }, { amountCents: 70000 }])).toBe(76000);
  });

  it('is zero for an empty run', () => {
    expect(draftTotalCents([])).toBe(0);
  });
});

// This is the logic that keeps accrued labour and posted payroll from ever
// counting the same day twice.
describe('uncoveredDays', () => {
  it('returns every day when nothing has been posted', () => {
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 3), [])).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('excludes days a posted run already covers', () => {
    const runs = [makeRun({ periodStart: '2026-08-01', periodEnd: '2026-08-02' })];
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 3), runs)).toEqual(['2026-08-03']);
  });

  // A draft hasn't paid anybody, so its days are still accruing.
  it('ignores draft runs', () => {
    const runs = [makeRun({ status: 'draft', periodStart: '2026-08-01', periodEnd: '2026-08-03' })];
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 3), runs)).toHaveLength(3);
  });

  it('handles two posted runs meeting end to end', () => {
    const runs = [
      makeRun({ id: 'a', periodStart: '2026-08-01', periodEnd: '2026-08-02' }),
      makeRun({ id: 'b', periodStart: '2026-08-03', periodEnd: '2026-08-04' }),
    ];
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 5), runs)).toEqual(['2026-08-05']);
  });

  it('handles a posted run that overhangs the range on both sides', () => {
    const runs = [makeRun({ periodStart: '2026-07-20', periodEnd: '2026-08-20' })];
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 5), runs)).toEqual([]);
  });

  it('handles a posted run covering the middle of the range', () => {
    const runs = [makeRun({ periodStart: '2026-08-02', periodEnd: '2026-08-03' })];
    expect(uncoveredDays(new Date(2026, 7, 1), new Date(2026, 7, 4), runs)).toEqual(['2026-08-01', '2026-08-04']);
  });
});

describe('accruedLaborCents', () => {
  const member = makeMember({ payRateCents: 500 });

  it('values hours on uncovered days', () => {
    const result = accruedLaborCents(
      [member],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      ['2026-08-01', '2026-08-02']
    );
    expect(result.hours).toBe(12);
    expect(result.accruedCents).toBe(6000);
  });

  // The invariant the whole accrual design rests on: once a run is posted,
  // its days stop accruing, so the expense row and the accrual can't overlap.
  it('drops to zero once every day is covered by a posted run', () => {
    const result = accruedLaborCents([member], [makeEntry('2026-08-01', 8)], []);
    expect(result.accruedCents).toBe(0);
  });

  it('counts only the uncovered portion', () => {
    const result = accruedLaborCents(
      [member],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 8)],
      ['2026-08-02']
    );
    expect(result.accruedCents).toBe(4000);
  });

  it('skips open shifts', () => {
    const result = accruedLaborCents([member], [{ ...makeEntry('2026-08-01', 0), clockOut: null }], ['2026-08-01']);
    expect(result.accruedCents).toBe(0);
  });

  // Prorating a salary across an arbitrary uncovered stretch would be a guess
  // dressed as a figure, so they're counted and left to the pay run.
  it('excludes salaried staff but reports how many', () => {
    const salaried = makeMember({ id: 'm2', payType: 'salary', payRateCents: 300000 });
    const result = accruedLaborCents([member, salaried], [makeEntry('2026-08-01', 8)], ['2026-08-01']);
    expect(result.accruedCents).toBe(4000);
    expect(result.salariedExcludedCount).toBe(1);
  });
});
