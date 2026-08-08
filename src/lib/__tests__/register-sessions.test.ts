import {
  BASE_CURRENCY,
  OTHER_DENOMINATION,
  assembleRun,
  canCloseSession,
  cashMovementsByCurrency,
  combinedVarianceBaseCents,
  currenciesToCount,
  denominationsFor,
  expectedMinor,
  formatSessionRange,
  formatSessionWindow,
  fxDriftBaseCents,
  paymentBreakdown,
  tallyTotalMinor,
  totalFxDriftBaseCents,
  varianceMinor,
  varianceTone,
} from '@/lib/register-sessions';
import type { PaymentLine, RegisterSession, RegisterSessionCash } from '@/types/models';

function payment(over: Partial<PaymentLine>): PaymentLine {
  return {
    method: 'cash',
    amountCents: 0,
    tenderedCents: null,
    customerName: null,
    customerPhone: null,
    currencyCode: null,
    exchangeRate: null,
    foreignAmountCents: null,
    foreignChangeCents: null,
    ...over,
  };
}

function cashRow(over: Partial<RegisterSessionCash>): RegisterSessionCash {
  return {
    id: 'row',
    sessionId: 'session',
    currencyCode: BASE_CURRENCY,
    openingFloatMinor: 0,
    openingRateToUsd: 1,
    closingCountedMinor: null,
    closingRateToUsd: null,
    expectedMinor: null,
    varianceMinor: null,
    openingDenominations: null,
    closingDenominations: null,
    ...over,
  };
}

describe('cashMovementsByCurrency', () => {
  it('sums plain cash into the base bucket', () => {
    const movements = cashMovementsByCurrency([
      payment({ amountCents: 1000 }),
      payment({ amountCents: 500 }),
    ]);
    expect(movements).toEqual({ USD: 1500 });
  });

  it('counts exact-tender cash in full, even though tenderedCents is null', () => {
    // tenderedCents is only written when change was given, so it is null here.
    // Summing it instead of amountCents would lose this sale entirely.
    const movements = cashMovementsByCurrency([payment({ amountCents: 2500, tenderedCents: null })]);
    expect(movements).toEqual({ USD: 2500 });
  });

  it('counts what stayed in the drawer, not what was handed over', () => {
    const movements = cashMovementsByCurrency([payment({ amountCents: 1000, tenderedCents: 2000 })]);
    expect(movements).toEqual({ USD: 1000 });
  });

  it('ignores non-cash tenders entirely', () => {
    const movements = cashMovementsByCurrency([
      payment({ method: 'zaad', amountCents: 41200 }),
      payment({ method: 'edahab', amountCents: 9650 }),
      payment({ method: 'other', amountCents: 100 }),
    ]);
    expect(movements).toEqual({});
  });

  // The regression that mattered most: an earlier draft summed amountCents over
  // every cash line regardless of currency, which counted a shilling sale twice
  // — once as dollars that were never in the drawer, and again as the shillings
  // that were.
  it('keeps foreign cash out of the base bucket', () => {
    const movements = cashMovementsByCurrency([
      payment({ amountCents: 1000 }),
      payment({
        amountCents: 1000, // the USD equivalent applied to the sale
        currencyCode: 'SLSH',
        exchangeRate: 115,
        foreignAmountCents: 200000,
        foreignChangeCents: 85000,
      }),
    ]);
    expect(movements.USD).toBe(1000);
    expect(movements.SLSH).toBe(115000);
  });

  it('nets foreign change back out of its own pile', () => {
    const movements = cashMovementsByCurrency([
      payment({ amountCents: 1000, currencyCode: 'SLSH', foreignAmountCents: 200000, foreignChangeCents: 85000 }),
      payment({ amountCents: 500, currencyCode: 'SLSH', foreignAmountCents: 60000, foreignChangeCents: null }),
    ]);
    expect(movements.SLSH).toBe(115000 + 60000);
  });
});

describe('expectedMinor / varianceMinor', () => {
  it('is float plus what came in', () => {
    expect(expectedMinor(11850, 34700)).toBe(46550);
  });

  it('goes negative when more cash left than arrived', () => {
    expect(expectedMinor(0, -1200)).toBe(-1200);
  });

  it('reports short as negative and over as positive', () => {
    expect(varianceMinor(44850, 45350)).toBe(-500);
    expect(varianceMinor(45550, 45350)).toBe(200);
    expect(varianceMinor(45350, 45350)).toBe(0);
  });

  it('tones a variance by direction', () => {
    expect(varianceTone(-500)).toBe('short');
    expect(varianceTone(200)).toBe('over');
    expect(varianceTone(0)).toBe('balanced');
  });
});

describe('combinedVarianceBaseCents', () => {
  it('converts each variance at its own closing rate before summing', () => {
    const total = combinedVarianceBaseCents([
      cashRow({ currencyCode: 'USD', varianceMinor: -500, closingRateToUsd: 1 }),
      cashRow({ currencyCode: 'SLSH', varianceMinor: -11800, closingRateToUsd: 118 }),
    ]);
    expect(total).toBe(-600); // -500 plus -11800/118 = -100
  });

  it('is zero when every currency balances', () => {
    const total = combinedVarianceBaseCents([
      cashRow({ currencyCode: 'USD', varianceMinor: 0, closingRateToUsd: 1 }),
      cashRow({ currencyCode: 'SLSH', varianceMinor: 0, closingRateToUsd: 118 }),
    ]);
    expect(total).toBe(0);
  });

  it('falls back to the opening rate when a session was never closed', () => {
    const total = combinedVarianceBaseCents([
      cashRow({ currencyCode: 'SLSH', varianceMinor: -11500, openingRateToUsd: 115, closingRateToUsd: null }),
    ]);
    expect(total).toBe(-100);
  });

  // THE HEADLINE. This is the regression test for the whole design: the same
  // drawer, the same counts, at two different rates must produce the same
  // verdict. It passes because the per-currency variances are differenced
  // BEFORE any conversion happens. Converting the balances and differencing
  // those instead would swing this by tens of dollars.
  it('does not move when the exchange rate moves', () => {
    const float = 4_000_000; // 40,000.00 Sl Sh
    const takings = 115_000;
    const counted = float + takings; // counted exactly right
    const expected = expectedMinor(float, takings);

    const at115 = combinedVarianceBaseCents([
      cashRow({
        currencyCode: 'SLSH',
        varianceMinor: varianceMinor(counted, expected),
        openingRateToUsd: 115,
        closingRateToUsd: 115,
      }),
    ]);
    const at118 = combinedVarianceBaseCents([
      cashRow({
        currencyCode: 'SLSH',
        varianceMinor: varianceMinor(counted, expected),
        openingRateToUsd: 115,
        closingRateToUsd: 118,
      }),
    ]);

    expect(at115).toBe(0);
    expect(at118).toBe(0);

    // And a real $5 shortfall stays a real $5 shortfall at either rate, give or
    // take rounding — which is exactly why converting variances is safe when
    // converting balances is not.
    const shortAt115 = combinedVarianceBaseCents([
      cashRow({ currencyCode: 'SLSH', varianceMinor: -57_500, closingRateToUsd: 115 }),
    ]);
    const shortAt118 = combinedVarianceBaseCents([
      cashRow({ currencyCode: 'SLSH', varianceMinor: -57_500, closingRateToUsd: 118 }),
    ]);
    expect(shortAt115).toBe(-500);
    expect(shortAt118).toBe(-487);
    expect(Math.abs(shortAt115 - shortAt118)).toBeLessThan(20);
  });
});

describe('fxDriftBaseCents', () => {
  // The 355,000 Sl Sh drawer across a 115 -> 118 move: worth about $78 less,
  // with every note still in it. Real money, but nobody is short.
  it('reports what a held balance gained or lost in value', () => {
    const drift = fxDriftBaseCents(
      cashRow({ currencyCode: 'SLSH', closingCountedMinor: 35_500_000, openingRateToUsd: 115, closingRateToUsd: 118 })
    );
    expect(drift).toBe(-7848);
  });

  it('is positive when the currency strengthened', () => {
    const drift = fxDriftBaseCents(
      cashRow({ currencyCode: 'SLSH', closingCountedMinor: 35_500_000, openingRateToUsd: 118, closingRateToUsd: 115 })
    );
    expect(drift).toBe(7848);
  });

  it('is zero for the base currency, which cannot drift against itself', () => {
    const drift = fxDriftBaseCents(
      cashRow({ currencyCode: 'USD', closingCountedMinor: 44_850, openingRateToUsd: 1, closingRateToUsd: 1 })
    );
    expect(drift).toBe(0);
  });

  it('is zero while the session is still open', () => {
    expect(fxDriftBaseCents(cashRow({ currencyCode: 'SLSH', closingCountedMinor: null }))).toBe(0);
  });

  it('sums across currencies', () => {
    expect(
      totalFxDriftBaseCents([
        cashRow({ currencyCode: 'USD', closingCountedMinor: 44_850, closingRateToUsd: 1 }),
        cashRow({ currencyCode: 'SLSH', closingCountedMinor: 35_500_000, openingRateToUsd: 115, closingRateToUsd: 118 }),
      ])
    ).toBe(-7848);
  });
});

describe('tallyTotalMinor', () => {
  it('multiplies each note by its count', () => {
    expect(tallyTotalMinor({ '10000': 2, '5000': 3, '2000': 4, '1000': 1, '500': 1 })).toBe(
      20000 + 15000 + 8000 + 1000 + 500
    );
  });

  it('adds the catch-all row as an amount, not a count', () => {
    expect(tallyTotalMinor({ '10000': 2, [OTHER_DENOMINATION]: 350 })).toBe(20350);
  });

  // The note list is a starting point, not a constraint: a cashier holding a
  // 10,000 shilling note the shop never configured must be able to count it,
  // and it must sum identically to a seeded one.
  it('handles a note value the shop has never configured', () => {
    const seeded = tallyTotalMinor({ '500000': 62 });
    const adHoc = tallyTotalMinor({ '1000000': 31 });
    expect(seeded).toBe(31_000_000);
    expect(adHoc).toBe(31_000_000);
  });

  it('reads part-typed and empty rows as not counted yet', () => {
    expect(tallyTotalMinor({ '5000': '' as unknown as number, '1000': null, '500': undefined })).toBe(0);
    expect(tallyTotalMinor({ '5000': '3' })).toBe(15000);
  });

  it('ignores negative counts and unparseable keys', () => {
    expect(tallyTotalMinor({ '5000': -2, abc: 4, '0': 9 })).toBe(0);
  });

  it('is zero for an empty tally', () => {
    expect(tallyTotalMinor({})).toBe(0);
  });

  // The worked example from the mockup, which the reveal's arithmetic depends on.
  it('matches the mockup: 355,000 Sl Sh across five notes plus change', () => {
    const total = tallyTotalMinor({
      '1000000': 25,
      '500000': 18,
      '100000': 12,
      '50000': 4,
      '10000': 8,
      [OTHER_DENOMINATION]: 20000,
    });
    expect(total).toBe(35_500_000);
  });
});

describe('canCloseSession', () => {
  const open = { shopMemberId: 'amina', closedAt: null };

  it('lets you close your own', () => {
    expect(canCloseSession(open, 'amina', false)).toBe(true);
  });

  it('refuses someone else without registers.manage', () => {
    expect(canCloseSession(open, 'faduma', false)).toBe(false);
  });

  it('allows someone else with registers.manage', () => {
    expect(canCloseSession(open, 'faduma', true)).toBe(true);
  });

  it('refuses an already-closed session even to a manager', () => {
    expect(canCloseSession({ shopMemberId: 'amina', closedAt: '2026-08-07T15:00:00Z' }, 'amina', true)).toBe(false);
  });

  it('refuses when the membership has not resolved yet', () => {
    expect(canCloseSession(open, null, false)).toBe(false);
  });
});

describe('currenciesToCount', () => {
  it('asks about a currency the session was given a float in', () => {
    const codes = currenciesToCount([cashRow({ currencyCode: 'SLSH', openingFloatMinor: 4_000_000 })], {});
    expect(codes).toEqual(['SLSH']);
  });

  it('asks about a currency that only appeared mid-session', () => {
    const codes = currenciesToCount([cashRow({ currencyCode: 'USD', openingFloatMinor: 11850 })], { SLSH: 115000 });
    expect(codes).toEqual(['USD', 'SLSH']);
  });

  // A ZAAD-only phone seller: nothing was ever in anyone's hand, so the close
  // sheet has nothing to ask and completes in one tap.
  it('asks about nothing when no cash moved and no float was given', () => {
    expect(currenciesToCount([], {})).toEqual([]);
    expect(currenciesToCount([cashRow({ currencyCode: 'USD', openingFloatMinor: 0 })], {})).toEqual([]);
  });

  it('puts the base currency first and the rest in a stable order', () => {
    const codes = currenciesToCount([], { SLSH: 1, ETB: 1, USD: 1 });
    expect(codes).toEqual(['USD', 'ETB', 'SLSH']);
  });

  it('does not repeat a currency present in both the float and the takings', () => {
    const codes = currenciesToCount([cashRow({ currencyCode: 'SLSH', openingFloatMinor: 40000 })], { SLSH: 115000 });
    expect(codes).toEqual(['SLSH']);
  });
});

describe('formatSessionWindow', () => {
  const opened = '2026-08-07T08:12:00Z';

  it('reads as a duration inside the first day', () => {
    expect(formatSessionWindow(opened, new Date('2026-08-07T11:24:00Z'))).toBe('open 3h 12m');
    expect(formatSessionWindow(opened, new Date('2026-08-07T08:40:00Z'))).toBe('open 28m');
  });

  // A session may stay open as long as the shop wants, so "27h" is not
  // something the bar should shout about — the day it started is what someone
  // actually needs.
  it('switches to the weekday once it has run past a day', () => {
    const label = formatSessionWindow(opened, new Date('2026-08-08T11:24:00Z'));
    expect(label).toMatch(/^since \w{3} \d{2}:\d{2}$/);
  });

  it('survives a malformed timestamp', () => {
    expect(formatSessionWindow('not a date')).toBe('');
  });
});

describe('denominationsFor', () => {
  const list = { USD: [10000, 5000, 2000, 1000, 500, 100], SLSH: [500000, 1000000, 100000] };

  it('returns the currency notes largest first, because that is how a drawer is counted', () => {
    expect(denominationsFor(list, 'SLSH')).toEqual([1000000, 500000, 100000]);
  });

  // A wrong list is worse than none: it invites someone to count 5,000
  // shillings into a row labelled $5.
  it('returns nothing for a currency the shop has not configured', () => {
    expect(denominationsFor(list, 'ETB')).toEqual([]);
    expect(denominationsFor(null, 'USD')).toEqual([]);
  });

  it('drops junk entries', () => {
    expect(denominationsFor({ USD: [1000, 0, -5, Number.NaN] }, 'USD')).toEqual([1000]);
  });
});


describe('formatSessionRange', () => {
  // The regression: a closed session was rendered with formatSessionWindow,
  // which always reads "open Xh Ym" — so a register counted and signed off at
  // 15:00 still claimed to be running seven hours later.
  it('reads as a window, not as still open', () => {
    const label = formatSessionRange('2026-08-07T08:12:00Z', '2026-08-07T15:00:00Z');
    expect(label).not.toContain('open');
    expect(label).toMatch(/→/);
    expect(label).toContain('6h 48m');
  });

  it('leaves the date off a session that opened and closed the same day', () => {
    const label = formatSessionRange('2026-08-07T08:12:00Z', '2026-08-07T15:00:00Z');
    expect(label).not.toMatch(/Aug/);
  });

  // Times chosen to cross midnight in the suite's pinned zone (jest.config.js
  // sets TZ=America/New_York), not in UTC — 20:00Z to 02:00Z is one local
  // evening there, which is what made the first version of this test wrong.
  it('names the opening day when it ran past midnight', () => {
    const label = formatSessionRange('2026-08-08T01:00:00Z', '2026-08-08T08:00:00Z');
    expect(label).toMatch(/Aug/);
    expect(label).toContain('7h 0m');
  });

  it('falls back to the live label while still open', () => {
    const label = formatSessionRange('2026-08-07T08:12:00Z', null, new Date('2026-08-07T11:24:00Z'));
    expect(label).toBe('open 3h 12m');
  });

  it('survives a malformed timestamp', () => {
    expect(formatSessionRange('nope', 'also nope')).toBe('');
  });
});

describe('paymentBreakdown', () => {
  it('groups by tender, largest first', () => {
    const rows = paymentBreakdown([
      payment({ method: 'cash', amountCents: 1000 }),
      payment({ method: 'zaad', amountCents: 41200 }),
      payment({ method: 'cash', amountCents: 500 }),
      payment({ method: 'edahab', amountCents: 9650 }),
    ]);
    expect(rows).toEqual([
      { method: 'zaad', count: 1, totalCents: 41200 },
      { method: 'edahab', count: 1, totalCents: 9650 },
      { method: 'cash', count: 2, totalCents: 1500 },
    ]);
  });

  // Takings, not drawer contents: a foreign cash line counts at what it was
  // worth to the sale, because this answers "how did the register do".
  it('counts foreign cash at its base-currency value', () => {
    const rows = paymentBreakdown([
      payment({ method: 'cash', amountCents: 1000, currencyCode: 'SLSH', foreignAmountCents: 200000 }),
    ]);
    expect(rows).toEqual([{ method: 'cash', count: 1, totalCents: 1000 }]);
  });

  it('is empty for a session that took nothing', () => {
    expect(paymentBreakdown([])).toEqual([]);
  });
});


function session(over: Partial<RegisterSession> & { id: string }): RegisterSession {
  return {
    shopId: 'shop',
    locationId: 'loc',
    registerId: 'reg-1',
    shopMemberId: 'member-1',
    openedBy: 'user-1',
    openedAt: '2026-08-07T08:00:00Z',
    closedAt: null,
    closedBy: null,
    varianceBaseCents: null,
    openingNote: null,
    closingNote: null,
    handedOverFrom: null,
    cash: [],
    ...over,
  };
}

describe('assembleRun', () => {
  it('is just the session when nothing was handed over', () => {
    const only = session({ id: 'a' });
    expect(assembleRun('a', [only]).map((s) => s.id)).toEqual(['a']);
  });

  it('walks back to the start and forward to the end from the middle', () => {
    const run = assembleRun('b', [
      session({ id: 'c', handedOverFrom: 'b' }),
      session({ id: 'a' }),
      session({ id: 'b', handedOverFrom: 'a' }),
    ]);
    expect(run.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  // The distinction the whole `handedOverFrom` column exists for: a close and a
  // fresh open moments later is a NEW run, and must not be spliced onto this one.
  it('leaves out a session that was opened fresh rather than handed over', () => {
    const run = assembleRun('a', [
      session({ id: 'a', closedAt: '2026-08-07T15:00:00Z' }),
      session({ id: 'b', openedAt: '2026-08-07T15:01:00Z' }),
    ]);
    expect(run.map((s) => s.id)).toEqual(['a']);
  });

  it('ignores a link to a session that is not in the window', () => {
    const run = assembleRun('b', [session({ id: 'b', handedOverFrom: 'missing' })]);
    expect(run.map((s) => s.id)).toEqual(['b']);
  });

  // No RPC can produce this, but a hand-edited row could, and hanging the sheet
  // would be worse than the feature is worth.
  it('does not loop forever on a cycle', () => {
    const run = assembleRun('a', [
      session({ id: 'a', handedOverFrom: 'b' }),
      session({ id: 'b', handedOverFrom: 'a' }),
    ]);
    expect(run.length).toBeLessThanOrEqual(2);
    expect(new Set(run.map((s) => s.id)).size).toBe(run.length);
  });

  it('returns nothing when the anchor is not in the list', () => {
    expect(assembleRun('ghost', [session({ id: 'a' })])).toEqual([]);
  });

  it('keeps other runs on the same register out of it', () => {
    const run = assembleRun('a', [
      session({ id: 'a' }),
      session({ id: 'b', handedOverFrom: 'a' }),
      session({ id: 'x' }),
      session({ id: 'y', handedOverFrom: 'x' }),
    ]);
    expect(run.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
