import { membersActiveToday, onLeaveMemberIds, staleOpenShifts, sumDurationHours } from '@/lib/shift-hours';
import type { TimeEntry, TimeOffRequest } from '@/types/models';

const TODAY = new Date(2026, 7, 15, 11, 0, 0);

function makeEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  const start = new Date(2026, 7, 15, 9, 0, 0);
  return {
    id: 'e1',
    shopId: 'shop1',
    shopMemberId: 'm1',
    clockIn: start.toISOString(),
    clockOut: new Date(start.getTime() + 4 * 3_600_000).toISOString(),
    createdAt: start.toISOString(),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  return {
    id: 'r1',
    shopId: 'shop1',
    shopMemberId: 'm1',
    startDate: '2026-08-14',
    endDate: '2026-08-16',
    dateRanges: [{ startDate: '2026-08-14', endDate: '2026-08-16' }],
    reason: null,
    status: 'approved',
    requestedAt: '2026-08-01T00:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

describe('sumDurationHours', () => {
  it('adds completed shifts', () => {
    expect(sumDurationHours([makeEntry(), makeEntry({ id: 'e2' })])).toBe(8);
  });

  // An in-progress shift isn't hours worked yet — this exclusion is why stale
  // open shifts are worth flagging elsewhere.
  it('ignores open shifts', () => {
    expect(sumDurationHours([makeEntry(), makeEntry({ id: 'e2', clockOut: null })])).toBe(4);
  });
});

describe('onLeaveMemberIds', () => {
  it('includes someone whose approved leave covers today', () => {
    expect(onLeaveMemberIds([makeRequest()], TODAY).has('m1')).toBe(true);
  });

  it('includes the first and last day of leave', () => {
    expect(onLeaveMemberIds([makeRequest({ dateRanges: [{ startDate: '2026-08-15', endDate: '2026-08-15' }] })], TODAY).has('m1')).toBe(true);
  });

  it('excludes leave that has ended or not started', () => {
    expect(onLeaveMemberIds([makeRequest({ dateRanges: [{ startDate: '2026-08-01', endDate: '2026-08-05' }] })], TODAY).size).toBe(0);
    expect(onLeaveMemberIds([makeRequest({ dateRanges: [{ startDate: '2026-08-20', endDate: '2026-08-25' }] })], TODAY).size).toBe(0);
  });

  it('ignores requests that are not approved', () => {
    expect(onLeaveMemberIds([makeRequest({ status: 'pending' })], TODAY).size).toBe(0);
    expect(onLeaveMemberIds([makeRequest({ status: 'denied' })], TODAY).size).toBe(0);
  });

  // startDate/endDate are only the outer bounds; someone off for two separate
  // weeks is at work in between, and flattening to the bounds would wrongly
  // mark them absent.
  it('respects gaps between non-contiguous ranges', () => {
    const request = makeRequest({
      startDate: '2026-08-10',
      endDate: '2026-08-25',
      dateRanges: [
        { startDate: '2026-08-10', endDate: '2026-08-12' },
        { startDate: '2026-08-20', endDate: '2026-08-25' },
      ],
    });
    expect(onLeaveMemberIds([request], TODAY).size).toBe(0);
  });

  it('falls back to the outer bounds when no ranges are stored', () => {
    const request = makeRequest({ dateRanges: [], startDate: '2026-08-14', endDate: '2026-08-16' });
    expect(onLeaveMemberIds([request], TODAY).has('m1')).toBe(true);
  });
});

describe('staleOpenShifts', () => {
  it('flags a shift left open from an earlier day', () => {
    const yesterday = new Date(2026, 7, 14, 9, 0, 0);
    const stale = makeEntry({ id: 'stale', clockIn: yesterday.toISOString(), clockOut: null });
    expect(staleOpenShifts([stale], TODAY).map((e) => e.id)).toEqual(['stale']);
  });

  // Someone mid-shift right now is normal, not a problem to chase.
  it('leaves today’s open shift alone', () => {
    expect(staleOpenShifts([makeEntry({ clockOut: null })], TODAY)).toEqual([]);
  });

  it('ignores completed shifts', () => {
    expect(staleOpenShifts([makeEntry()], TODAY)).toEqual([]);
  });
});

describe('membersActiveToday', () => {
  it('counts distinct members who clocked in today', () => {
    const entries = [makeEntry({ shopMemberId: 'm1' }), makeEntry({ id: 'e2', shopMemberId: 'm1' }), makeEntry({ id: 'e3', shopMemberId: 'm2' })];
    expect(membersActiveToday(entries, TODAY)).toBe(2);
  });

  it('counts someone still on shift', () => {
    expect(membersActiveToday([makeEntry({ clockOut: null })], TODAY)).toBe(1);
  });

  it('ignores earlier days', () => {
    const yesterday = new Date(2026, 7, 14, 9, 0, 0);
    expect(membersActiveToday([makeEntry({ clockIn: yesterday.toISOString() })], TODAY)).toBe(0);
  });
});
