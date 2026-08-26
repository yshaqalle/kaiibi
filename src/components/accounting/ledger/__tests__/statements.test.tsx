import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { BalanceSheetView } from '@/components/accounting/ledger/balance-sheet-view';
import { CashFlowView } from '@/components/accounting/ledger/cash-flow-view';
import { IncomeStatementView } from '@/components/accounting/ledger/income-statement-view';
import { Caveat } from '@/components/ui/caveat';
import { StatementRow } from '@/components/ui/statement-row';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';
import type { DateRange } from '@/components/range-selector';

// THE SCREENS DO NO ARITHMETIC.
//
// Every subtotal on a financial statement is a row the SQL function returned.
// A screen that adds up its own rows is a second implementation of the
// statement, and the two will disagree the first time a rounding rule or an
// account type changes -- at which point nobody knows which report is right.
//
// That rule is unfalsifiable on a fixture whose totals happen to equal the sum
// of its parts, because both implementations then agree. So the income fixture
// below is DELIBERATELY INCONSISTENT: gross profit is not revenue less cost of
// sales, and net profit is not gross profit less operating expenses. A screen
// that re-derived either would show a different number and these tests would
// redden. Do not "fix" the fixture's arithmetic; the inconsistency is the
// assertion.

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

function balanceRows() {
  return [
    line({ section: 'current_assets', code: '1000', label: 'Cash on Hand', amountCents: 41_826, sortOrder: 101 }),
    line({ section: 'current_assets', label: 'Total current assets', amountCents: 41_826, isTotal: true, sortOrder: 200 }),
    line({ section: 'fixed_assets', code: '1500', label: 'Equipment', amountCents: 14_200, sortOrder: 301 }),
    line({ section: 'fixed_assets', label: 'Total fixed assets', amountCents: 14_200, isTotal: true, sortOrder: 400 }),
    line({ section: 'total_assets', label: 'Total assets', amountCents: 56_026, isTotal: true, sortOrder: 500 }),
    line({ section: 'liabilities', code: '2000', label: 'Accounts Payable', amountCents: 12_000, sortOrder: 601 }),
    line({ section: 'liabilities', label: 'Total liabilities', amountCents: 12_000, isTotal: true, sortOrder: 700 }),
    line({ section: 'equity', code: '3000', label: "Owner's Capital", amountCents: 44_276, sortOrder: 801 }),
    line({ section: 'equity', label: 'Profit this period', amountCents: -250, sortOrder: 801 }),
    line({ section: 'equity', label: 'Total equity', amountCents: 44_026, isTotal: true, sortOrder: 900 }),
    line({ section: 'total_liabilities_equity', label: 'Total liabilities and equity', amountCents: 56_026, isTotal: true, sortOrder: 1000 }),
  ];
}

// cash_flow() returns FIVE columns -- there is no `code` on a cash flow row.
function cashLine(over: Record<string, unknown>) {
  return { section: 'operating', label: '', amountCents: 0, isTotal: false, sortOrder: 0, ...over };
}

function cashRows() {
  return [
    cashLine({ section: 'operating', label: 'Net profit', amountCents: -250, sortOrder: 100 }),
    cashLine({ section: 'operating', label: 'Add back depreciation', amountCents: 930, sortOrder: 110 }),
    cashLine({ section: 'operating', label: 'Increase in inventory', amountCents: -6_410, sortOrder: 130 }),
    cashLine({ section: 'operating', label: 'Cash from operations', amountCents: -5_730, isTotal: true, sortOrder: 200 }),
    cashLine({ section: 'investing', label: 'Bought equipment', amountCents: -750, sortOrder: 310 }),
    cashLine({ section: 'investing', label: 'Cash used in investing', amountCents: -750, isTotal: true, sortOrder: 400 }),
    cashLine({ section: 'financing', label: 'Owner drawings', amountCents: -1_600, sortOrder: 520 }),
    cashLine({ section: 'financing', label: 'Cash used in financing', amountCents: -1_600, isTotal: true, sortOrder: 600 }),
    cashLine({ section: 'net_change', label: 'Net change in cash', amountCents: -8_080, isTotal: true, sortOrder: 700 }),
    cashLine({ section: 'proof', label: 'Cash at 31 Jul 2026', amountCents: 48_475, sortOrder: 810 }),
    cashLine({ section: 'proof', label: 'Cash at 21 Aug 2026', amountCents: 40_395, sortOrder: 820 }),
    cashLine({ section: 'proof', label: 'Movement in cash accounts', amountCents: -8_080, isTotal: true, sortOrder: 830 }),
  ];
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(element);
  });
  return tree!;
}

const renderIncome = () => render(<IncomeStatementView dateRange={RANGE} setRefresh={() => {}} />);
const renderBalance = () => render(<BalanceSheetView dateRange={RANGE} setRefresh={() => {}} />);
const renderCash = () => render(<CashFlowView dateRange={RANGE} setRefresh={() => {}} />);

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

  it('shows both totals, and says the equality is a consequence rather than a check', async () => {
    const tree = await renderBalance();
    expect(renderedAmount(rowFor(tree, 'Total assets')!).text).toBe('$560.26');
    expect(renderedAmount(rowFor(tree, 'Total liabilities and equity')!).text).toBe('$560.26');

    const caveat = tree.root
      .findAllByType(Caveat)
      .find((node) => String(node.props.children).includes('every entry balancing'));
    expect(caveat).toBeDefined();
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
    expect(renderedAmount(movement!).text).toBe('-$80.80');
    // It has to be readable AGAINST the net change, which is the point of it.
    expect(renderedAmount(rowFor(tree, 'Net change in cash')!).text).toBe('-$80.80');
  });

  it('shows an empty state rather than a statement of $0.00 for a shop that has never traded', async () => {
    mockCashRows = cashRows().map((row) => ({ ...row, amountCents: 0 }));
    const tree = await renderCash();
    expect(tree.root.findAllByProps({ testID: 'statement-empty' }).length).toBeGreaterThan(0);
    expect(moneyRows(tree)).toHaveLength(0);
  });
});
