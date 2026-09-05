import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { BalanceSheetView } from '@/components/accounting/ledger/balance-sheet-view';
import { CashFlowView } from '@/components/accounting/ledger/cash-flow-view';
import { IncomeStatementView } from '@/components/accounting/ledger/income-statement-view';
import { Caveat } from '@/components/ui/caveat';
import { StatementRow } from '@/components/ui/statement-row';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';
import type { RefreshSetter } from '@/components/accounting/use-header-actions';
import type { DateRange } from '@/components/range-selector';

// THE SCREENS DO NO ARITHMETIC.
//
// Every subtotal on a financial statement is a row the SQL function returned.
// A screen that adds up its own rows is a second implementation of the
// statement, and the two will disagree the first time a rounding rule or an
// account type changes -- at which point nobody knows which report is right.
//
// That rule is unfalsifiable on a fixture whose totals happen to equal the sum
// of its parts, because both implementations then agree. So ALL THREE fixtures
// below are DELIBERATELY INCONSISTENT, and every subtotal on each is
// unreachable from the rows above it:
//
//   income   gross profit is not revenue less cost of sales; net profit is not
//            gross profit less operating expenses.
//   balance  neither section total is the sum of its accounts, neither grand
//            total is the sum of its sections, and total equity is not capital
//            plus profit. The two grand totals ARE equal, because that is the
//            fact a reader checks by eye and the screen must show it.
//   cash     no section total is the sum of its rows, net change is reachable
//            from neither the section totals nor the line items, and the
//            movement in the proof is not the difference of the two cash
//            balances printed above it.
//
// The balance-sheet and cash-flow fixtures were self-consistent until the final
// review, and the mutation that mattered -- computing total assets from the two
// section totals -- passed all ten tests. Do not "fix" the arithmetic: the
// inconsistency IS the assertion.

// `mock`-prefixed because jest.mock() is hoisted above these declarations and
// babel-plugin-jest-hoist refuses a factory closing over anything else.
let mockIncomeRows: unknown[] = [];
let mockBalanceRows: unknown[] = [];
let mockCashRows: unknown[] = [];
const mockListStatementLines = jest.fn(() => Promise.resolve(mockIncomeRows));
const mockGetBalanceSheet = jest.fn(() => Promise.resolve(mockBalanceRows));
const mockGetCashFlow = jest.fn(() => Promise.resolve(mockCashRows));
// ONE object, returned by every call. Every view's `reload` is a useCallback
// over [shop, ...] and the effect that runs it depends on `reload` -- a factory
// building a fresh `{ shop }` per render gives the callback a new identity on
// every render and the screen fetches for ever, timing every test out at 5s
// with no other symptom.
const mockAuth = { shop: { id: 'shop-1' }, can: () => true };

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// useRefreshOnFocus reaches for expo-router's navigation object, which does not
// exist outside a NavigationContainer; that hook has its own suite.
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));
// Only the three RPC calls are replaced. `hasFigures` is a pure predicate and
// is deliberately left real: it is what decides whether a shop sees an empty
// state or a wall of $0.00, and stubbing it would test the stub.
jest.mock('@/lib/statements', () => ({
  ...jest.requireActual('@/lib/statements'),
  listStatementLines: (...args: unknown[]) => mockListStatementLines(...(args as [])),
  getBalanceSheet: (...args: unknown[]) => mockGetBalanceSheet(...(args as [])),
  getCashFlow: (...args: unknown[]) => mockGetCashFlow(...(args as [])),
}));

const theme = Colors.light;

// A real range with an explicit end, so the balance sheet's as-at date is a
// stated day rather than "whenever the test happened to run".
const RANGE: DateRange = { since: new Date(2026, 7, 1), until: new Date(2026, 7, 21) };

function line(over: Record<string, unknown>) {
  return { section: 'revenue', code: null, label: '', amountCents: 0, isTotal: false, sortOrder: 0, ...over };
}

// statement_lines(), summary. In sort_order, as the function returns it.
function incomeSummary() {
  return [
    line({ section: 'revenue', label: 'Net revenue', amountCents: 100_000, isTotal: true, sortOrder: 200 }),
    line({ section: 'cost_of_sales', label: 'Cost of sales', amountCents: 40_000, isTotal: true, sortOrder: 400 }),
    // 57_500, not 60_000. See the header: a screen that computed revenue less
    // cost of sales would print $600.00 here.
    line({ section: 'gross_profit', label: 'Gross profit', amountCents: 57_500, isTotal: true, sortOrder: 500 }),
    line({ section: 'operating_expenses', label: 'Total operating expenses', amountCents: 30_000, isTotal: true, sortOrder: 700 }),
    // A LOSS, and one that no combination of the rows above produces.
    line({ section: 'net_profit', label: 'Net profit', amountCents: -250, isTotal: true, sortOrder: 800 }),
  ];
}

function incomeDetail() {
  return [
    line({ section: 'revenue', code: '4000', label: 'Sales', amountCents: 102_410, sortOrder: 101 }),
    line({ section: 'revenue', code: '4200', label: 'Discounts Given', amountCents: -2_410, sortOrder: 101 }),
    ...incomeSummary(),
  ].sort((a, b) => a.sortOrder - b.sortOrder);
}

// Every total here is unreachable from the rows it sits under. The pairs a
// re-deriving screen would produce, and which must never appear:
//
//   Total current assets      41_826 (the one account)   vs the fixture's 40_100
//   Total fixed assets        14_200                     vs               15_050
//   Total assets              55_150 (sections) or 56_026 (accounts) vs   57_310
//   Total liabilities         12_000                     vs               11_400
//   Total equity              44_026 (capital + profit)  vs               45_900
//   Total liabilities+equity  57_300 (sections) or 56_026 (accounts) vs   57_310
//
// The two GRAND totals are equal to each other on purpose: a balance sheet that
// balances is the fact the reader checks first, and the screen has to show it.
// They are simply not equal to anything either side of them adds up to.
function balanceRows() {
  return [
    line({ section: 'current_assets', code: '1000', label: 'Cash on Hand', amountCents: 41_826, sortOrder: 101 }),
    line({ section: 'current_assets', label: 'Total current assets', amountCents: 40_100, isTotal: true, sortOrder: 200 }),
    line({ section: 'fixed_assets', code: '1500', label: 'Equipment', amountCents: 14_200, sortOrder: 301 }),
    line({ section: 'fixed_assets', label: 'Total fixed assets', amountCents: 15_050, isTotal: true, sortOrder: 400 }),
    line({ section: 'total_assets', label: 'Total assets', amountCents: 57_310, isTotal: true, sortOrder: 500 }),
    line({ section: 'liabilities', code: '2000', label: 'Accounts Payable', amountCents: 12_000, sortOrder: 601 }),
    line({ section: 'liabilities', label: 'Total liabilities', amountCents: 11_400, isTotal: true, sortOrder: 700 }),
    line({ section: 'equity', code: '3000', label: "Owner's Capital", amountCents: 44_276, sortOrder: 801 }),
    line({ section: 'equity', label: 'Profit this period', amountCents: -250, sortOrder: 801 }),
    line({ section: 'equity', label: 'Total equity', amountCents: 45_900, isTotal: true, sortOrder: 900 }),
    line({ section: 'total_liabilities_equity', label: 'Total liabilities and equity', amountCents: 57_310, isTotal: true, sortOrder: 1000 }),
  ];
}

// cash_flow() returns FIVE columns -- there is no `code` on a cash flow row.
function cashLine(over: Record<string, unknown>) {
  return { section: 'operating', label: '', amountCents: 0, isTotal: false, sortOrder: 0, ...over };
}

// Deliberately inconsistent, exactly as the other two are. What a re-deriving
// screen would print, and which must never appear:
//
//   Cash from operations     -5_730 (its three rows)      vs the fixture's -5_120
//   Cash used in investing      -750                      vs                 -815
//   Cash used in financing    -1_600                      vs               -1_745
//   Net change    -7_680 (sections) or -8_080 (every line) vs              -8_305
//   Movement in cash          -8_080 (close less open)    vs               -8_305
//
// The last pair is the one worth being explicit about. `Movement in cash
// accounts` is the row the whole statement is checked against, and the
// temptation to work it out from the two balances printed directly above it is
// obvious. It is the FUNCTION's row: it comes from the same one-pass read of
// the ledger and a screen must print it, not derive it. Net change and the
// movement agree with EACH OTHER -- that is the proof, and the reader's eye
// does that comparison -- while agreeing with nothing the screen could compute.
function cashRows() {
  return [
    cashLine({ section: 'operating', label: 'Net profit', amountCents: -250, sortOrder: 100 }),
    cashLine({ section: 'operating', label: 'Add back depreciation', amountCents: 930, sortOrder: 110 }),
    cashLine({ section: 'operating', label: 'Increase in inventory', amountCents: -6_410, sortOrder: 130 }),
    cashLine({ section: 'operating', label: 'Cash from operations', amountCents: -5_120, isTotal: true, sortOrder: 200 }),
    cashLine({ section: 'investing', label: 'Bought equipment', amountCents: -750, sortOrder: 310 }),
    cashLine({ section: 'investing', label: 'Cash used in investing', amountCents: -815, isTotal: true, sortOrder: 400 }),
    cashLine({ section: 'financing', label: 'Owner drawings', amountCents: -1_600, sortOrder: 520 }),
    cashLine({ section: 'financing', label: 'Cash used in financing', amountCents: -1_745, isTotal: true, sortOrder: 600 }),
    cashLine({ section: 'net_change', label: 'Net change in cash', amountCents: -8_305, isTotal: true, sortOrder: 700 }),
    cashLine({ section: 'proof', label: 'Cash at 31 Jul 2026', amountCents: 48_475, sortOrder: 810 }),
    cashLine({ section: 'proof', label: 'Cash at 21 Aug 2026', amountCents: 40_395, sortOrder: 820 }),
    cashLine({ section: 'proof', label: 'Movement in cash accounts', amountCents: -8_305, isTotal: true, sortOrder: 830 }),
  ];
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(element);
  });
  return tree!;
}

const renderIncome = () => render(<IncomeStatementView dateRange={RANGE} setRefresh={() => {}} setHeaderActions={() => {}} />);
const renderBalance = () => render(<BalanceSheetView dateRange={RANGE} setRefresh={() => {}} setHeaderActions={() => {}} />);
const renderCash = () => render(<CashFlowView dateRange={RANGE} setRefresh={() => {}} setHeaderActions={() => {}} />);

/** Every money line the screen drew, in the order it drew them. */
function moneyRows(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(StatementRow);
}

function rowFor(tree: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return moneyRows(tree).find((node) => node.props.label === label);
}

/** The figure as the reader actually sees it, not the prop behind it. */
function renderedAmount(row: ReactTestInstance): { text: string; color: unknown } {
  const texts = row.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string');
  // The amount is the last text in the row -- label, optional hint, then figure.
  const amount = texts[texts.length - 1];
  return { text: String(amount.props.children), color: StyleSheet.flatten(amount.props.style)?.color };
}

beforeEach(() => {
  mockListStatementLines.mockClear();
  mockGetBalanceSheet.mockClear();
  mockGetCashFlow.mockClear();
  mockIncomeRows = incomeSummary();
  mockBalanceRows = balanceRows();
  mockCashRows = cashRows();
});

// The exact message all three RPCs raise. They are `security definer` and gate
// on has_shop_permission(shop, 'ledger.view'), so a reader without it gets a
// P0001 rather than an empty result -- which is what makes these screens
// different from the six ledger views beside them.
const REFUSED = { message: 'You do not have permission to see the books.', code: 'P0001' };

/** The caveat a refused screen draws, if it drew one. */
function refusal(tree: ReactTestRenderer): ReactTestInstance | undefined {
  return tree.root.findAllByType(Caveat).find((node) => node.props.tone === 'partial');
}

describe('a statement whose RPC refuses', () => {
  // THE DEFAULT MANAGER, ON DAY ONE, IN EVERY SHOP. /accounting is gated on
  // `sales.view`; the seeded Manager role holds it and does not hold
  // `ledger.view`. Before this, each `reload` was a floating promise with no
  // try/catch: the await threw, `setLoaded(true)` never ran, and all three
  // screens sat on "Loading…" for ever. Pull-to-refresh did nothing, because
  // refreshing threw in the same place.
  //
  // The hub no longer offers the three cards to a reader without ledger.view
  // (see accounting-ledger-nav.test.tsx), but the views are still reachable by
  // ?view= and a role can change while a session is open. This is the screen's
  // own answer, not the hub's.
  const cases: [string, (setRefresh: RefreshSetter) => React.ReactElement, jest.Mock][] = [
    [
      'the income statement',
      (setRefresh) => <IncomeStatementView dateRange={RANGE} setRefresh={setRefresh} setHeaderActions={() => {}} />,
      mockListStatementLines,
    ],
    ['the balance sheet', (setRefresh) => <BalanceSheetView dateRange={RANGE} setRefresh={setRefresh} setHeaderActions={() => {}} />, mockGetBalanceSheet],
    ['the cash flow', (setRefresh) => <CashFlowView dateRange={RANGE} setRefresh={setRefresh} setHeaderActions={() => {}} />, mockGetCashFlow],
  ];

  for (const [name, element, rpc] of cases) {
    const renderView = () => render(element(() => {}));
    it(`${name} says why, and does not sit on Loading for ever`, async () => {
      rpc.mockRejectedValueOnce(REFUSED);
      const tree = await renderView();

      // The database's own words, which say more than any wording this screen
      // could invent -- and for a failure that is not a permission one, they
      // say what it actually was.
      const caveat = refusal(tree);
      expect(caveat).toBeDefined();
      expect(String(caveat!.props.children)).toContain('permission to see the books');
      // 'partial' rather than 'wrong': nothing here is the reader's to fix, and
      // a 'wrong' caveat with no action trains people to skip the whole family.
      expect(caveat!.props.tone).toBe('partial');
      expect(caveat!.props.action).toBeUndefined();

      // NOT still loading, which is the defect itself.
      expect(tree.root.findAll((node) => node.props?.children === 'Loading…')).toHaveLength(0);
      // And not the empty state either: "nothing has been posted" is a claim
      // about the shop's books, and this screen has not read them.
      expect(tree.root.findAllByProps({ testID: 'statement-empty' })).toHaveLength(0);
      // No figures at all. A statement left on screen beside a note saying it
      // could not be read gets read anyway.
      expect(moneyRows(tree)).toHaveLength(0);
    });

    it(`${name} clears the message when pull-to-refresh succeeds`, async () => {
      // PULL-TO-REFRESH IS THE OTHER HALF OF THE DEFECT. The screen publishes
      // its `reload` to the shell, which owns the scroller; with the throw
      // uncaught, pulling re-entered the same failure and the screen never
      // moved. Caught, the pull is the way out of a role that has since been
      // fixed -- so `setError(null)` on the success path is load-bearing.
      rpc.mockRejectedValueOnce(REFUSED);
      // useTabRefresh publishes with `setRefresh(() => reload)` -- React would
      // otherwise treat the function as a state updater and call it -- so the
      // value handed here is an updater that RETURNS the screen's reload.
      let pull: (() => Promise<void>) | null = null;
      const setRefresh = ((next: unknown) => {
        pull = typeof next === 'function' ? (next as (prev: null) => typeof pull)(null) : null;
      }) as unknown as RefreshSetter;

      const tree = await render(element(setRefresh));
      expect(refusal(tree)).toBeDefined();
      expect(pull).not.toBeNull();

      await act(async () => {
        await pull!();
      });
      expect(refusal(tree)).toBeUndefined();
      expect(moneyRows(tree).length).toBeGreaterThan(0);
    });
  }
});

describe('the income statement', () => {
  it('renders the rows the function returned, in its order, and asks for the range', async () => {
    const tree = await renderIncome();
    expect(moneyRows(tree).map((node) => node.props.label)).toEqual([
      'Net revenue',
      'Cost of sales',
      'Gross profit',
      'Total operating expenses',
      'Net profit',
    ]);
    // date columns, not toISOString: the latter converts to UTC first, so an
    // evening query west of Greenwich asks for the wrong day.
    expect(mockListStatementLines).toHaveBeenCalledWith('shop-1', '2026-08-01', '2026-08-21', false);
  });

  it('shows the totals the function returned rather than sums of its own', async () => {
    // The fixture's totals do not agree with its parts on purpose. These are
    // the numbers the SQL returned, and they are the only ones the screen may
    // print. A screen that re-derived them would show $600.00 and $300.00.
    const tree = await renderIncome();
    expect(renderedAmount(rowFor(tree, 'Gross profit')!).text).toBe('$575.00');
    expect(renderedAmount(rowFor(tree, 'Net profit')!).text).toBe('-$2.50');
  });

  it('renders a loss as a loss — a sign, not colour alone', async () => {
    const tree = await renderIncome();
    const netProfit = rowFor(tree, 'Net profit')!;
    // The bottom line, so it takes the statement's heaviest variant.
    expect(netProfit.props.variant).toBe('total');
    expect(netProfit.props.amountCents).toBe(-250);
    const { text, color } = renderedAmount(netProfit);
    // THE SIGN IS THE SIGNAL. bentoProfit/bentoLoss is ΔE 4.0 for a deutan
    // reader, so a figure that is red and nothing else says nothing to them.
    expect(text.startsWith('-')).toBe(true);
    // And the colour on top of it, for everyone else.
    expect(color).toBe(theme.bentoLoss);
  });

  it('re-asks with detail: true when the toggle is used', async () => {
    const tree = await renderIncome();
    const pills = tree.root.findByType(TabPills);
    mockIncomeRows = incomeDetail();
    await act(async () => {
      pills.props.onChange('detail');
    });
    expect(mockListStatementLines).toHaveBeenLastCalledWith('shop-1', '2026-08-01', '2026-08-21', true);
    // And the per-account rows arrive with it.
    expect(rowFor(tree, 'Discounts Given')).toBeDefined();
  });

  it('shows an empty state rather than a column of $0.00 for a shop that has never traded', async () => {
    mockIncomeRows = incomeSummary().map((row) => ({ ...row, amountCents: 0 }));
    const tree = await renderIncome();
    expect(tree.root.findAllByProps({ testID: 'statement-empty' }).length).toBeGreaterThan(0);
    expect(moneyRows(tree)).toHaveLength(0);
  });
});

describe('the balance sheet', () => {
  it('is as at ONE date — the end of the range, never the range', async () => {
    await renderBalance();
    expect(mockGetBalanceSheet).toHaveBeenCalledWith('shop-1', '2026-08-21');
  });

  it('shows the totals the function returned rather than sums of its own', async () => {
    // Every one of these is unreachable from the rows around it. A screen that
    // summed its sections would print $551.50 for total assets and $573.00 for
    // the other side; one that summed its accounts would print $560.26 for
    // both. See the fixture.
    const tree = await renderBalance();
    expect(renderedAmount(rowFor(tree, 'Total current assets')!).text).toBe('$401.00');
    expect(renderedAmount(rowFor(tree, 'Total fixed assets')!).text).toBe('$150.50');
    expect(renderedAmount(rowFor(tree, 'Total liabilities')!).text).toBe('$114.00');
    expect(renderedAmount(rowFor(tree, 'Total equity')!).text).toBe('$459.00');
  });

  it('shows both totals, and says the equality is a consequence rather than a check', async () => {
    const tree = await renderBalance();
    expect(renderedAmount(rowFor(tree, 'Total assets')!).text).toBe('$573.10');
    expect(renderedAmount(rowFor(tree, 'Total liabilities and equity')!).text).toBe('$573.10');

    const caveat = tree.root
      .findAllByType(Caveat)
      .find((node) => String(node.props.children).includes('every entry balancing'));
    expect(caveat).toBeDefined();
    // AND IT QUOTES THE ROW, NOT A SUM OF ITS OWN. The caveat opens with the
    // total-assets figure, and it is the second place on this screen that
    // figure appears -- so it is a second chance to compute it. A caveat that
    // added the two section totals up would open "$551.50 on both sides" beside
    // two rows reading $573.10, which is the exact contradiction the sentence
    // after it denies.
    expect(String(caveat!.props.children)).toContain('$573.10');
    // `context`, not `wrong`: the number is right and there is nothing to fix.
    expect(caveat!.props.tone).toBe('context');
    // A `context` caveat that offers an action implies one is needed, which
    // trains readers to ignore the whole family.
    expect(caveat!.props.action).toBeUndefined();
  });

  it('shows an empty state rather than a sheet of $0.00 for a shop that has never traded', async () => {
    mockBalanceRows = balanceRows().map((row) => ({ ...row, amountCents: 0 }));
    const tree = await renderBalance();
    expect(tree.root.findAllByProps({ testID: 'statement-empty' }).length).toBeGreaterThan(0);
    expect(moneyRows(tree)).toHaveLength(0);
  });
});

describe('the cash flow', () => {
  it('renders its proof section', async () => {
    // The proof is the whole reason an indirect cash flow can be trusted: the
    // observed movement in the cash accounts is reached by no part of the
    // arithmetic above it, so a sign slip anywhere lands there. A screen that
    // dropped it would look identical and prove nothing.
    const tree = await renderCash();
    expect(rowFor(tree, 'Cash at 31 Jul 2026')).toBeDefined();
    expect(rowFor(tree, 'Cash at 21 Aug 2026')).toBeDefined();
    const movement = rowFor(tree, 'Movement in cash accounts');
    expect(movement).toBeDefined();
    // -$83.05, not the -$80.80 the two cash balances above it differ by. The
    // movement is the FUNCTION's row, read in the same pass over the ledger; a
    // screen that subtracted the printed balances would show -$80.80.
    expect(renderedAmount(movement!).text).toBe('-$83.05');
    // It has to be readable AGAINST the net change, which is the point of it.
    expect(renderedAmount(rowFor(tree, 'Net change in cash')!).text).toBe('-$83.05');
  });

  it('shows the section totals the function returned rather than sums of its own', async () => {
    // A screen that added its own rows up would print -$57.30, -$7.50 and
    // -$16.00 here. See the fixture: no total on it is reachable from its parts.
    const tree = await renderCash();
    expect(renderedAmount(rowFor(tree, 'Cash from operations')!).text).toBe('-$51.20');
    expect(renderedAmount(rowFor(tree, 'Cash used in investing')!).text).toBe('-$8.15');
    expect(renderedAmount(rowFor(tree, 'Cash used in financing')!).text).toBe('-$17.45');
  });

  it('shows the empty state for a quiet morning, when only the proof rows carry a figure', async () => {
    // THE ORDINARY CASE, not a corner. A shop with $400 in the till that has
    // not traded yet today has a completely flat cash flow -- and two proof
    // rows reading $400, because those are BALANCES rather than movements.
    // Counting them as figures drew twelve lines of $0.00 beside them, which is
    // exactly the wall of zeroes the empty state exists to prevent.
    mockCashRows = cashRows().map((row) =>
      row.section === 'proof' && row.label.startsWith('Cash at') ? { ...row, amountCents: 40_000 } : { ...row, amountCents: 0 }
    );
    const tree = await renderCash();
    expect(tree.root.findAllByProps({ testID: 'statement-empty' }).length).toBeGreaterThan(0);
    expect(moneyRows(tree)).toHaveLength(0);
  });

  it('shows an empty state rather than a statement of $0.00 for a shop that has never traded', async () => {
    mockCashRows = cashRows().map((row) => ({ ...row, amountCents: 0 }));
    const tree = await renderCash();
    expect(tree.root.findAllByProps({ testID: 'statement-empty' }).length).toBeGreaterThan(0);
    expect(moneyRows(tree)).toHaveLength(0);
  });
});
