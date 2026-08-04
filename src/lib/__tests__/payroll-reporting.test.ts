import {
  accruedLaborCents,
  computePayrollDraft,
  draftTotalCents,
  periodDayCount,
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
    payCadence: 'monthly',
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
      '2026-08-07',
      null,
      null
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
      '2026-08-07',
      null,
      null
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
      '2026-08-07',
      null,
      null
    );
    expect(lines[0].hoursWorked).toBe(8);
    expect(lines[0].warning).toMatch(/still clocked in/);
  });

  it('flags an hourly member who clocked nothing', () => {
    const lines = computePayrollDraft([makeMember()], [], '2026-08-01', '2026-08-07', null, null);
    expect(lines[0].amountCents).toBe(0);
    expect(lines[0].warning).toMatch(/No hours clocked/);
  });

  it('flags a member with no pay rate rather than paying them zero silently', () => {
    const lines = computePayrollDraft(
      [makeMember({ payRateCents: null, payType: null })],
      [],
      '2026-08-01',
      '2026-08-07',
      null,
      null
    );
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
      '2026-08-31',
      null,
      null
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a short month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-02-01',
      '2026-02-28',
      null,
      null
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a 30-day month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-04-01',
      '2026-04-30',
      null,
      null
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
      '2026-08-07',
      null,
      null
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
      '2026-08-07',
      null,
      null
    );
    const long = computePayrollDraft(
      [makeMember({ payType: 'fixed', payRateCents: 50000 })],
      [],
      '2026-08-01',
      '2026-08-31',
      null,
      null
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
      '2026-08-07',
      null,
      null
    );
    expect(lines[0].amountCents).toBe(4000);
    expect(lines[0].hoursWorked).toBe(8);
  });

  it('leaves out inactive staff', () => {
    const lines = computePayrollDraft([makeMember({ active: false })], [], '2026-08-01', '2026-08-07', null, null);
    expect(lines).toHaveLength(0);
  });

  it('freezes name, type and rate onto the line', () => {
    const lines = computePayrollDraft(
      [makeMember({ fullName: 'Amran Mohamed', payRateCents: 750 })],
      [],
      '2026-08-01',
      '2026-08-07',
      null,
      null
    );
    expect(lines[0]).toMatchObject({ memberName: 'Amran Mohamed', payType: 'hourly', payRateCents: 750 });
  });

  // A missing pay rate produces a zero amount -- a real person paid nothing.
  // That is a different kind of problem from an approximate figure, and is the
  // only warning allowed to block a post.
  it('marks a missing pay rate as blocking', () => {
    const lines = computePayrollDraft(
      [makeMember({ payRateCents: null, payType: null })],
      [],
      '2026-08-01',
      '2026-08-07',
      null,
      null
    );
    expect(lines[0].warning).toMatch(/No pay rate/);
    expect(lines[0].warningBlocking).toBe(true);
  });

  it('leaves an open-shift warning advisory', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'hourly', payRateCents: 500 })],
      [{ ...makeEntry('2026-08-03', 0), clockOut: null }],
      '2026-08-01',
      '2026-08-07',
      null,
      null
    );
    expect(lines[0].warning).toMatch(/still clocked in/);
    expect(lines[0].warningBlocking).toBe(false);
  });

  it('leaves a proration warning advisory', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-07',
      null,
      null
    );
    expect(lines[0].warning).toMatch(/Prorated/);
    expect(lines[0].warningBlocking).toBe(false);
  });

  it('is not blocking when there is nothing to warn about', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-31',
      null,
      null
    );
    expect(lines[0].warning).toBeNull();
    expect(lines[0].warningBlocking).toBe(false);
  });

  // The headline guarantee of this change: adding cadence must not move the
  // figure a monthly member already gets for a calendar month.
  it('pays a monthly-cadence member the same as before for a calendar month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'monthly' })],
      [],
      '2026-08-01',
      '2026-08-31',
      'monthly',
      null
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays half a month for a whole semi-monthly period', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'semimonthly' })],
      [],
      '2026-08-01',
      '2026-08-15',
      'semimonthly',
      null
    );
    expect(lines[0].amountCents).toBe(150000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays a whole biweekly period from the anchor', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'biweekly' })],
      [],
      '2026-08-03',
      '2026-08-16',
      'biweekly',
      '2026-08-03'
    );
    expect(lines[0].amountCents).toBe(138462);
    expect(lines[0].warning).toBeNull();
  });

  // A run that doesn't line up with the cadence is still an approximation and
  // still asks for a human check.
  it('prorates and warns when the run is not a whole period', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'monthly' })],
      [],
      '2026-08-01',
      '2026-08-07',
      'monthly',
      null
    );
    expect(lines[0].amountCents).toBe(69041);
    expect(lines[0].warning).toMatch(/Prorated for 7 days/);
  });

  it('includes only members on the run cadence', () => {
    const lines = computePayrollDraft(
      [
        makeMember({ id: 'weekly-1', payCadence: 'weekly' }),
        makeMember({ id: 'monthly-1', payCadence: 'monthly' }),
      ],
      [],
      '2026-08-01',
      '2026-08-31',
      'monthly',
      null
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].shopMemberId).toBe('monthly-1');
  });

  it('includes every active member when the run has no cadence', () => {
    const lines = computePayrollDraft(
      [
        makeMember({ id: 'weekly-1', payCadence: 'weekly' }),
        makeMember({ id: 'monthly-1', payCadence: 'monthly' }),
      ],
      [],
      '2026-08-01',
      '2026-08-31',
      null,
      null
    );
    expect(lines).toHaveLength(2);
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

function makeRun(
  periodStart: string,
  periodEnd: string,
  memberIds: string[],
  status: PayrollRun['status'] = 'posted'
): PayrollRun {
  return {
    id: `${periodStart}-${periodEnd}`,
    shopId: 'shop1',
    periodStart,
    periodEnd,
    status,
    cadence: null,
    totalCents: 0,
    expenseId: null,
    postedAt: null,
    postedBy: null,
    createdBy: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lines: memberIds.map((memberId, index) => ({
      id: `${periodStart}-${memberId}-${index}`,
      payrollRunId: `${periodStart}-${periodEnd}`,
      shopMemberId: memberId,
      memberName: memberId,
      payType: 'hourly' as const,
      payRateCents: 500,
      hoursWorked: null,
      amountCents: 1000,
      note: null,
      warning: null,
      warningBlocking: false,
      createdAt: '2026-08-01T00:00:00.000Z',
    })),
  };
}

describe('accruedLaborCents', () => {
  const hourly = makeMember({ id: 'm1', payType: 'hourly', payRateCents: 500 });
  const since = new Date(2026, 7, 1);
  const until = new Date(2026, 7, 3);

  it('values hours on days no posted run covers', () => {
    const result = accruedLaborCents(
      [hourly],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      since,
      until,
      []
    );
    expect(result.hours).toBe(12);
    expect(result.accruedCents).toBe(6000);
  });

  // The invariant the whole accrual design rests on: once a run is posted, its
  // days stop accruing, so the expense row and the accrual can't overlap.
  it('drops the days a posted run covers for that member', () => {
    const runs = [makeRun('2026-08-01', '2026-08-01', ['m1'])];
    const result = accruedLaborCents(
      [hourly],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      since,
      until,
      runs
    );
    expect(result.accruedCents).toBe(2000);
  });

  // The reason coverage had to become per-member: a run that paid Bob says
  // nothing about whether Alice has been paid.
  it('does not let one member’s run cover another member', () => {
    const alice = makeMember({ id: 'alice', payType: 'hourly', payRateCents: 500 });
    const runs = [makeRun('2026-08-01', '2026-08-01', ['bob'])];
    const result = accruedLaborCents(
      [alice],
      [makeEntry('2026-08-01', 8, { shopMemberId: 'alice' })],
      since,
      until,
      runs
    );
    expect(result.accruedCents).toBe(4000);
  });

  it('ignores a draft run', () => {
    const runs = [makeRun('2026-08-01', '2026-08-01', ['m1'], 'draft')];
    const result = accruedLaborCents([hourly], [makeEntry('2026-08-01', 8)], since, until, runs);
    expect(result.accruedCents).toBe(4000);
  });

  it('skips open shifts', () => {
    const result = accruedLaborCents(
      [hourly],
      [{ ...makeEntry('2026-08-01', 0), clockOut: null }],
      since,
      until,
      []
    );
    expect(result.accruedCents).toBe(0);
  });

  // Salaried staff accrue now that dailySalaryCents gives an exact per-day
  // figure. 300000/mo x 12 / 365 = 9863.0137/day, x 3 uncovered days.
  it('accrues salaried staff by day', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.accruedCents).toBe(29589);
    expect(result.hours).toBe(0);
  });

  it('stops accruing a salaried member once a run covers the days', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const runs = [makeRun('2026-08-01', '2026-08-03', ['s1'])];
    const result = accruedLaborCents([salaried], [], since, until, runs);
    expect(result.accruedCents).toBe(0);
  });

  // 'fixed' is a flat amount per run, so there is no daily rate to derive.
  // Inventing one would be a guess presented as a number.
  it('excludes fixed-pay staff but reports how many', () => {
    const fixed = makeMember({ id: 'f1', payType: 'fixed', payRateCents: 50000 });
    const result = accruedLaborCents([hourly, fixed], [makeEntry('2026-08-01', 8)], since, until, []);
    expect(result.accruedCents).toBe(4000);
    expect(result.fixedExcludedCount).toBe(1);
  });

  it('ignores inactive staff when counting exclusions', () => {
    const fixed = makeMember({ id: 'f1', payType: 'fixed', payRateCents: 50000, active: false });
    const result = accruedLaborCents([fixed], [], since, until, []);
    expect(result.fixedExcludedCount).toBe(0);
  });

  // Discriminates rounding order: a broken implementation that rounds the
  // daily rate first and then multiplies (9864) must fail against the
  // correct round-once-at-the-end figure (9863). 300000/mo over the same 3
  // days can't tell the two apart -- both give 29589 -- which is exactly why
  // a mutation of the rounding survived the suite until this test was added.
  // 100000/mo x 12 / 365 = 3287.671.../day, x 3 uncovered days = 9863.013...,
  // rounded once = 9863. Rounding the daily rate first gives round(3287.671)
  // = 3288, x 3 = 9864.
  it('rounds the salaried accrual once at the end, not per day', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 100000 });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.accruedCents).toBe(9863);
  });

  // hireDate bounds the accrual the same way a posted run does: a day before
  // someone started isn't labour they performed, so it can't accrue. Hired
  // partway through the 3-day range (Aug 1-3), so only Aug 2 and Aug 3
  // accrue: 9863.013.../day x 2, rounded once = 19726.
  it('does not accrue a salaried member for days before their hire date', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000, hireDate: '2026-08-02' });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.accruedCents).toBe(19726);
  });

  // An inactive salaried member is excluded from accrual entirely, not just
  // undercounted -- the existing inactive-staff test only ever used a
  // `fixed` member and asserted the exclusion count, never the money, so
  // this path was untested.
  it('accrues nothing for an inactive salaried member', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000, active: false });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.accruedCents).toBe(0);
  });

  // `PayrollRun.lines` is optional and the code falls back to `run.lines ??
  // []`; a posted run with no lines recorded covers nobody, not everybody.
  it('treats a posted run with an empty lines array as covering nobody', () => {
    const runs = [makeRun('2026-08-01', '2026-08-01', [])];
    const result = accruedLaborCents(
      [hourly],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      since,
      until,
      runs
    );
    expect(result.accruedCents).toBe(6000);
  });

  // Discriminates the mutation where nonHourlyCount was replaced with
  // fixedExcludedCount -- in an all-salaried shop, that mutation would
  // wrongly suppress the hours caveat because nonHourlyCount would be 0
  // instead of 1.
  it('counts salaried members in nonHourlyCount even when no fixed staff exist', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.nonHourlyCount).toBe(1);
    expect(result.fixedExcludedCount).toBe(0);
  });

  // Confirms that both counts track correctly in a mixed-pay shop: salaried
  // and fixed both contribute to nonHourlyCount, but only fixed contributes to
  // fixedExcludedCount.
  it('counts salaried and fixed separately in a mixed shop', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const fixed = makeMember({ id: 'f1', payType: 'fixed', payRateCents: 50000 });
    const result = accruedLaborCents([salaried, fixed], [], since, until, []);
    expect(result.nonHourlyCount).toBe(2);
    expect(result.fixedExcludedCount).toBe(1);
  });

  // Inactive salaried staff are excluded from both counts, so they do not
  // appear in either caveat.
  it('excludes inactive salaried members from both counts', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000, active: false });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.nonHourlyCount).toBe(0);
    expect(result.fixedExcludedCount).toBe(0);
  });

  // Regression for DST-unsafe millisecond day-stepping. Clocks in
  // America/New_York (the suite's pinned zone -- see jest.config.js) fall
  // back on Nov 1, 2026. Stepping the posted run's Nov 1-30 day list by raw
  // `+= MS_PER_DAY` crosses that boundary and lands an hour short each day
  // after it, so the loop emits a duplicate mid-range day instead of ever
  // reaching Nov 30 -- the run's own period_end then never enters the
  // covered set, and Nov 30 (already inside the posted expense) accrues a
  // second time alongside the real uncovered days.
  //
  // Correct: Nov 1-30 posted covers 30 days, so within the Nov 15-Dec 15
  // accrual range only Dec 1-15 (15 days) is uncovered.
  // dailySalaryCents(300000, 2026) = 300000 x 12 / 365 = 9863.013698.../day,
  // x 15 days = 147945.205..., rounded once = 147945.
  it('steps day-by-day across a DST fall-back without double-counting the covered range', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const runs = [makeRun('2026-11-01', '2026-11-30', ['s1'])];
    const result = accruedLaborCents(
      [salaried],
      [],
      new Date(2026, 10, 15),
      new Date(2026, 11, 15),
      runs
    );
    expect(result.accruedCents).toBe(147945);
  });
});
