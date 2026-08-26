import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ClosePeriodView } from '@/components/accounting/ledger/close-period-view';
import { Caveat } from '@/components/ui/caveat';
import { NameCell, ValueCell } from '@/components/ui/data-table';
import type { RefreshSetter } from '@/components/accounting/use-header-actions';
import { dayLabel, nextDay, type AccountingPeriod, type PeriodCloseEvent, type PeriodException } from '@/lib/periods';

// The Close a Period door.
//
// Four decisions made above this screen have to survive contact with it, and
// each is invisible if it breaks:
//
//   1. period_exceptions() is CALLED, never re-derived. What the screen prints
//      is the sentence the database wrote, which is the same sentence
//      close_accounting_period() records against the period.
//   2. A close writes TWO audit rows. The screen reads the explicit one, by
//      filter, and shows ONE row per close.
//   3. A lazily auto-closed period's `closed_by` is whoever's READ triggered
//      it. Rendering that name is a lie, so a forced close reads "Automatic".
//   4. The un-forced refusal IS the "ask me" state: the screen prints what the
//      database named, and forcing is a second, deliberate act.
//
// The screen also does NO ARITHMETIC. There is no figure on it that is not a
// column list_accounting_periods() returned.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockPeriods: AccountingPeriod[] = [];
let mockEvents = new Map<string, PeriodCloseEvent>();
let mockChecklist: PeriodException[] = [];
const mockListPeriods = jest.fn(() => Promise.resolve(mockPeriods));
const mockListEvents = jest.fn(() => Promise.resolve(mockEvents));
const mockListExceptions = jest.fn(() => Promise.resolve(mockChecklist));
const mockClose = jest.fn(() => Promise.resolve('entry-1' as string | null));
const mockReopen = jest.fn(() => Promise.resolve());
const mockSettings = jest.fn(() => Promise.resolve({ mode: 'automatic' as const, graceDays: 10 }));

// ONE object with a STABLE `can`, returned by every call. The view's `load` is a
// useCallback over [shop]; a factory building a fresh object per render would
// give it a new identity every render and the screen would fetch for ever,
// timing every test out at 5s with no other symptom.
let mockCanClose = true;
const mockAuth = {
  shop: { id: 'shop-1' },
  can: (permission: string) => (permission === 'ledger.close' ? mockCanClose : true),
  session: { user: { id: 'user-viewer' } },
};

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does not
// exist outside a NavigationContainer; that hook has its own suite.
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));
// Only the calls that talk to Supabase are replaced. closedByLabel, monthLabel
// and dayLabel are left REAL: closedByLabel is the whole of the attribution
// decision, and stubbing it would test the stub.
jest.mock('@/lib/periods', () => ({
  ...jest.requireActual('@/lib/periods'),
  listAccountingPeriods: (...args: unknown[]) => mockListPeriods(...(args as [])),
  listPeriodCloseEvents: (...args: unknown[]) => mockListEvents(...(args as [])),
  listPeriodExceptions: (...args: unknown[]) => mockListExceptions(...(args as [])),
  closeAccountingPeriod: (...args: unknown[]) => mockClose(...(args as [])),
  reopenAccountingPeriod: (...args: unknown[]) => mockReopen(...(args as [])),
  getPeriodCloseSettings: (...args: unknown[]) => mockSettings(...(args as [])),
}));

const VIEWER = 'user-viewer';

function period(over: Partial<AccountingPeriod>): AccountingPeriod {
  return {
    id: 'p',
    startsOn: '2026-08-01',
    endsOn: '2026-08-31',
    status: 'open',
    closedAt: null,
    closedBy: null,
    exceptions: [],
    outstanding: [],
    closingEntryId: null,
    profitRolledCents: 0,
    autoCloseDueOn: null,
    ...over,
  };
}

const DRAFT_RUN =
  "1 pay run covering August 2026 is still in draft, so those wages are not in this month's books.";
const NO_COUNT =
  'Nobody counted stock at Hodan Store in August 2026, so what the books say is in stock has not been checked against the shelves.';

// THE CLOCK IS PINNED, because which month this screen offers to close is a
// question about today: the oldest OPEN month that has already ENDED. 5
// September 2026 puts the fixture inside the grace window, where the current
// month and the last one are both open -- the shape the whole of I1 is about,
// and the shape a fixture with one open period cannot express.
//
// Only Date is faked. Faking the timer queue as well would deadlock `await
// act()`, which is waiting on promises this screen resolves.
const TODAY = new Date(2026, 8, 5, 9, 0, 0);
const REAL_TIMERS = [
  'nextTick',
  'setImmediate',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'performance',
] as const;

// Newest first, as list_accounting_periods() returns them.
//
// TWO OPEN PERIODS, and that is the point of the fixture rather than an
// accident of it. September has not ended -- the database refuses to close it
// and closing it would stop the till -- and August has, so August is the month
// this screen must offer. With ONE open period the correct selection and the
// wrong one are the same expression, and the defect this file now guards was
// invisible for exactly that reason.
function fixture(): AccountingPeriod[] {
  return [
    period({
      id: 'p-sep',
      startsOn: '2026-09-01',
      endsOn: '2026-09-30',
      status: 'open',
      outstanding: [],
      autoCloseDueOn: '2026-10-10',
    }),
    period({
      id: 'p-aug',
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
      status: 'open',
      outstanding: [DRAFT_RUN, NO_COUNT],
      autoCloseDueOn: '2026-09-10',
    }),
    period({
      id: 'p-jul',
      startsOn: '2026-07-01',
      endsOn: '2026-07-31',
      status: 'closed',
      closedAt: '2026-08-03T13:00:00.000Z',
      closedBy: VIEWER,
      exceptions: ['Nobody counted stock at Hodan Store in July 2026.'],
      outstanding: null,
      closingEntryId: 'e-jul',
      profitRolledCents: 820_411,
    }),
    period({
      id: 'p-jun',
      startsOn: '2026-06-01',
      endsOn: '2026-06-30',
      status: 'closed',
      closedAt: '2026-07-04T13:00:00.000Z',
      closedBy: VIEWER,
      outstanding: null,
      closingEntryId: 'e-jun',
      profitRolledCents: 688_240,
    }),
    period({
      id: 'p-may',
      startsOn: '2026-05-01',
      endsOn: '2026-05-31',
      status: 'locked',
      closedAt: '2026-06-02T13:00:00.000Z',
      outstanding: null,
      closingEntryId: 'e-may',
      profitRolledCents: 710_400,
    }),
  ];
}

// p-jul closed by ITSELF -- forced, and the actor is the viewer only because
// theirs was the read that triggered the lazy close. p-jun was closed by the
// viewer on purpose, un-forced. p-may has no explicit row at all.
function events(): Map<string, PeriodCloseEvent> {
  return new Map<string, PeriodCloseEvent>([
    ['p-jul', { periodId: 'p-jul', actorId: VIEWER, forced: true, at: '2026-08-03T13:00:00.000Z' }],
    ['p-jun', { periodId: 'p-jun', actorId: VIEWER, forced: false, at: '2026-07-04T13:00:00.000Z' }],
  ]);
}

async function render(setRefresh: RefreshSetter = () => {}): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<ClosePeriodView setRefresh={setRefresh} onOpenView={() => {}} />);
  });
  return tree!;
}

/** Every string the screen actually drew, flattened. */
function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
    .filter((child): child is string => typeof child === 'string');
}

/**
 * A button, found by what it SAYS.
 *
 * Not `findAllByType(Pressable)`: react-native re-exports Pressable through a
 * forwardRef wrapper, so the rendered node's type is not the imported symbol
 * and that call returns nothing at all -- silently, which makes every
 * assertion built on it pass by finding no button to press. `onPress` sits on
 * exactly one node per button, so it is the honest handle.
 */
function button(tree: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return tree.root
    .findAll((node) => typeof node.props?.onPress === 'function')
    .find(
      (node) =>
        node.findAll((child) => typeof child.props?.children === 'string' && child.props.children.includes(label))
          .length > 0
    );
}

function caveat(tree: ReactTestRenderer, tone: 'wrong' | 'context' | 'partial'): ReactTestInstance | undefined {
  return tree.root.findAllByType(Caveat).find((node) => node.props.tone === tone);
}

/** Every figure the table drew. */
function cellValues(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(ValueCell).map((node) => node.props.value as string);
}

function cellTitles(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(NameCell).map((node) => node.props.title as string);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: [...REAL_TIMERS] });
  jest.setSystemTime(TODAY);
  mockListPeriods.mockClear();
  mockListEvents.mockClear();
  mockListExceptions.mockClear();
  mockClose.mockClear();
  mockReopen.mockClear();
  mockSettings.mockClear();
  mockCanClose = true;
  mockPeriods = fixture();
  mockEvents = events();
  mockChecklist = [
    { kind: 'draft_payroll_run', detail: DRAFT_RUN, count: 1 },
    { kind: 'stock_count_missing', detail: NO_COUNT, count: 1 },
  ];
  mockClose.mockResolvedValue('entry-1');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('when the read refuses', () => {
  // list_accounting_periods() is security definer and RAISES without
  // ledger.view. A role holding ledger.close ALONE is not forbidden anywhere --
  // period_exceptions() explicitly allows for it -- so this is reachable, and
  // ?view=close reaches it even for someone the hub hid the card from. Phase 3a
  // shipped exactly this as a Critical: an uncaught throw left three screens on
  // "Loading…" for ever, and pull-to-refresh re-entered the same failure.
  const REFUSED = new Error("You do not have permission to view this shop's accounting periods.");

  it('says why, in the database\'s own words, and does not sit on Loading for ever', async () => {
    mockListPeriods.mockRejectedValueOnce(REFUSED);
    const tree = await render();

    const note = caveat(tree, 'partial');
    expect(note).toBeDefined();
    expect(String(note!.props.children)).toContain('permission to view');
    // 'partial' rather than 'wrong': nothing here is the reader's to fix, and a
    // 'wrong' with no action trains people to skip the whole family.
    expect(note!.props.action).toBeUndefined();

    // NOT still loading, which is the defect itself.
    expect(texts(tree)).not.toContain('Loading…');
    // And no figures. A table left on screen beside a note saying it could not
    // be read gets read anyway.
    expect(cellValues(tree)).toHaveLength(0);
  });

  it('prints a PostgrestError read refusal too, which is a plain object', async () => {
    mockListPeriods.mockRejectedValueOnce({
      code: 'P0001',
      details: null,
      hint: null,
      message: "You do not have permission to view this shop's accounting periods.",
    });
    const tree = await render();
    expect(String(caveat(tree, 'partial')!.props.children)).toContain('permission to view');
  });

  it('clears the message when pull-to-refresh succeeds', async () => {
    mockListPeriods.mockRejectedValueOnce(REFUSED);
    // useTabRefresh publishes with `setRefresh(() => reload)` -- React would
    // otherwise treat the function as a state updater and call it -- so the
    // value handed here is an updater that RETURNS the screen's reload.
    let pull: (() => Promise<void>) | null = null;
    const setRefresh = ((next: unknown) => {
      pull = typeof next === 'function' ? (next as (prev: null) => typeof pull)(null) : null;
    }) as unknown as RefreshSetter;

    const tree = await render(setRefresh);
    expect(caveat(tree, 'partial')).toBeDefined();
    expect(pull).not.toBeNull();

    await act(async () => {
      await pull!();
    });
    expect(caveat(tree, 'partial')).toBeUndefined();
    expect(cellValues(tree).length).toBeGreaterThan(0);
  });
});

describe('a reader who may not close', () => {
  // The hub hides the card from them, but `view` is a URL parameter and a role
  // can change while a session is open.
  beforeEach(() => {
    mockCanClose = false;
  });

  it('is told which permission is missing, and offered no button that would raise', async () => {
    const tree = await render();
    const note = caveat(tree, 'partial');
    expect(note).toBeDefined();
    expect(String(note!.props.children)).toContain('close an accounting period');
    expect(button(tree, 'Close August 2026 now')).toBeUndefined();
    expect(button(tree, 'Re-open')).toBeUndefined();
  });

  it('can still read what has closed, because that gate is ledger.view and they hold it', async () => {
    const tree = await render();
    expect(cellValues(tree)).toContain('$8,204.11');
  });
});

describe('the month-end checklist', () => {
  it('asks period_exceptions for the OPEN period and prints its sentences verbatim', async () => {
    const tree = await render();
    // Called, not re-derived. The list a shop is shown before it closes and the
    // list recorded on the period when it does have to be the same list.
    expect(mockListExceptions).toHaveBeenCalledWith('shop-1', 'p-aug');
    expect(texts(tree)).toContain(DRAFT_RUN);
    expect(texts(tree)).toContain(NO_COUNT);
  });

  it('counts what is outstanding from that list rather than announcing a clean month', async () => {
    const tree = await render();
    expect(texts(tree)).toContain('2 to check');
  });

  it('names the month that is OPEN, not merely the newest one', async () => {
    // Closing April while March is still held open is permitted on purpose
    // (20261003000100): a shop may keep one old month open for a dispute or a
    // late supplier. So the newest period is not always the open one, and a
    // screen that took the first row would offer to close a month that is
    // already closed.
    mockPeriods = [
      period({
        id: 'p-aug',
        startsOn: '2026-08-01',
        endsOn: '2026-08-31',
        status: 'closed',
        closedAt: '2026-09-10T13:00:00.000Z',
        outstanding: null,
        closingEntryId: 'e-aug',
        profitRolledCents: 100_000,
      }),
      period({ id: 'p-jul', startsOn: '2026-07-01', endsOn: '2026-07-31', status: 'open', outstanding: [], autoCloseDueOn: '2026-08-10' }),
    ];
    mockChecklist = [];
    const tree = await render();
    expect(mockListExceptions).toHaveBeenCalledWith('shop-1', 'p-jul');
    expect(button(tree, 'Close July 2026 now')).toBeDefined();
  });

  it('says so plainly when nothing is outstanding', async () => {
    mockChecklist = [];
    mockPeriods = fixture().map((row) => (row.id === 'p-aug' ? { ...row, outstanding: [] } : row));
    const tree = await render();
    expect(texts(tree)).toContain('Clear');
    expect(texts(tree).some((text) => text.includes('Nothing is outstanding'))).toBe(true);
  });
});

describe('which month it offers to close', () => {
  // The screen shipped with `periods.find((row) => row.status === 'open')` over
  // a NEWEST-FIRST list, so it always picked the current, unfinished month --
  // the one close_accounting_period now refuses, and the one whose close stops
  // the till. Two open months coexist routinely: on 'ask' and 'never' every
  // past month stays open for ever, and on 'automatic' the last month and the
  // current one overlap for the whole grace window.

  it('offers the OLDEST open month that has ENDED, not the newest open one', async () => {
    const tree = await render();
    expect(button(tree, 'Close August 2026 now')).toBeDefined();
    // September is open too, and it is the newest. It is also unfinished.
    expect(button(tree, 'Close September 2026 now')).toBeUndefined();
    // ...and the card and the checklist are about the same month as the button.
    expect(mockListExceptions).toHaveBeenCalledWith('shop-1', 'p-aug');
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    expect(mockClose).toHaveBeenCalledWith('shop-1', 'p-aug', false);
  });

  it('offers the OLDEST of several ended open months, not the newest of them', async () => {
    // 'ask' and 'never' leave every past month open for ever, so three and four
    // open months is the ordinary state there rather than a corner. With only
    // ONE ended open month the oldest and the newest are the same row and the
    // ordering is untestable -- which is how `find()` survived.
    mockPeriods = [
      period({ id: 'p-sep', startsOn: '2026-09-01', endsOn: '2026-09-30', status: 'open', outstanding: [] }),
      period({ id: 'p-aug', startsOn: '2026-08-01', endsOn: '2026-08-31', status: 'open', outstanding: [] }),
      period({ id: 'p-jul', startsOn: '2026-07-01', endsOn: '2026-07-31', status: 'open', outstanding: [] }),
    ];
    mockChecklist = [];
    const tree = await render();
    expect(button(tree, 'Close July 2026 now')).toBeDefined();
    expect(button(tree, 'Close August 2026 now')).toBeUndefined();
    expect(mockListExceptions).toHaveBeenCalledWith('shop-1', 'p-jul');
  });

  it('offers nothing to close when the only open month has not ended, and says when it can be', async () => {
    // The ordinary state of a shop on 'automatic' from the 11th onwards: last
    // month has closed by itself and only the current month is open. Offering
    // its close would be offering a button that raises.
    mockPeriods = fixture().filter((row) => row.id !== 'p-aug');
    mockChecklist = [];
    const tree = await render();

    expect(button(tree, 'Close September 2026 now')).toBeUndefined();
    expect(button(tree, 'Close August 2026 now')).toBeUndefined();
    // Said in a sentence rather than by an absence, and it names the day.
    expect(texts(tree).some((text) => text.includes('has not ended yet'))).toBe(true);
    // Through the real helpers rather than a literal: dayLabel is
    // toLocaleDateString, so "1 Oct" and "Oct 1" are both right depending on
    // where the test runs, and pinning one would make this file locale-bound.
    expect(texts(tree)).toContain(dayLabel(nextDay('2026-09-30')));
    // The card still describes the open month rather than the page going blank.
    expect(texts(tree)).toContain('September 2026');
  });
});

describe('closing a month', () => {
  it('runs an UN-FORCED close first, so the database is the thing that asks', async () => {
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    // false, not true. Forcing straight away throws away the only moment at
    // which a human can be told what they are about to close over.
    expect(mockClose).toHaveBeenCalledWith('shop-1', 'p-aug', false);
  });

  it('prints the refusal the database wrote, which NAMES every outstanding item', async () => {
    const refusal =
      `Closing August 2026 would leave 2 items outstanding: ${DRAFT_RUN} ${NO_COUNT} ` +
      'Close it anyway to record them against the period.';
    mockClose.mockRejectedValueOnce(new Error(refusal));
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });

    const note = caveat(tree, 'wrong');
    expect(note).toBeDefined();
    // Verbatim. Any wording invented here would be a second list, and the two
    // would drift -- which is the whole reason period_exceptions() exists.
    expect(String(note!.props.children)).toBe(refusal);
    // 'wrong' carries an action, always: the close did not happen and there is
    // a thing the reader can do about it.
    expect(note!.props.action).toBeDefined();
  });

  it('forces only on the reader\'s second, deliberate act', async () => {
    mockClose.mockRejectedValueOnce(new Error('Closing August 2026 would leave 2 items outstanding: … '));
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    expect(mockClose).toHaveBeenLastCalledWith('shop-1', 'p-aug', false);

    await act(async () => {
      caveat(tree, 'wrong')!.props.action.onPress();
    });
    expect(mockClose).toHaveBeenLastCalledWith('shop-1', 'p-aug', true);
  });

  it('treats a refusal on a month with NOTHING outstanding as a failure, not as being asked', async () => {
    // "This period was already closed on 3 Aug 2026", or a locked one, or a
    // permission that changed mid-session. Offering "Close anyway" there is
    // offering a button that raises again.
    mockChecklist = [];
    mockPeriods = fixture().map((row) => (row.id === 'p-aug' ? { ...row, outstanding: [] } : row));
    mockClose.mockRejectedValueOnce(new Error('This period was already closed on 3 Aug 2026.'));
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    const note = caveat(tree, 'wrong');
    expect(String(note!.props.children)).toContain('already closed');
    expect(note!.props.action.label).toBe('Try again');
  });

  it('treats an unrelated failure as a failure even while items ARE outstanding', async () => {
    // The decision is made FROM THE ERROR, not from this screen's copy of
    // `outstanding`. Branching on stale client state rendered a concurrent
    // close, a missing account or a month that had not ended as "ask me", with
    // a Close-anyway button that would fail again the same way.
    mockClose.mockRejectedValueOnce(new Error('No such accounting period.'));
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    const note = caveat(tree, 'wrong');
    expect(String(note!.props.children)).toContain('No such accounting period');
    expect(note!.props.action.label).toBe('Try again');
  });

  it('prints a PostgrestError refusal, which is not an instanceof Error', async () => {
    // THE DEFECT, exactly. `supabase.rpc()` rejects with a plain
    // `{code, details, hint, message}` object -- never an Error -- so
    // `error instanceof Error ? error.message : fallback` took the fallback
    // every time and the refusal whose entire purpose is to name every
    // outstanding item rendered "The database refused the close." Verified on
    // screen before it was fixed.
    const refusal =
      `Closing August 2026 would leave 2 items outstanding: ${DRAFT_RUN} ${NO_COUNT} ` +
      'Close it anyway to record them against the period.';
    mockClose.mockRejectedValueOnce({ code: 'P0001', details: null, hint: null, message: refusal });
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    const note = caveat(tree, 'wrong');
    expect(String(note!.props.children)).toBe(refusal);
    expect(note!.props.action.label).toContain('anyway');
  });

  it('says a month that did not trade closed empty, rather than claiming an entry was written', async () => {
    // close_accounting_period returns NULL for it: every line would be zero and
    // journal_lines refuses a zero amount, so there is no honest entry.
    mockClose.mockResolvedValueOnce(null);
    const tree = await render();
    await act(async () => {
      button(tree, 'Close August 2026 now')!.props.onPress();
    });
    const note = caveat(tree, 'context');
    expect(String(note!.props.children)).toContain('no closing entry to write');
  });
});

describe('the closed-periods table', () => {
  it('says Automatic for a month that closed by itself, and does not name the reader', async () => {
    // p-jul is FORCED, and its actor is the viewer -- because theirs was the
    // read that triggered the lazy close, not because they decided anything.
    // A screen reading closed_by would print "You" against it.
    const tree = await render();
    expect(cellValues(tree)).toContain('Automatic');
  });

  it('names the reader for a month they closed themselves, un-forced', async () => {
    const tree = await render();
    expect(cellValues(tree)).toContain('You');
  });

  it('shows the profit the function reported, and nothing at all for a month still open', async () => {
    const tree = await render();
    expect(cellValues(tree)).toContain('$8,204.11');
    expect(cellValues(tree)).toContain('$6,882.40');
    // '$0.00' would be a CLAIM -- "August rolled nothing" -- about a month that
    // has not closed and whose profit this screen has not been told.
    expect(cellValues(tree)).not.toContain('$0.00');
  });

  it('shows what was recorded against a closed month, and what is outstanding in an open one', async () => {
    const tree = await render();
    // The frozen array on the period, not a recomputation: a pay run posted two
    // months later must not erase the fact that July was closed over it.
    expect(cellTitles(tree)).toContain('Closed with 1');
    expect(cellTitles(tree)).toContain('None');
    expect(cellTitles(tree)).toContain('2 to check');
  });

  it('offers a re-open on a closed month and never on a locked one', async () => {
    const tree = await render();
    // reopen_accounting_period refuses a locked period: it is final.
    expect(cellValues(tree)).toContain('Final');
    expect(button(tree, 'Re-open')).toBeDefined();
  });
});

describe('re-opening a month', () => {
  async function openReopenPanel(): Promise<ReactTestRenderer> {
    const tree = await render();
    await act(async () => {
      button(tree, 'Re-open')!.props.onPress();
    });
    return tree;
  }

  it('will not send until a reason is typed, because that is the audit trail\'s only explanation', async () => {
    const tree = await openReopenPanel();
    const confirm = button(tree, 'Re-open July 2026')!;
    expect(confirm.props.disabled).toBe(true);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(mockReopen).not.toHaveBeenCalled();
  });

  it('sends the typed reason verbatim', async () => {
    const tree = await openReopenPanel();
    await act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('A late Somtel bill for July arrived.');
    });
    await act(async () => {
      button(tree, 'Re-open July 2026')!.props.onPress();
    });
    expect(mockReopen).toHaveBeenCalledWith('shop-1', 'p-jul', 'A late Somtel bill for July arrived.');
  });

  it('rejects a reason that is only whitespace, as the database does', async () => {
    const tree = await openReopenPanel();
    await act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('   ');
    });
    expect(button(tree, 'Re-open July 2026')!.props.disabled).toBe(true);
  });

  it('says the closing entry was reversed rather than deleted', async () => {
    const tree = await openReopenPanel();
    await act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('A late bill.');
    });
    await act(async () => {
      button(tree, 'Re-open July 2026')!.props.onPress();
    });
    const note = caveat(tree, 'context');
    expect(String(note!.props.children)).toContain('reversed rather than deleted');
  });

  it('shows what the database refused with, and leaves the panel standing', async () => {
    // A PLAIN OBJECT, as PostgREST rejects: this is the shape `instanceof
    // Error` was silently failing on, and re-opening is one of the four sites.
    mockReopen.mockRejectedValueOnce({
      code: 'P0001',
      details: null,
      hint: null,
      message: 'This period is locked. A locked period is final — it cannot be re-opened.',
    });
    const tree = await openReopenPanel();
    await act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('A late bill.');
    });
    await act(async () => {
      button(tree, 'Re-open July 2026')!.props.onPress();
    });
    expect(String(caveat(tree, 'wrong')!.props.children)).toContain('locked');
    // Still open, so the reader can read the refusal beside what they typed.
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  });
});
