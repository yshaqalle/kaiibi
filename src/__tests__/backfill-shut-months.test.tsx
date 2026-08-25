import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BackfillView } from '@/components/accounting/ledger/backfill-view';
import { Caveat } from '@/components/ui/caveat';
import type { UnpostedSummary } from '@/lib/ledger-backfill';

// Lives here rather than beside the screen for the reason inventory-caveats.tsx
// gives: expo-router builds its route table from require.context(src/app) with
// an ignore list of exactly `+html` and `+api`, so a test file under src/app
// becomes a real route and ships inside the bundle.
//
// WHAT THIS FILE IS FOR. The Post History card used to tell an owner that "a
// month you have already closed is re-opened to receive it". It is not. The
// replay creates only the months that do not exist, open; a month that already
// exists keeps its status and receives the entries anyway, with no re-open, no
// re-close, no closed_at change and no audit row -- and `accounting_periods`
// documents `locked` as "nothing posts, ever. Manual, deliberate, final".
//
// The RPC's behaviour is deliberate and is not changed. The door is. So the two
// things worth pinning in a renderer are: the warning is THERE when shut months
// will receive entries, and it is NOT there when none will -- because a warning
// that shows on every screen is one nobody reads, and this one has to survive
// being read.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockSummary: UnpostedSummary = emptyExposure(0, 0);

function emptyExposure(closedMonths: number, lockedMonths: number): UnpostedSummary {
  return {
    totalRows: 12,
    lines: [{ kind: 'sale', label: 'Sales', note: 'revenue, tax, tenders and cost of goods', count: 12 }],
    kindsWithRows: 1,
    oldestOn: '2024-03-04',
    exposure: {
      closedMonths,
      lockedMonths,
      closedEntries: closedMonths * 5,
      lockedEntries: lockedMonths * 7,
    },
  };
}

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does not
// exist outside a NavigationContainer. The refresh-on-focus behaviour has its
// own suite (use-refresh-on-focus.test.tsx); this one is about the copy.
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ shop: { id: 'shop-1' }, can: () => true }),
}));
jest.mock('@/lib/ledger', () => ({
  // Lazily, not `mockResolvedValue(mockSummary)`: BackfillView is imported at
  // the TOP of this file and babel-plugin-jest-hoist lifts these jest.mock()
  // calls above the requires that import generates -- so this factory runs
  // before `mockSummary` has been assigned. A factory that read the fixture
  // eagerly would capture `undefined` for ever; an arrow that reads it when the
  // screen actually fetches sees the value the test set.
  listUnpostedLedgerCounts: jest.fn(() => Promise.resolve(mockSummary)),
  backfillShopLedger: jest.fn(() => Promise.resolve(0)),
}));

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<BackfillView setRefresh={() => {}} onOpenView={() => {}} />);
  });
  return tree!;
}

/**
 * The shut-months caveat, picked out of the stack by what it says rather than
 * by index or by tone, so adding another caveat cannot silently retarget these
 * assertions at the wrong one.
 */
async function shutMonthsCaveat() {
  const tree = await render();
  return tree.root
    .findAllByType(Caveat)
    .find((node) => String(node.props.children).includes('no longer open'));
}

describe('Post History — the months that are no longer open', () => {
  afterEach(() => {
    mockSummary = emptyExposure(0, 0);
  });

  it('names them before the button is pressed, when any will receive entries', async () => {
    mockSummary = emptyExposure(3, 1);
    const caveat = await shutMonthsCaveat();
    expect(caveat).toBeDefined();
    const copy = String(caveat!.props.children);
    // Months lead, because "4 months" is something an owner can go and look at
    // where "22 entries" is a number they can only nod at. Both are named.
    expect(copy).toContain('4 months');
    expect(copy).toContain('3 you have closed');
    expect(copy).toContain('1 you have locked');
    expect(copy).toContain('22');
  });

  it('says plainly that posting does not re-open or re-close them', async () => {
    // The exact claim the card used to get backwards, and the reason this file
    // exists. If the RPC ever does start re-opening, this is the test that
    // should go red before the copy quietly becomes a lie again.
    mockSummary = emptyExposure(2, 0);
    const copy = String((await shutMonthsCaveat())!.props.children);
    expect(copy).toContain('does not re-open');
    expect(copy).toContain('leaves nothing on the record');
  });

  it('calls a locked month final, because accounting_periods does', async () => {
    mockSummary = emptyExposure(0, 1);
    expect(String((await shutMonthsCaveat())!.props.children)).toContain('locked month is meant to be final');
  });

  it('says nothing about locking when only closed months are affected', async () => {
    mockSummary = emptyExposure(2, 0);
    const copy = String((await shutMonthsCaveat())!.props.children);
    expect(copy).not.toContain('you have locked');
    expect(copy).not.toContain('meant to be final');
  });

  it('is absent when every waiting entry lands in an open or brand-new month', async () => {
    // The half that keeps the other half worth reading. A warning that shows on
    // every visit is one nobody sees, and this is the ordinary state: a shop
    // that has never closed a month has nothing to be warned about.
    mockSummary = emptyExposure(0, 0);
    expect(await shutMonthsCaveat()).toBeUndefined();
  });

  it('is wrong-toned and carries an action, because a wrong with no fix is ignored', async () => {
    // The tone IS the meaning (src/components/ui/caveat.tsx). Entries landing
    // in a month the owner declared final is wrong, and the cause is one the
    // reader can still remove -- by not pressing. `wrong` therefore must have
    // somewhere to go, and Journals is the only place in the app a month can be
    // looked at.
    mockSummary = emptyExposure(1, 1);
    const caveat = await shutMonthsCaveat();
    expect(caveat!.props.tone).toBe('wrong');
    expect(typeof caveat!.props.action?.onPress).toBe('function');
    expect(caveat!.props.action?.label).toContain('Journals');
  });

  it('cannot be dismissed, because the press it warns about is one tap away', async () => {
    mockSummary = emptyExposure(1, 0);
    expect((await shutMonthsCaveat())!.props.onDismiss).toBeUndefined();
  });
});

describe('Post History — what the dating caveat now claims', () => {
  it('no longer says a closed month is re-opened to receive the entries', async () => {
    mockSummary = emptyExposure(0, 0);
    const tree = await render();
    const dating = tree.root
      .findAllByType(Caveat)
      .find((node) => String(node.props.children).includes('dated when the thing happened'));
    expect(dating).toBeDefined();
    const copy = String(dating!.props.children);
    expect(copy).not.toContain('re-opened to receive it');
    expect(copy).toContain('not re-opened and not closed again');
    // And it still tells the true half: a month nobody has traded in is made.
    expect(copy).toContain('never traded in is created for it, open');
  });
});
