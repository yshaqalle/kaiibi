import { dailySalaryCents } from '@/lib/pay-rate';
import { isWholePayPeriod, perPaymentCents, type PayCadence } from '@/lib/pay-periods';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import { sumDurationHours } from '@/lib/shift-hours';
import type { PayrollRun, StaffMember, TimeEntry } from '@/types/models';

// Pure payroll arithmetic: hours and pay rates in, draft money out. Separate
// from payroll.ts so it can be unit-tested without the Supabase client.

export type PayrollDraftLine = {
  shopMemberId: string;
  memberName: string | null;
  payType: StaffMember['payType'];
  payRateCents: number | null;
  hoursWorked: number | null;
  amountCents: number;
  // Set when the figure needs a human decision rather than being wrong --
  // surfaced in the editor so it's corrected before posting, not after.
  warning: string | null;
  // Only a warning that means the money is *wrong* -- currently just a missing
  // pay rate, which pays zero -- blocks a post. An approximate figure is
  // displayed and left to the owner's judgement.
  warningBlocking: boolean;
};

const MS_PER_DAY = 86_400_000;

// Inclusive, in whole local days: a run covering the 1st to the 7th is 7 days.
export function periodDayCount(periodStart: string, periodEnd: string): number {
  const start = fromDateColumn(periodStart).getTime();
  const end = fromDateColumn(periodEnd).getTime();
  return Math.max(1, Math.round((end - start) / MS_PER_DAY) + 1);
}

export function computePayrollDraft(
  members: StaffMember[],
  entries: TimeEntry[],
  periodStart: string,
  periodEnd: string,
  cadence: PayCadence | null,
  anchor: string | null
): PayrollDraftLine[] {
  const days = periodDayCount(periodStart, periodEnd);
  const entriesByMember = groupEntriesByMember(entries, periodStart, periodEnd);

  return members
    // A cadence-less run is off-cycle over hand-typed dates and covers
    // everyone; a cadence run must not sweep in a member paid on a different
    // rhythm, or their whole month lands inside someone else's week.
    .filter((member) => member.active && (cadence === null || member.payCadence === cadence))
    .map((member) => {
      const memberEntries = entriesByMember.get(member.id) ?? [];
      // Open shifts are excluded by sumDurationHours -- an in-progress shift
      // isn't hours worked yet, and paying for it would be guessing.
      const hoursWorked = Number(sumDurationHours(memberEntries).toFixed(2));
      const openShiftCount = memberEntries.filter((e) => !e.clockOut).length;

      const base: Omit<PayrollDraftLine, 'amountCents' | 'warning' | 'warningBlocking'> = {
        shopMemberId: member.id,
        memberName: member.fullName,
        payType: member.payType,
        payRateCents: member.payRateCents,
        hoursWorked: member.payType === 'hourly' ? hoursWorked : null,
      };

      if (member.payRateCents === null || member.payType === null) {
        return {
          ...base,
          amountCents: 0,
          warning: 'No pay rate set — add one in People, or enter the amount here.',
          warningBlocking: true,
        };
      }

      if (member.payType === 'hourly') {
        const amountCents = Math.round(member.payRateCents * hoursWorked);
        let warning: string | null = null;
        if (openShiftCount > 0) {
          warning = `${openShiftCount} shift${openShiftCount === 1 ? '' : 's'} still clocked in — those hours aren't included.`;
        } else if (hoursWorked === 0) {
          warning = 'No hours clocked in this period.';
        }
        return { ...base, amountCents, warning, warningBlocking: false };
      }

      // Flat per pay run, whatever the period length -- that is what makes
      // 'fixed' a different thing from 'salary' rather than a second name
      // for it. A stipend or allowance is the case this serves.
      if (member.payType === 'fixed') {
        return { ...base, amountCents: member.payRateCents, warning: null, warningBlocking: false };
      }

      // A run matching the member's own cadence period pays the exact
      // per-payment figure -- no proration, nothing for a human to check.
      const memberCadence = cadence ?? member.payCadence;
      if (isWholePayPeriod(memberCadence, anchor, periodStart, periodEnd)) {
        return {
          ...base,
          amountCents: perPaymentCents(member.payRateCents, memberCadence),
          warning: null,
          warningBlocking: false,
        };
      }

      // Anything else is a genuine part period. Spread across the real year
      // rather than a nominal 30-day month, so month length can't distort it,
      // and round once at the end.
      const year = fromDateColumn(periodStart).getFullYear();
      const amountCents = Math.round(dailySalaryCents(member.payRateCents, year) * days);
      return {
        ...base,
        amountCents,
        warning: `Prorated for ${days} day${days === 1 ? '' : 's'} — check this figure.`,
        warningBlocking: false,
      };
    });
}

export function draftTotalCents(lines: { amountCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

// Days each member has already been paid for. Derived from each run's LINES,
// not its period: once runs are per-member, a run that paid Bob says nothing
// about whether Alice has been paid, and reading coverage off the period alone
// would silently under-report her accrual.
function coveredDaysByMember(postedRuns: PayrollRun[]): Map<string, Set<string>> {
  const covered = new Map<string, Set<string>>();
  for (const run of postedRuns) {
    if (run.status !== 'posted') continue;
    const days: string[] = [];
    let cursor = fromDateColumn(run.periodStart).getTime();
    const end = fromDateColumn(run.periodEnd).getTime();
    while (cursor <= end) {
      days.push(toDateColumn(new Date(cursor)));
      cursor += MS_PER_DAY;
    }
    for (const line of run.lines ?? []) {
      let memberDays = covered.get(line.shopMemberId);
      if (!memberDays) {
        memberDays = new Set<string>();
        covered.set(line.shopMemberId, memberDays);
      }
      for (const day of days) memberDays.add(day);
    }
  }
  return covered;
}

// Labour worked or earned on days no posted run covers -- the accrual figure.
// This is what makes accrued-but-unpaid labour safe to add to the P&L: the
// moment a run is posted, its days drop out for the members it paid and its
// expense row takes over, so the two can never both count the same day.
//
// Salaried staff accrue by day, using the same exact per-day figure the draft
// prorates with. 'fixed' staff don't: a flat amount per pay run has no daily
// rate to derive, and inventing one would be a guess presented as a number.
export function accruedLaborCents(
  members: StaffMember[],
  entries: TimeEntry[],
  since: Date,
  until: Date,
  postedRuns: PayrollRun[]
): { accruedCents: number; hours: number; fixedExcludedCount: number } {
  const covered = coveredDaysByMember(postedRuns);
  const memberById = new Map(members.map((member) => [member.id, member]));

  const rangeDays: string[] = [];
  let cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime();
  const last = new Date(until.getFullYear(), until.getMonth(), until.getDate()).getTime();
  while (cursor <= last) {
    rangeDays.push(toDateColumn(new Date(cursor)));
    cursor += MS_PER_DAY;
  }
  // A Set for the per-entry membership test below: a year-long range against a
  // busy shop's time entries makes a linear scan per entry needlessly quadratic.
  const rangeDaySet = new Set(rangeDays);

  let accruedCents = 0;
  let hours = 0;

  for (const entry of entries) {
    if (!entry.clockOut) continue;
    const member = memberById.get(entry.shopMemberId);
    if (!member || member.payType !== 'hourly' || member.payRateCents === null) continue;
    const day = toDateColumn(new Date(entry.clockIn));
    if (!rangeDaySet.has(day)) continue;
    if (covered.get(member.id)?.has(day)) continue;
    const entryHours = sumDurationHours([entry]);
    hours += entryHours;
    accruedCents += Math.round(member.payRateCents * entryHours);
  }

  for (const member of members) {
    if (!member.active || member.payType !== 'salary' || member.payRateCents === null) continue;
    const memberCovered = covered.get(member.id);
    const uncovered = rangeDays.filter((day) => !memberCovered?.has(day));
    if (uncovered.length === 0) continue;
    const year = fromDateColumn(uncovered[0]).getFullYear();
    accruedCents += Math.round(dailySalaryCents(member.payRateCents, year) * uncovered.length);
  }

  const fixedExcludedCount = members.filter(
    (member) => member.active && member.payRateCents !== null && member.payType === 'fixed'
  ).length;

  return { accruedCents, hours: Number(hours.toFixed(2)), fixedExcludedCount };
}

function groupEntriesByMember(entries: TimeEntry[], periodStart: string, periodEnd: string): Map<string, TimeEntry[]> {
  const start = fromDateColumn(periodStart).getTime();
  const end = fromDateColumn(periodEnd).getTime() + MS_PER_DAY - 1;
  const grouped = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const clockIn = new Date(entry.clockIn).getTime();
    if (clockIn < start || clockIn > end) continue;
    const existing = grouped.get(entry.shopMemberId);
    if (existing) existing.push(entry);
    else grouped.set(entry.shopMemberId, [entry]);
  }
  return grouped;
}
