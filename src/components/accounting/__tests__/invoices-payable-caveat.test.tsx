import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { InvoicesTab } from '@/components/accounting/invoices-tab';
import { Caveat } from '@/components/ui/caveat';

// A NEGATIVE ACCOUNTS PAYABLE HAS TO SAY SO -- AND HAS TO SAY THE RIGHT THING.
//
// Documented residue of the auto-posting phase: `receive_stock` is what raises
// the payable for goods (Cr 2000 when the delivery lands), so a bill categorised
// `inventory_purchase` deliberately posts nothing -- posting it too would raise
// the same payable twice. A shop that pays such a bill without ever entering the
// delivery therefore debits 2000 with nothing having credited it, and Accounts
// Payable goes into debit: the books claim suppliers owe the shop money. The
// proper fix is the invoices<->stock_receipts link in phase 3.
//
// Until then the only thing that must not happen is SILENCE. A negative Accounts
// Payable on a shop's first balance sheet reads as kaiibi being unable to add
// up, and they would be right to think so.
//
// THAT DIAGNOSIS IS NOT EXCLUSIVE, AND THE OTHER CAUSE MAKES THE ACTION
// DESTRUCTIVE. A bill of ANY category entered before auto-posting shipped
// credited nothing, while paying it today posts a live Dr 2000. So a shop that
// has not pressed Post History can drive 2000 into debit by paying an old RENT
// bill -- and telling it to "record the delivery" means inventing goods that
// never arrived: stock inflated, 1200 inflated, 2000 credited for a delivery
// that does not exist. The two branches below are the whole point of this file:
// same number, same tone, different sentence and different door.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockPayable: { debitCents: number; hasUnposted: boolean } | null = null;
let mockPermissions = new Set<string>();
const mockPush = jest.fn();
// ONE object, returned by every call. `reload` is a useCallback over [shop,
// dateRange] and the effect that runs it depends on `reload` -- so a factory
// building a fresh `{ shop: ... }` per render gives the callback a new identity
// every time and the screen fetches for ever. Every test in this file times out
// at 5s with no other symptom.
const mockAuth = { shop: { id: 'shop-1' }, can: (key: string) => mockPermissions.has(key) };

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
// ONE CALL, ONE ROW. The screen used to fetch every journal line the shop had
// ever posted and net them here; PostgREST truncates that at max-rows without
// saying so, which turned a healthy payable into a confident accusation. The sum
// is the database's now (20260908001700) -- so is the "is anything unposted"
// half, because the two have to be decided against the same instant and the same
// permission.
//
// Lazily, not a resolved value captured now: the imports above are hoisted over
// these declarations, so the fixture is still uninitialised when this factory
// runs.
jest.mock('@/lib/ledger', () => ({
  getPayableState: jest.fn(() => Promise.resolve(mockPayable)),
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
 * assertions at the wrong one. Both branches share the opening sentence on
 * purpose -- the reader's problem is the same one either way.
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
    mockPayable = null;
    mockPermissions = new Set(['invoices.manage', 'ledger.view', 'ledger.close']);
  });

  it('says so when 2000 is in debit', async () => {
    // A paid bill for goods with no delivery behind it: Dr 2000 from the
    // payment, and nothing anywhere credited 2000. 41_250 rather than a round
    // number, so a wrong reading cannot coincide.
    mockPayable = { debitCents: 41_250, hasUnposted: false };
    const caveat = await payableCaveat();
    expect(caveat).toBeDefined();
    // The AMOUNT, not merely the sentence. "Something is wrong" is not
    // actionable; "your books are 412.50 the wrong way round" is.
    expect(String(caveat!.props.children)).toContain('412.50');
  });

  it('is silent when 2000 sits where a liability belongs', async () => {
    // The ordinary shop: a delivery landed, Cr 2000, and it is still owed. The
    // database returns the clamped figure, which is 0 for any credit balance.
    mockPayable = { debitCents: 0, hasUnposted: false };
    expect(await payableCaveat()).toBeUndefined();
  });

  it('is silent when the reader cannot see the ledger at all', async () => {
    // `ledger.view` gates the function, which answers with NO ROWS rather than a
    // zero for a reader who lacks it -- getPayableState() turns that into null.
    // Showing "your books are 0.00 the wrong way round" to a bookkeeper who
    // cannot open the trial balance would be worse than showing nothing.
    mockPayable = null;
    expect(await payableCaveat()).toBeUndefined();
  });

  it('is toned `wrong` and points at the missing delivery once history is posted', async () => {
    mockPayable = { debitCents: 41_250, hasUnposted: false };
    const caveat = await payableCaveat();
    // `wrong`, not `context`: the number is not right-but-surprising, it is a
    // liability claiming suppliers owe the shop money.
    expect(caveat!.props.tone).toBe('wrong');
    // And a `wrong` must always give the reader the thing that removes it.
    expect(caveat!.props.action).toBeDefined();
    expect(caveat!.props.action.label).toBe('Record the delivery in Inventory');
    expect(String(caveat!.props.children)).toContain('never entered in Inventory');
    // Not dismissible: hiding a `wrong` leaves the app knowingly showing a bad
    // number with nothing to say so, and this one does not go stale on its own.
    expect(caveat!.props.onDismiss).toBeUndefined();

    act(() => { caveat!.props.action.onPress(); });
    expect(mockPush).toHaveBeenCalledWith('/inventory');
  });

  it('sends a shop with unposted history to Post History instead, and never to Inventory', async () => {
    // THE DESTRUCTIVE CASE. Same number, same tone -- and the remedy above would
    // have this shop invent a delivery for a rent bill. Nothing about the amount
    // distinguishes the two, so the screen decides on `hasUnposted`.
    mockPayable = { debitCents: 41_250, hasUnposted: true };
    const caveat = await payableCaveat();
    expect(caveat).toBeDefined();
    expect(caveat!.props.tone).toBe('wrong');
    expect(String(caveat!.props.children)).toContain('412.50');
    // The copy must NOT be the delivery sentence. This is the assertion that
    // fails if someone later collapses the two branches back into one.
    expect(String(caveat!.props.children)).not.toContain('Inventory');
    expect(String(caveat!.props.children)).toContain('has not reached the ledger');

    expect(caveat!.props.action.label).toBe('Post your history');
    act(() => { caveat!.props.action.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/accounting',
      params: { tab: 'accounting', view: 'backfill' },
    });
    expect(mockPush).not.toHaveBeenCalledWith('/inventory');
  });

  it('says nothing to a reader who cannot post history, rather than offering the destructive fix', async () => {
    // Post History gates on `ledger.close` and the hub hides its card without
    // it. For this reader the only remaining sentence is the one that would have
    // them invent a delivery, so there is nothing honest left to say.
    mockPayable = { debitCents: 41_250, hasUnposted: true };
    mockPermissions = new Set(['invoices.manage', 'ledger.view']);
    expect(await payableCaveat()).toBeUndefined();
  });
});
