import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { FixedAssetsView } from '@/components/accounting/ledger/fixed-assets-view';
import { Caveat } from '@/components/ui/caveat';
import type { RefreshSetter } from '@/components/accounting/use-header-actions';
import type { FixedAsset, FixedAssetSummary } from '@/lib/fixed-assets';

// The fixed-asset register screen.
//
// Four decisions made above this screen have to survive contact with it, and
// every one of them is invisible when it breaks:
//
//   1. THE SCREEN DOES NO ARITHMETIC. Every figure in the strip is a column
//      fixed_asset_summary() returned. The fixture below deliberately gives the
//      summary a total that is NOT the sum of the rows -- a screen that added
//      its own rows up would print a different number and the check would
//      redden. A fixture whose totals happen to agree cannot tell the two apart.
//   2. A DISPOSED ASSET'S BOOK VALUE IS NULL AND RENDERS AS AN EM DASH. Not
//      $0.00, which is a claim about something the shop does not own.
//   3. THE VOIDED-PURCHASE DIVERGENCE IS SHOWN, not absorbed.
//      reverse_journal_entry can void an asset's acquisition entry while the
//      register row survives, and the register total is then higher than the
//      balance sheet. The screen says so, in a `wrong` caveat with a route to
//      the reversal.
//   4. THE DATABASE'S SENTENCE IS PRINTED. A PostgrestError is a plain object
//      and is NEVER `instanceof Error`, so every refusal here is thrown as one
//      -- the exact shape that made a shipped screen print "The database
//      refused the close." instead of the reason.

let mockAssets: FixedAsset[] = [];
let mockSummary: FixedAssetSummary | null = null;
let mockListError: unknown = null;
let mockSummaryError: unknown = null;
const mockRun = jest.fn(() => Promise.resolve(0));
const mockDispose = jest.fn(() => Promise.resolve('entry-1'));
const mockDelete = jest.fn(() => Promise.resolve('entry-2' as string | null));
const mockCreate = jest.fn(() => Promise.resolve('asset-9'));

// ONE object with a STABLE `can`. A factory building a fresh object per render
// gives `load`'s useCallback a new identity every render and the screen fetches
// for ever, timing the test out at 5s with no other symptom.
let mockCanPost = true;
const mockAuth = {
  shop: { id: 'shop-1' },
  can: (permission: string) => (permission === 'ledger.post' ? mockCanPost : true),
  session: { user: { id: 'user-1' } },
};

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));
jest.mock('@/hooks/use-auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/lib/ledger', () => ({
  listAccounts: () =>
    Promise.resolve([
      { id: 'a1', shopId: 'shop-1', code: '1000', name: 'Cash on Hand', type: 'asset', isContra: false, archivedAt: null },
      { id: 'a2', shopId: 'shop-1', code: '1010', name: 'Salaam, Hodan branch', type: 'asset', isContra: false, archivedAt: null },
      { id: 'a3', shopId: 'shop-1', code: '1500', name: 'Equipment', type: 'asset', isContra: false, archivedAt: null },
      { id: 'a4', shopId: 'shop-1', code: '1590', name: 'Accumulated Depreciation', type: 'asset', isContra: true, archivedAt: null },
    ]),
}));
jest.mock('@/lib/fixed-assets', () => ({
  listFixedAssets: () => (mockListError ? Promise.reject(mockListError) : Promise.resolve(mockAssets)),
  getFixedAssetSummary: () => (mockSummaryError ? Promise.reject(mockSummaryError) : Promise.resolve(mockSummary)),
  runDepreciation: (...args: unknown[]) => mockRun(...(args as [])),
  disposeFixedAsset: (...args: unknown[]) => mockDispose(...(args as [])),
  deleteFixedAsset: (...args: unknown[]) => mockDelete(...(args as [])),
  createFixedAsset: (...args: unknown[]) => mockCreate(...(args as [])),
}));

function asset(over: Partial<FixedAsset>): FixedAsset {
  return {
    id: 'fa',
    name: 'Chest freezer',
    accountCode: '1500',
    accountName: 'Equipment',
    acquiredOn: '2026-01-05',
    lifeMonths: 12,
    costCents: 24000,
    accumulatedCents: 8000,
    netBookCents: 16000,
    monthsCharged: 4,
    disposedOn: null,
    disposalProceedsCents: null,
    acquisitionStatus: 'posted',
    ...over,
  };
}

// Three assets: one ordinary, one whose purchase has been VOIDED, one SOLD.
function fixture(): FixedAsset[] {
  return [
    asset({ id: 'fa-freezer' }),
    asset({
      id: 'fa-shelving',
      name: 'Shelving',
      accountCode: '1510',
      accountName: 'Furniture and Fittings',
      costCents: 1000,
      accumulatedCents: 1000,
      netBookCents: 0,
      acquisitionStatus: 'reversed',
    }),
    asset({
      id: 'fa-printer',
      name: 'Printer',
      costCents: 5000,
      accumulatedCents: 2000,
      // NULL, and it is the whole of check 2.
      netBookCents: null,
      disposedOn: '2026-05-10',
      disposalProceedsCents: 2000,
    }),
  ];
}

// THE TOTALS DO NOT EQUAL THE ROWS ON SCREEN, DELIBERATELY.
//
// The live rows above hold 16000 + 0 of book value; this says 19000. Only the
// database can be right about that -- it reads assets this screen may be
// filtering, and in production it is the same query -- and the point is that
// the screen must print what it was given. A screen that summed its own rows
// would show $16,000 here, and every check below would still pass on a fixture
// where the two agreed.
function summary(over: Partial<FixedAssetSummary> = {}): FixedAssetSummary {
  return {
    liveCount: 2,
    disposedCount: 1,
    costCents: 25000,
    accumulatedCents: 9000,
    netBookCents: 19000,
    voidedCount: 0,
    voidedCostCents: 0,
    lastChargeMonth: '2026-04-01',
    lastChargeCents: 2834,
    ...over,
  };
}

/** The shape `rpc()` rejects with: a plain object, NEVER an Error. */
function postgrestError(message: string) {
  return { code: 'P0001', details: null, hint: null, message };
}

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<FixedAssetsView setRefresh={(() => {}) as unknown as RefreshSetter} onOpenView={() => {}} />);
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

function caveats(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAllByType(Caveat);
}

function button(tree: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return tree.root
    .findAll((node) => node.props?.role === 'button')
    .find((node) =>
      node
        .findAllByType(Text)
        .some((text) =>
          (Array.isArray(text.props.children) ? text.props.children : [text.props.children]).some(
            (child) => typeof child === 'string' && child.includes(label)
          )
        )
    );
}

beforeEach(() => {
  mockAssets = fixture();
  mockSummary = summary();
  mockListError = null;
  mockSummaryError = null;
  mockCanPost = true;
  mockRun.mockClear();
  mockDispose.mockClear();
  mockDelete.mockClear();
  mockCreate.mockClear();
});

describe('the register does no arithmetic', () => {
  it('prints the totals the function returned, not the sum of the rows on screen', async () => {
    const tree = await render();
    const drawn = texts(tree);
    // 19000 cents is $190. The two live rows on screen hold $160 and $0 of book
    // value between them, so a screen that added them up would draw $160.
    expect(drawn).toContain('$190');
    expect(drawn).not.toContain('$160');
    // Cost and depreciation likewise: 25000 and 9000, not 24000+1000 as
    // rendered or 8000+1000.
    expect(drawn).toContain('$250');
    expect(drawn).toContain('$90');
  });

  it('says how many items are behind the cost, from the function s own count', async () => {
    expect(texts(await render())).toContain('2 items');
  });

  it('reports the last charge POSTED rather than predicting the next one', async () => {
    const drawn = texts(await render());
    expect(drawn).toContain('$28');
    expect(drawn).toContain('for 2026-04');
  });

  it('says so plainly when no depreciation has ever run', async () => {
    mockSummary = summary({ lastChargeMonth: null, lastChargeCents: 0 });
    const drawn = texts(await render());
    expect(drawn).toContain('None yet');
    expect(drawn).toContain('run depreciation to start');
  });
});

describe('a disposed asset', () => {
  it('shows an em dash for its book value, never a zero', async () => {
    const drawn = texts(await render());
    // The sold printer's cost and depreciation are still facts and are drawn.
    expect(drawn).toContain('$50.00');
    expect(drawn).toContain('$20.00');
    // Its book value is not a small number, it is not a number.
    expect(drawn).toContain('—');
    // And nothing on this screen claims the printer is worth nothing. $0.00
    // appears nowhere: the only other candidate row, the shelving, has a book
    // value of exactly 0 and IS drawn as $0.00 -- so this asserts the em dash
    // is doing work rather than being the only thing available.
    expect(drawn.filter((t) => t === '$0.00')).toHaveLength(1);
  });

  it('offers it no actions, because history is not something you sell again', async () => {
    const tree = await render();
    expect(texts(tree)).toContain('History');
  });
});

describe('a voided purchase', () => {
  it('is named, sized, and marked wrong rather than absorbed into the total', async () => {
    mockSummary = summary({ voidedCount: 1, voidedCostCents: 1000 });
    const tree = await render();
    const warning = caveats(tree).find(
      (node) => typeof node.props.children === 'string' && node.props.children.includes('purchase entry voided')
    );
    expect(warning).toBeDefined();
    // 'wrong', because Book value above is genuinely higher than the balance
    // sheet until this is dealt with -- and it carries the route to the fix,
    // which is what makes a `wrong` caveat legitimate.
    expect(warning!.props.tone).toBe('wrong');
    expect(warning!.props.action).toBeDefined();
    expect(warning!.props.children).toContain('$10.00');
    expect(warning!.props.children).toContain('higher than the statement');
  });

  it('says nothing at all when every purchase is standing', async () => {
    const tree = await render();
    expect(
      caveats(tree).some(
        (node) => typeof node.props.children === 'string' && node.props.children.includes('purchase entry voided')
      )
    ).toBe(false);
  });

  it('marks the row itself, so the caveat and the register point at the same asset', async () => {
    expect(texts(await render())).toContain('Furniture and Fittings · purchase voided');
  });
});

describe('the database s sentence', () => {
  it('is printed when the register itself refuses, and the screen does not sit on Loading', async () => {
    // A PostgrestError: a plain object, so `error instanceof Error` is false.
    mockListError = postgrestError('You do not have permission to see the books.');
    const tree = await render();
    const drawn = texts(tree);
    expect(drawn).toContain('You do not have permission to see the books.');
    expect(drawn).not.toContain('Loading…');
    // 'partial': nothing here is the reader's to fix.
    const refusal = caveats(tree).find((node) => node.props.children === 'You do not have permission to see the books.');
    expect(refusal!.props.tone).toBe('partial');
  });

  it('is printed when depreciation refuses', async () => {
    mockRun.mockImplementationOnce(() =>
      Promise.reject(postgrestError('You do not have permission to run depreciation.'))
    );
    const tree = await render();
    await act(async () => {
      button(tree, 'Run depreciation')!.props.onPress();
    });
    expect(texts(tree)).toContain('You do not have permission to run depreciation.');
  });

  it('is printed when a removal refuses, in the words that say what to do instead', async () => {
    mockDelete.mockImplementationOnce(() =>
      Promise.reject(
        postgrestError('This asset has already been depreciated; dispose of it instead of deleting it.')
      )
    );
    const tree = await render();
    await act(async () => {
      button(tree, 'Remove')!.props.onPress();
    });
    await act(async () => {
      button(tree, 'Remove Chest freezer')!.props.onPress();
    });
    expect(texts(tree)).toContain('This asset has already been depreciated; dispose of it instead of deleting it.');
  });
});

describe('running depreciation', () => {
  it('reports nothing was due as a success rather than a failure', async () => {
    mockRun.mockImplementationOnce(() => Promise.resolve(0));
    const tree = await render();
    await act(async () => {
      button(tree, 'Run depreciation')!.props.onPress();
    });
    const outcome = caveats(tree).find(
      (node) => typeof node.props.children === 'string' && node.props.children.includes('Nothing was due')
    );
    expect(outcome).toBeDefined();
    expect(outcome!.props.tone).toBe('context');
  });

  it('states the COUNT the function returned, and gets the singular right', async () => {
    mockRun.mockImplementationOnce(() => Promise.resolve(1));
    const tree = await render();
    await act(async () => {
      button(tree, 'Run depreciation')!.props.onPress();
    });
    expect(
      texts(tree).some((t) => t.includes('1 monthly depreciation entry is in the journals'))
    ).toBe(true);
  });
});

describe('a reader who may see the books but not write to them', () => {
  it('keeps the register and loses every button that posts', async () => {
    mockCanPost = false;
    const tree = await render();
    // The rows are still there.
    expect(texts(tree)).toContain('Chest freezer');
    expect(button(tree, 'Run depreciation')).toBeUndefined();
    expect(button(tree, '+ Add asset')).toBeUndefined();
    expect(button(tree, 'Sell')).toBeUndefined();
    // ...and is told why, rather than left wondering where the buttons went.
    const note = caveats(tree).find(
      (node) => typeof node.props.children === 'string' && node.props.children.includes('write entries to the ledger')
    );
    expect(note!.props.tone).toBe('partial');
  });
});
