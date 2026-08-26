// The period-close door: what it asks the database for, what it does with the
// answer, and the one attribution it is allowed to make.
//
// Three things here are load-bearing and each is invisible if it breaks:
//
//   1. A CLOSE WRITES TWO AUDIT ROWS, on purpose. The accounting_periods
//      trigger writes a uniform row-diff and the RPC writes an explicit one
//      carrying the entry, the profit and `forced`. `after->>'event'` exists so
//      a screen can tell them apart BY FILTER rather than by guessing from the
//      shape of the blob. Drop the filter and every closed month appears twice.
//   2. `outstanding` IS NULL FOR A CLOSED PERIOD and `[]` for an open one with
//      nothing outstanding. The function goes to the trouble of distinguishing
//      "nothing" from "not asked"; flattening them here throws that away.
//   3. bigint ARRIVES AS A STRING over PostgREST.

import {
  closeAccountingPeriod,
  closedByLabel,
  dayLabel,
  getPeriodCloseSettings,
  listAccountingPeriods,
  listPeriodCloseEvents,
  listPeriodExceptions,
  monthLabel,
  reopenAccountingPeriod,
  type PeriodCloseEvent,
} from '@/lib/periods';

// Below the import rather than above it, and it still runs first:
// babel-plugin-jest-hoist lifts every jest.mock() above the imports in the
// compiled output. The factory closes over nothing outside itself, which is the
// condition that makes that safe.
jest.mock('@/lib/supabase', () => {
  const state = {
    rows: [] as any[],
    rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
    calls: [] as { name: string; args: any }[],
    filters: [] as [string, string][],
  };
  const client = {
    rpc: (name: string, args: any) => {
      state.calls.push({ name, args });
      const outcome = state.rpc[name] ?? {};
      return Promise.resolve({ data: outcome.data ?? null, error: outcome.error ?? null });
    },
    from: () => {
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.filters.push([column, String(value)]);
          return builder;
        },
        order: () => builder,
        limit: () => Promise.resolve({ data: state.rows, error: null }),
        single: () => Promise.resolve({ data: state.rows[0] ?? null, error: null }),
      };
      return builder;
    },
  };
  return { supabase: client, __state: state };
});

const state = (jest.requireMock('@/lib/supabase') as any).__state as {
  rows: any[];
  rpc: Record<string, { data?: unknown; error?: unknown }>;
  calls: { name: string; args: any }[];
  filters: [string, string][];
};

beforeEach(() => {
  state.rows = [];
  state.rpc = {};
  state.calls = [];
  state.filters = [];
});

const VIEWER = 'user-viewer';

function event(over: Partial<PeriodCloseEvent> = {}): PeriodCloseEvent {
  return { periodId: 'p1', actorId: VIEWER, forced: false, at: '2026-08-03T09:00:00Z', ...over };
}

describe('who a close is attributed to', () => {
  it('says Automatic for a forced close rather than naming the actor on the row', () => {
    // THE WHOLE POINT. A month that closed by itself closed on the back of
    // somebody's READ -- close_due_periods() runs inside
    // list_accounting_periods() -- so `closed_by` and the audit row's actor are
    // whoever opened an accounting screen first after the grace expired. They
    // decided nothing. close_due_periods() always forces, so `forced` is what
    // separates a close nobody chose from one somebody did.
    //
    // The actor here is the VIEWER, so a screen reading closed_by would proudly
    // print "You" against a close this user never made.
    expect(closedByLabel(event({ forced: true }), VIEWER)).toBe('Automatic');
    expect(closedByLabel(event({ forced: true, actorId: 'user-other' }), VIEWER)).toBe('Automatic');
  });

  it('names the reader when they closed it themselves, un-forced', () => {
    expect(closedByLabel(event({ forced: false }), VIEWER)).toBe('You');
  });

  it('says A person for somebody else, because no name lookup is open to this reader', () => {
    // list_shop_staff() gates on staff.manage and four People permissions, none
    // of which a bookkeeper holding ledger.close need have -- so resolving the
    // actor to a name, as the mockup does, would fail for exactly the reader
    // this screen is for. The Audit Log draws the same distinction.
    expect(closedByLabel(event({ actorId: 'user-other' }), VIEWER)).toBe('A person');
  });

  it('says System when there was no signed-in actor at all', () => {
    // A migration or a maintenance script. A blank cell would read as a bug.
    expect(closedByLabel(event({ actorId: null }), VIEWER)).toBe('System');
  });

  it('says nothing at all when there is no explicit close row to read', () => {
    // The RLS write policy on accounting_periods lets a ledger.close holder set
    // the status by hand, which writes the trigger's row and no `event` key. A
    // dash, not a guess.
    expect(closedByLabel(undefined, VIEWER)).toBe('—');
  });

  it('does not fall back to the viewer when nobody is signed in', () => {
    expect(closedByLabel(event({ actorId: null }), null)).toBe('System');
    expect(closedByLabel(event({ actorId: 'user-other' }), null)).toBe('A person');
  });
});

describe('reading the close events', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    actor_id: VIEWER,
    subject_id: 'p1',
    after: { event: 'close', forced: false, status: 'closed' },
    created_at: '2026-08-03T09:00:00Z',
    ...over,
  });

  it("filters on after->>'event', which is what tells the two audit rows apart", async () => {
    state.rows = [row()];
    await listPeriodCloseEvents('shop-1');
    // Without this filter the trigger's row-diff twin comes back alongside the
    // explicit row -- it has the same subject_id and no `forced` key -- and a
    // close would read as "—" or double up, depending on which arrived first.
    expect(state.filters).toContainEqual(['after->>event', 'close']);
    // And scoped to the right table and shop: the log carries journal entries,
    // lines and accounts too.
    expect(state.filters).toContainEqual(['subject_table', 'accounting_periods']);
    expect(state.filters).toContainEqual(['shop_id', 'shop-1']);
  });

  it('keeps ONE row per close — the newest, for a month closed, re-opened and closed again', async () => {
    // Ordered newest first by the query, so the first sighting wins. The second
    // close is the standing one; the first describes a close that has since
    // been reversed out of the ledger.
    state.rows = [
      row({ created_at: '2026-09-01T09:00:00Z', after: { event: 'close', forced: true } }),
      row({ created_at: '2026-08-03T09:00:00Z', after: { event: 'close', forced: false } }),
    ];
    const events = await listPeriodCloseEvents('shop-1');
    expect(events.size).toBe(1);
    expect(events.get('p1')!.forced).toBe(true);
    expect(events.get('p1')!.at).toBe('2026-09-01T09:00:00Z');
  });

  it('reads `forced` as the boolean it is, and treats a missing key as not forced', async () => {
    state.rows = [
      row({ subject_id: 'p1', after: { event: 'close', forced: true } }),
      row({ subject_id: 'p2', after: { event: 'close', forced: false } }),
      // A close written before `forced` was recorded at all. Absent is not
      // "automatic": it is "we do not know", and the safe reading of an unknown
      // is the one that does not claim the month closed by itself.
      row({ subject_id: 'p3', after: { event: 'close' } }),
    ];
    const events = await listPeriodCloseEvents('shop-1');
    expect(events.get('p1')!.forced).toBe(true);
    expect(events.get('p2')!.forced).toBe(false);
    expect(events.get('p3')!.forced).toBe(false);
  });
});

describe('reading the periods', () => {
  const listRow = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    starts_on: '2026-08-01',
    ends_on: '2026-08-31',
    status: 'open',
    closed_at: null,
    closed_by: null,
    exceptions: [],
    outstanding: [],
    closing_entry_id: null,
    profit_rolled_cents: '0',
    auto_close_due_on: '2026-09-10',
    ...over,
  });

  it('keeps "nothing outstanding" and "not computed" apart', async () => {
    state.rpc.list_accounting_periods = {
      data: [
        listRow({ id: 'open-clean', status: 'open', outstanding: [] }),
        // A closed period: the function returns NULL here, because recomputing
        // what is outstanding against a month that has already closed answers a
        // different question in the same column.
        listRow({ id: 'shut', status: 'closed', outstanding: null, exceptions: ['Nobody counted stock.'] }),
      ],
    };
    const rows = await listAccountingPeriods('shop-1');
    expect(rows[0].outstanding).toEqual([]);
    expect(rows[1].outstanding).toBeNull();
    // The recorded array is a different column and survives on its own.
    expect(rows[1].exceptions).toEqual(['Nobody counted stock.']);
  });

  it('coerces the profit, which arrives as a STRING because it is a bigint', async () => {
    // A bare `+` on it would concatenate. The figure goes straight into a money
    // formatter, so a string would render as "$NaN" -- or worse, silently
    // format wrong.
    state.rpc.list_accounting_periods = { data: [listRow({ status: 'closed', profit_rolled_cents: '820411' })] };
    const rows = await listAccountingPeriods('shop-1');
    expect(rows[0].profitRolledCents).toBe(820411);
    expect(typeof rows[0].profitRolledCents).toBe('number');
  });

  it('throws what the database said, so the screen can print it rather than inventing wording', async () => {
    state.rpc.list_accounting_periods = {
      error: new Error("You do not have permission to view this shop's accounting periods."),
    };
    await expect(listAccountingPeriods('shop-1')).rejects.toThrow('do not have permission');
  });

  it('asks period_exceptions for the checklist rather than working one out', async () => {
    state.rpc.period_exceptions = { data: [{ kind: 'stock_count_missing', detail: 'Nobody counted stock.', count: '2' }] };
    const rows = await listPeriodExceptions('shop-1', 'p1');
    expect(state.calls).toContainEqual({ name: 'period_exceptions', args: { p_shop_id: 'shop-1', p_period_id: 'p1' } });
    expect(rows).toEqual([{ kind: 'stock_count_missing', detail: 'Nobody counted stock.', count: 2 }]);
  });

  it('reads the shop close settings without deciding anything about them', async () => {
    state.rows = [{ auto_close_periods: 'ask', period_close_grace_days: 15 }];
    expect(await getPeriodCloseSettings('shop-1')).toEqual({ mode: 'ask', graceDays: 15 });
  });
});

describe('closing and re-opening', () => {
  it('closes un-forced by default, which is what makes the database do the asking', async () => {
    state.rpc.close_accounting_period = { data: 'entry-1' };
    expect(await closeAccountingPeriod('shop-1', 'p1')).toBe('entry-1');
    expect(state.calls[0].args).toEqual({ p_shop_id: 'shop-1', p_period_id: 'p1', p_force: false });
  });

  it('passes the force through when the reader has said yes a second time', async () => {
    state.rpc.close_accounting_period = { data: 'entry-2' };
    await closeAccountingPeriod('shop-1', 'p1', true);
    expect(state.calls[0].args.p_force).toBe(true);
  });

  it('returns null for a month that did not trade, rather than pretending an entry was written', async () => {
    state.rpc.close_accounting_period = { data: null };
    expect(await closeAccountingPeriod('shop-1', 'p1')).toBeNull();
  });

  it('sends the re-open reason, which is the audit trail\'s only explanation', async () => {
    await reopenAccountingPeriod('shop-1', 'p1', 'A late Somtel bill for August arrived.');
    expect(state.calls[0]).toEqual({
      name: 'reopen_accounting_period',
      args: { p_shop_id: 'shop-1', p_period_id: 'p1', p_reason: 'A late Somtel bill for August arrived.' },
    });
  });

  it('throws the refusal verbatim, because it NAMES every outstanding item', async () => {
    const refusal =
      'Closing August 2026 would leave 2 items outstanding: 1 pay run covering August 2026 is still in draft, ' +
      'so those wages are not in this month\'s books. Nobody counted stock at Hodan Store in August 2026, so what ' +
      'the books say is in stock has not been checked against the shelves. Close it anyway to record them against the period.';
    state.rpc.close_accounting_period = { error: new Error(refusal) };
    await expect(closeAccountingPeriod('shop-1', 'p1')).rejects.toThrow('would leave 2 items outstanding');
  });
});

describe('the date labels', () => {
  it('renders the month the date column actually says', () => {
    // `new Date('2026-09-01')` parses as UTC MIDNIGHT, so in any western
    // timezone -- jest pins America/New_York -- toLocaleDateString renders
    // August. Every period would be labelled a month early.
    expect(monthLabel('2026-09-01')).toBe(new Date(2026, 8, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect(monthLabel('2026-09-01')).not.toBe(new Date('2026-09-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  });

  it('renders a date column as its own day, and a timestamp as an instant', () => {
    // `closed_at` is timestamptz and `auto_close_due_on` is a date, and the same
    // cell renders both. A date column parsed as UTC midnight reads a day early.
    expect(dayLabel('2026-09-10')).toBe(new Date(2026, 8, 10).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    expect(dayLabel('2026-08-03T13:00:00Z')).toBe(
      new Date('2026-08-03T13:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    );
  });
});
