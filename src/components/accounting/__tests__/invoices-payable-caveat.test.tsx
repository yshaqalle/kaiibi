import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { Caveat } from '@/components/ui/caveat';

// A NEGATIVE ACCOUNTS PAYABLE HAS TO SAY SO.
//
// Documented residue of the auto-posting phase: `receive_stock` is what raises
// the payable for goods (Cr 2000 when the delivery lands), so a bill
// categorised `inventory_purchase` deliberately posts nothing -- posting it too
// would raise the same payable twice. A shop that pays such a bill without ever
// entering the delivery therefore debits 2000 with nothing having credited it,
// and Accounts Payable goes into debit: the books claim suppliers owe the shop
// money. The proper fix is the invoices<->stock_receipts link in phase 3.
//
// Until then the only thing that must not happen is SILENCE. A negative
// Accounts Payable on a shop's first balance sheet reads as kaiibi being unable
// to add up, and they would be right to think so.
//
// Three things are worth pinning in a renderer, and the third is the one that
// decays quietly:
//
//   * the caveat is THERE when 2000 is in debit,
//   * it is NOT there when 2000 is where a liability belongs -- a note that
//     shows on every screen is one nobody reads, and this one has to survive
//     being read,
//   * its TONE IS THE MEANING. `wrong` says the number is incorrect until the
//     reader fixes something and must always carry the fix. Downgrading it to
//     `context` would have the app assert the balance sheet is fine, and
//     dropping the action would leave a `wrong` with nothing to do about it --
//     which is what trains people to ignore the whole family.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockLines: { accountId: string; amountCents: number }[] = [];
const mockPush = jest.fn();
// ONE object, returned by every call. `reload` is a useCallback over [shop,
// dateRange] and the effect that runs it depends on `reload` -- so a factory
// building a fresh `{ shop: ... }` per render gives the callback a new identity
// every time and the screen fetches for ever. Every test in this file times out
// at 5s with no other symptom.
const mockAuth = { shop: { id: 'shop-1' }, can: () => true };

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does not
// exist outside a NavigationContainer; the behaviour has its own suite. `router`
// is the real thing under test here -- the caveat's action navigates with it.
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
  useFocusEffect: () => {},
}));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/lib/invoices', () => ({
  listOpenInvoices: jest.fn(() => Promise.resolve([])),
  listInvoicesInRange: jest.fn(() => Promise.resolve([])),
  getInvoiceWithPayments: jest.fn(() => Promise.resolve(null)),
  createInvoice: jest.fn(),
  updateInvoice: jest.fn(),
  deleteInvoice: jest.fn(),
  recordInvoicePayment: jest.fn(),
  deleteInvoicePayment: jest.fn(),
}));
jest.mock('@/lib/ledger', () => ({
  listAccounts: jest.fn(() =>
    Promise.resolve([
      { id: 'acct-2000', shopId: 'shop-1', code: '2000', name: 'Accounts Payable', type: 'liability', isContra: false, archivedAt: null },
      { id: 'acct-1000', shopId: 'shop-1', code: '1000', name: 'Cash', type: 'asset', isContra: false, archivedAt: null },
    ])
  ),
  // Lazily, not a resolved value captured now: the imports above are hoisted
  // over these declarations, so the fixture is still uninitialised when this
  // factory runs.
  listPostedLines: jest.fn(() => Promise.resolve(mockLines)),
}));

const RANGE = { since: '2026-08-01', until: '2026-08-31' } as const;

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      <InvoicesTab
        dateRange={RANGE as never}
        locationFilter={null}
        setHeaderActions={() => {}}
        setRefresh={() => {}}
      />
    );
  });
  return tree!;
}

/**
 * The payable caveat, picked out by what it says rather than by index or by
 * tone, so adding another caveat to this screen cannot silently retarget these
 * assertions at the wrong one.
 */
async function payableCaveat() {
  const tree = await render();
  return tree.root
    .findAllByType(Caveat)
    .find((node) => String(node.props.children).includes('wrong way round'));
}

describe('the Bills screen when Accounts Payable has gone into debit', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockLines = [];
  });

  it('says so when 2000 is in debit', async () => {
    // A paid bill for goods with no delivery behind it: Dr 2000 from the
    // payment, Cr 1000 from the wallet, and nothing anywhere credited 2000.
    // 41_250 rather than a round number, so a wrong reading cannot coincide.
    mockLines = [
      { accountId: 'acct-2000', amountCents: 41_250 },
      { accountId: 'acct-1000', amountCents: -41_250 },
    ];
    const caveat = await payableCaveat();
    expect(caveat).toBeDefined();
    // The AMOUNT, not merely the sentence. "Something is wrong" is not
    // actionable; "your books are 412.50 the wrong way round" is.
    expect(String(caveat!.props.children)).toContain('412.50');
  });

  it('is silent when 2000 sits where a liability belongs', async () => {
    // The ordinary shop: a delivery landed, Cr 2000, and it is still owed.
    mockLines = [
      { accountId: 'acct-2000', amountCents: -41_250 },
      { accountId: 'acct-1000', amountCents: 41_250 },
    ];
    expect(await payableCaveat()).toBeUndefined();
  });

  it('is silent when 2000 nets to exactly zero', async () => {
    // Every bill entered against a delivery and paid in full. This is the case
    // a `>= 0` or an `!== 0` test would get wrong, and it is the commonest
    // state a small shop's payable is ever in.
    mockLines = [
      { accountId: 'acct-2000', amountCents: -41_250 },
      { accountId: 'acct-2000', amountCents: 41_250 },
    ];
    expect(await payableCaveat()).toBeUndefined();
  });

  it('is silent when the reader cannot see the ledger at all', async () => {
    // `ledger.view` gates journal_entries and journal_lines, and RLS returns no
    // rows rather than an error -- so somebody holding only `invoices.manage`
    // reads an empty ledger. Showing "your books are 0.00 the wrong way round"
    // to them would be worse than showing nothing.
    mockLines = [];
    expect(await payableCaveat()).toBeUndefined();
  });

  it('is toned `wrong` and carries the fix', async () => {
    mockLines = [
      { accountId: 'acct-2000', amountCents: 41_250 },
      { accountId: 'acct-1000', amountCents: -41_250 },
    ];
    const caveat = await payableCaveat();
    // `wrong`, not `context`: the number is not right-but-surprising, it is a
    // liability claiming suppliers owe the shop money.
    expect(caveat!.props.tone).toBe('wrong');
    // And a `wrong` must always give the reader the thing that removes it.
    expect(caveat!.props.action).toBeDefined();
    expect(caveat!.props.action.label).toBe('Record the delivery in Inventory');
    // Not dismissible: hiding a `wrong` leaves the app knowingly showing a bad
    // number with nothing to say so, and this one does not go stale on its own.
    expect(caveat!.props.onDismiss).toBeUndefined();

    act(() => { caveat!.props.action.onPress(); });
    expect(mockPush).toHaveBeenCalledWith('/inventory');
  });
});
