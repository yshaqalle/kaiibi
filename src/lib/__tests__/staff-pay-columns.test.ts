import { parseStaffPayColumns } from '@/lib/staff-pay-columns';

describe('parseStaffPayColumns', () => {
  it('reports nothing to do when no pay columns are present', () => {
    expect(parseStaffPayColumns({ 'Full Name': 'Hodan Ali' })).toEqual({ kind: 'none' });
  });

  it('treats blank pay columns as nothing to do', () => {
    expect(parseStaffPayColumns({ 'Pay Type': '  ', 'Pay Rate': '', 'Pay Cadence': '' })).toEqual({ kind: 'none' });
  });

  // The export actually writes formatCents ("$3000.00", no thousands
  // separator) -- this feeds a harder string with a comma to prove toCents
  // strips it defensively, in case a user hand-edits the exported file.
  it('parses the exact string the export writes', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'salary', 'Pay Rate': '$3,000.00', 'Pay Rate Unit': 'per month' })).toEqual({
      kind: 'ok',
      patch: { payType: 'salary', payRateCents: 300000, payCadence: 'monthly' },
    });
  });

  it('reads the cadence when present', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '$8.50', 'Pay Cadence': 'biweekly' })).toEqual({
      kind: 'ok',
      patch: { payType: 'hourly', payRateCents: 850, payCadence: 'biweekly' },
    });
  });

  // pay_cadence is NOT NULL in the database, so an absent value must resolve to
  // the schema default rather than to null.
  it('defaults a missing cadence to monthly', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '8.50' });
    expect(result).toEqual({ kind: 'ok', patch: { payType: 'hourly', payRateCents: 850, payCadence: 'monthly' } });
  });

  it('is case-insensitive about pay type and cadence', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'Salary', 'Pay Cadence': 'Monthly', 'Pay Rate': '3000' })).toEqual({
      kind: 'ok',
      patch: { payType: 'salary', payRateCents: 300000, payCadence: 'monthly' },
    });
  });

  it('allows a pay type with no rate yet', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly' })).toEqual({
      kind: 'ok',
      patch: { payType: 'hourly', payRateCents: null, payCadence: 'monthly' },
    });
  });

  it('rejects an unknown pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'contractor', 'Pay Rate': '10' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Type/);
  });

  it('rejects an unknown cadence', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '10', 'Pay Cadence': 'fortnightly' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Cadence/);
  });

  it('rejects an unparseable rate rather than silently storing zero', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': 'ten dollars' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Rate/);
  });

  it('rejects a rate given without a pay type, which would have no unit', () => {
    const result = parseStaffPayColumns({ 'Pay Rate': '3000' });
    expect(result).toMatchObject({ kind: 'error' });
  });

  // The export writes Pay Cadence for every member (pay_cadence is NOT NULL),
  // but leaves Pay Type/Rate/Unit blank for anyone with no pay set -- the
  // default for every freshly provisioned member. Re-importing that exact
  // exported row must round-trip, not get rejected as "rate without a type".
  it('round-trips the row the export writes for a pay-less member', () => {
    const result = parseStaffPayColumns({ 'Pay Type': '', 'Pay Rate': '', 'Pay Rate Unit': '', 'Pay Cadence': 'monthly' });
    expect(result).toEqual({
      kind: 'ok',
      patch: { payType: null, payRateCents: null, payCadence: 'monthly' },
    });
  });

  it('accepts a non-default cadence given with no pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Cadence': 'weekly' });
    expect(result).toEqual({
      kind: 'ok',
      patch: { payType: null, payRateCents: null, payCadence: 'weekly' },
    });
  });

  it('still rejects an invalid cadence given with no pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Cadence': 'fortnightly' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Cadence/);
  });

  // The unit is informational and never converts. A file claiming "per hour"
  // beside a salary is self-contradictory, and guessing which half is right
  // would silently misstate someone's pay.
  it('rejects a unit that contradicts the pay type', () => {
    const result = parseStaffPayColumns({ 'Pay Type': 'salary', 'Pay Rate': '3000', 'Pay Rate Unit': 'per hour' });
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { reason: string }).reason).toMatch(/Pay Rate Unit/);
  });

  it('accepts a matching unit', () => {
    expect(parseStaffPayColumns({ 'Pay Type': 'hourly', 'Pay Rate': '8.50', 'Pay Rate Unit': 'per hour' })).toMatchObject({
      kind: 'ok',
    });
  });
});
