import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { StockTransferModal } from '@/components/stock-transfer-modal';

// This door had no test file before this suite. What follows is deliberately
// narrow -- it proves the one thing this change touches (commitPlan's tail),
// not the whole of Move: the by-hand basket, scanning and the count-repair
// flow are unchanged by this fix and are not exercised here.
//
// Mocking follows stock-restock-modal.test.tsx exactly: that suite exercises
// the identical useAuth / useScannerSettings / useBarcodeWedge hook stack
// (Move is that file's own sibling, "deliberately the same shape" per its own
// header comment) without needing to mock useScannerSettings or
// BarcodeScannerModal, so neither is mocked here either.

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [
      { id: 'loc-1', name: 'Main', active: true },
      { id: 'loc-2', name: 'Second', active: true },
    ],
    activeLocation: { id: 'loc-1', name: 'Main', active: true },
  }),
}));

jest.mock('@/lib/categories', () => ({ listCategories: jest.fn(async () => []) }));

const product = (over: Record<string, unknown>) => ({
  id: 'p-1',
  shopId: 'shop-1',
  name: 'QA widget',
  description: null,
  sku: 'QA-1',
  barcode: null,
  brand: null,
  category: null,
  tags: [],
  supplierName: null,
  costCents: 250,
  priceCents: 500,
  stock: 10,
  reorderLevel: null,
  shelfNumber: null,
  expiryDate: null,
  batchNumber: null,
  imageUrl: null,
  isListedOnline: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(async () => []),
  setLocationStock: jest.fn(async () => {}),
  transferStock: jest.fn(async () => {}),
}));
const { listProducts, transferStock } = jest.requireMock('@/lib/products') as {
  listProducts: jest.Mock;
  transferStock: jest.Mock;
};

jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
const { pickCsvFile } = jest.requireMock('@/lib/pick-csv-file') as { pickCsvFile: jest.Mock };

// The sheet's own wedge (web only, and off entirely on the platform Jest
// reports) binds to the screen being in FRONT, through expo-router's
// `useFocusEffect` -- which asks for a navigation object this renderer has no
// tree to provide. Nothing below is about scanning, so the hook is stubbed
// rather than the whole component being wrapped in a navigator it never has
// in the app either. Same precedent as stock-restock-modal.test.tsx.
jest.mock('@/hooks/use-barcode-wedge', () => ({ useBarcodeWedge: () => {} }));

function textOf(node: ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .flatMap((t) => [t.props.children].flat(Infinity))
    .filter((child) => typeof child === 'string' || typeof child === 'number')
    .join('');
}

function screenText(tree: ReactTestRenderer): string {
  return textOf(tree.root);
}

// Duck-typed rather than found by component type: RN 0.86's Pressable is a
// memo, and React 19's test renderer collapses a memo's fiber type, so
// findAllByType(Pressable) matches nothing (see search-row.test.tsx).
function pressableSaying(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const target = tree.root
    .findAll((node) => typeof node.props?.onPress === 'function')
    .find((node) => textOf(node).includes(label));
  if (!target) throw new Error(`no pressable saying ${label}`);
  return target;
}

// Awaited, always: the Move button's handler is async, and an act() whose
// callback returns an unawaited promise leaks its scope into the next test --
// which surfaces as the NEXT renderer reporting itself unmounted.
async function press(tree: ReactTestRenderer, label: string) {
  const target = pressableSaying(tree, label);
  await act(async () => {
    await target.props.onPress();
  });
}

beforeEach(() => {
  transferStock.mockClear();
  transferStock.mockResolvedValue(undefined);
});

// CsvImportModal's own precedent (see its `step === 'done'` branch): a report
// with something left to see stays open. Before this fix, commitPlan called
// closeAndReset whenever every pair went through, whether or not
// `plan.rejected` still had rows on it -- so a move sheet mixing good rows
// with bad ones lost the rejected list and its download button the instant
// the good rows landed, with no way back to the rows that needed fixing.
describe('StockTransferModal sheet-tab commit with rejects', () => {
  function uploadOnePairAndOneReject() {
    listProducts.mockResolvedValue([product({})]);
    pickCsvFile.mockResolvedValueOnce({
      status: 'ok',
      fileName: 'move.csv',
      parsed: {
        headers: ['Product', 'SKU', 'Barcode', 'From store', 'Quantity now', 'To store', 'Quantity to move', 'Note'],
        rows: [
          {
            Product: 'QA widget',
            SKU: 'QA-1',
            Barcode: '',
            'From store': 'Main',
            'Quantity now': '10',
            'To store': 'Second',
            'Quantity to move': '4',
            Note: '',
          },
          {
            Product: 'Nonexistent widget',
            SKU: '',
            Barcode: '',
            'From store': 'Main',
            'Quantity now': '',
            'To store': 'Second',
            'Quantity to move': '2',
            Note: '',
          },
        ],
      },
    });
  }

  it('stays open, says what moved and what did not, and keeps the rejected rows reachable', async () => {
    uploadOnePairAndOneReject();
    const onClose = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockTransferModal visible shopId="shop-1" onClose={onClose} onDone={jest.fn(async () => {})} />);
    });
    await press(tree, 'By sheet');
    await press(tree, 'Upload a filled sheet');

    // One pair (Main -> Second) accepted, one row rejected -- a rejection
    // keeps `handedOver` false regardless of pair count, so this plan stays
    // on the sheet tab for `commitPlan` rather than being handed to the
    // by-hand tab.
    expect(screenText(tree)).toContain('1 moves ready');
    expect(screenText(tree)).toContain('1 rejected');

    await press(tree, 'Move stock');

    // The one good pair actually moved.
    expect(transferStock).toHaveBeenCalledTimes(1);
    expect(transferStock).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      'loc-2',
      [{ productId: 'p-1', quantity: 4 }],
      null
    );

    // The sheet stayed open -- the whole point of this fix.
    expect(onClose).not.toHaveBeenCalled();

    // It says plainly that the commit succeeded, and names what did not.
    expect(screenText(tree)).toContain('1 product · 4 units moved across 1 store pair. 1 row rejected.');

    // The rejected row, its reason and its download are all still here --
    // nothing about a successful write clears `plan.rejected`.
    expect(screenText(tree)).toContain("WHAT WON'T");
    expect(screenText(tree)).toContain('Row 3');
    expect(screenText(tree)).toContain('No product matches "Nonexistent widget"');
    expect(screenText(tree)).toContain('Download rejected rows');

    // The committed plan cannot be committed again: `plan.pairs` is already
    // empty, so the button is structurally dead rather than merely unlucky
    // to be pressed at a bad time.
    expect(pressableSaying(tree, 'Move stock').props.disabled).toBe(true);
  });

  // The hazard this branch has fought twice: a failed reload leaving a full
  // basket under a live button, so pressing it again repeats the write.
  // Keeping the sheet open after a SUCCESSFUL commit is exactly the
  // condition that bug lives under, so this presses the same button again
  // and checks the RPC's own call count -- text would stay green even if the
  // guard below it were deleted.
  it('cannot move the same rows twice once the sheet stays open after a successful commit', async () => {
    uploadOnePairAndOneReject();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockTransferModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });
    await press(tree, 'By sheet');
    await press(tree, 'Upload a filled sheet');
    await press(tree, 'Move stock');
    expect(transferStock).toHaveBeenCalledTimes(1);

    // Same button, pressed again, with the sheet still open and the pair it
    // already moved still named on screen.
    await press(tree, 'Move stock');
    expect(transferStock).toHaveBeenCalledTimes(1);
  });
});
