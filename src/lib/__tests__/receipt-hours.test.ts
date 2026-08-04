import { formatTodayHours } from '@/lib/receipt';
import type { OpeningHours } from '@/lib/store-hours';

// Only the hours line is covered here. The rest of receipt.ts formats money and
// item lines that predate this file; this exists because the hours line is the
// one part that depends on *when* it is rendered, which is exactly what made it
// print the wrong day.

const OPEN_ALL_WEEK: OpeningHours = {
  mon: [{ open: '09:00', close: '18:00' }],
  tue: [{ open: '09:00', close: '18:00' }],
  wed: [{ open: '09:00', close: '18:00' }],
  thu: [{ open: '09:00', close: '18:00' }],
  fri: [{ open: '09:00', close: '18:00' }],
  sat: [{ open: '09:00', close: '18:00' }],
  sun: [{ open: '09:00', close: '18:00' }],
};

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

describe('formatTodayHours', () => {
  it('prints the hours for a receipt dated today', () => {
    expect(formatTodayHours(OPEN_ALL_WEEK, new Date())).toBe('Open today 09:00 – 18:00');
  });

  // The bug this test exists for: buildReceiptFromSale used `new Date()`, so
  // reprinting an old sale printed TODAY's hours under the sale's own date --
  // and once emailed or saved as a PDF that string froze and went stale.
  it('prints nothing for a receipt dated any other day', () => {
    expect(formatTodayHours(OPEN_ALL_WEEK, daysAgo(1))).toBeNull();
    expect(formatTodayHours(OPEN_ALL_WEEK, daysAgo(7))).toBeNull();
  });

  it('prints nothing when the shop has never set hours', () => {
    expect(formatTodayHours({}, new Date())).toBeNull();
    expect(formatTodayHours(undefined, new Date())).toBeNull();
  });

  // 'Closed' on a receipt would be absurd -- it is proof of a sale that just
  // happened -- so the closed case is a missing line, not a printed word.
  it('prints nothing rather than "Closed" when today has no hours', () => {
    const closedEveryDay: OpeningHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(formatTodayHours(closedEveryDay, new Date())).toBeNull();
  });
});
