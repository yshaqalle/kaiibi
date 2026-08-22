// The seam, not the library.
//
// scan-sink.test.ts drives `stepFieldSink`/`fieldSinkScan` directly and every
// case in it was green through two shipped defects, because both of them lived
// in the wiring rather than in the machine:
//
//  1. `ScanSafeField` restored the typed number with a queued setState and then
//     called `onScan` synchronously, so the sheet's `addByCode` counted from a
//     basket that still held the barcode. Scanning an item while the cursor sat
//     in THAT item's own quantity box replaced a typed 24 with 1 on Restock,
//     and produced a move of 8,809,611,860,019 on Move.
//  2. A barcode beginning with 0 -- every UPC-A read as EAN-13 -- was handed to
//     `QuantityField`'s normalising parent as the number 0, which renders as an
//     empty box and, on the Move sheet, deletes the line and unmounts the field
//     mid-burst.
//
// So everything below renders the real component in front of a real parent.

import { useState } from 'react';
import { Platform, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ScanSafeField } from '@/components/scan-safe-field';
import { DEFAULT_WEDGE_CONFIG } from '@/lib/barcode-wedge';

// Both sheets gate every scan path on `Platform.OS === 'web'` (see
// `canScanInSheet`), which is the platform these defects are reachable on and
// not the one Jest reports. Set before the modals are imported below.
Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [
      { id: 'loc-1', name: 'Main', active: true },
      { id: 'loc-2', name: 'Second', active: true },
    ],
    activeLocation: { id: 'loc-1', name: 'Main', active: true },
  }),
}));

// Camera off, wedge on: the pill and BarcodeScannerModal are not what is under
// test, and rendering the camera needs a device.
jest.mock('@/hooks/use-scanner-settings', () => ({
  useScannerSettings: () => ({
    camera: false,
    hardware: true,
    resolveCodes: true,
    onScreenKeypad: false,
    hardwareSetting: true,
  }),
}));

// Binds to the screen being in front through expo-router's useFocusEffect,
// which asks for a navigation object this renderer has no tree to provide. The
// focus-nowhere path is not the one these tests exercise.
jest.mock('@/hooks/use-barcode-wedge', () => ({ useBarcodeWedge: () => {} }));

jest.mock('@/lib/categories', () => ({ listCategories: jest.fn(async () => []) }));
jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
jest.mock('@/lib/expenses', () => ({ createExpense: jest.fn(async () => ({})) }));

const BARCODE = '0885909950805';

jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(async () => [
    {
      id: 'p-1',
      shopId: 'shop-1',
      name: 'QA widget',
      description: null,
      sku: 'QA-1',
      barcode: '0885909950805',
      brand: null,
      category: null,
      tags: [],
      supplierName: null,
      costCents: 250,
      priceCents: 500,
      stock: 40,
      reorderLevel: null,
      shelfNumber: null,
      expiryDate: null,
      batchNumber: null,
      imageUrl: null,
      isListedOnline: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]),
  receiveStock: jest.fn(async () => {}),
  transferStock: jest.fn(async () => {}),
  setLocationStock: jest.fn(async () => {}),
}));

const { receiveStock } = jest.requireMock('@/lib/products') as { receiveStock: jest.Mock };

// Everything on screen, for the banners a wrong reading produces.
function screenText(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((t) => [t.props.children].flat(Infinity))
    .filter((child) => typeof child === 'string' || typeof child === 'number')
    .join('');
}

// Imported after the Platform override and the mocks above.
// eslint-disable-next-line import/first
import { StockRestockModal } from '@/components/stock-restock-modal';
// eslint-disable-next-line import/first
import { StockTransferModal } from '@/components/stock-transfer-modal';

// Fake timers do double duty: they stop the withheld-text flush from firing
// between a scanner's characters, and -- being modern timers -- they move
// Date.now() with them, which is the only clock the burst machine reads.
beforeEach(() => {
  jest.useFakeTimers();
  receiveStock.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

// The INNERMOST node carrying the label and an onChangeText -- the TextInput
// `ScanSafeField` renders, not the ScanSafeField element itself. Driving the
// outer one hands text straight to the screen and tests nothing that is here.
function field(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const found = tree.root.findAll(
    (node) =>
      (node.props?.['aria-label'] === label || node.props?.accessibilityLabel === label) &&
      typeof node.props?.onChangeText === 'function' &&
      typeof node.props?.onSubmitEditing === 'function'
  );
  if (found.length === 0) throw new Error(`no scan-safe field labelled ${label}`);
  return found[found.length - 1];
}

// Duck-typed rather than found by component type: RN 0.86's Pressable is a
// memo, and React 19's test renderer collapses a memo's fiber type.
async function press(tree: ReactTestRenderer, label: string) {
  const target = tree.root
    .findAll((node) => typeof node.props?.onPress === 'function')
    .find((node) =>
      node
        .findAllByType(Text)
        .flatMap((t) => [t.props.children].flat(Infinity))
        .filter((child) => typeof child === 'string' || typeof child === 'number')
        .join('')
        .includes(label)
    );
  if (!target) throw new Error(`no pressable saying ${label}`);
  await act(async () => {
    await target.props.onPress();
  });
}

function shown(tree: ReactTestRenderer, label: string): string {
  return field(tree, label).props.value ?? '';
}

// A hardware scanner: every character within `maxInterKeyMs` of the last, then
// the trailing Enter that `onSubmitEditing` is.
function scanInto(tree: ReactTestRenderer, label: string, code: string) {
  for (const character of code) {
    const input = field(tree, label);
    const next = `${input.props.value ?? ''}${character}`;
    act(() => input.props.onChangeText(next));
    act(() => jest.advanceTimersByTime(5));
  }
  act(() => field(tree, label).props.onSubmitEditing());
}

// A person: well outside `maxInterKeyMs`, so every character reaches the screen
// on its own.
function typeInto(tree: ReactTestRenderer, label: string, text: string) {
  for (const character of text) {
    const input = field(tree, label);
    const next = `${input.props.value ?? ''}${character}`;
    act(() => input.props.onChangeText(next));
    act(() => jest.advanceTimersByTime(200));
  }
}

// The shape `QuantityField` has and the Restock boxes do not: state that is a
// NUMBER, so what comes back out is a rewrite of what went in -- and 0 comes
// back as an empty box.
function NormalisingParent({ onScan, told }: { onScan: (code: string) => void; told: string[] }) {
  const [quantity, setQuantity] = useState(12);
  return (
    <ScanSafeField
      value={quantity === 0 ? '' : String(quantity)}
      onChangeText={(text) => {
        told.push(text);
        const digits = text.replace(/[^0-9]/g, '');
        setQuantity(digits ? Number(digits) : 0);
      }}
      onScan={onScan}
      aria-label="Quantity"
    />
  );
}

describe('ScanSafeField in front of a parent that rewrites what it is given', () => {
  it('keeps the typed number, and never hands the screen a digit of the code', () => {
    const onScan = jest.fn();
    const told: string[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<NormalisingParent onScan={onScan} told={told} />);
    });

    expect(shown(tree, 'Quantity')).toBe('12');
    scanInto(tree, 'Quantity', BARCODE);

    // The leading zero is the whole case: handed straight to this parent it
    // becomes the number 0, which renders as '' -- no longer what the field is
    // showing, so the burst and its restore point were thrown away. On the Move
    // sheet the same 0 deletes the line and unmounts the field outright.
    expect(told).toEqual([]);
    expect(onScan).toHaveBeenCalledWith(BARCODE);
    expect(shown(tree, 'Quantity')).toBe('12');
  });

  it('gives a hand-typed number to the screen and leaves it alone on Enter', () => {
    const onScan = jest.fn();
    const told: string[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<NormalisingParent onScan={onScan} told={told} />);
    });

    typeInto(tree, 'Quantity', '4');
    expect(told).toEqual(['124']);
    expect(shown(tree, 'Quantity')).toBe('124');

    act(() => field(tree, 'Quantity').props.onSubmitEditing());
    expect(onScan).not.toHaveBeenCalled();
    expect(shown(tree, 'Quantity')).toBe('124');
  });

  it('puts the box back when a scanner sends no terminator at all', () => {
    const onScan = jest.fn();
    const told: string[] = [];
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<NormalisingParent onScan={onScan} told={told} />);
    });

    for (const character of BARCODE) {
      const input = field(tree, 'Quantity');
      act(() => input.props.onChangeText(`${input.props.value ?? ''}${character}`));
      act(() => jest.advanceTimersByTime(5));
    }
    act(() => jest.advanceTimersByTime(DEFAULT_WEDGE_CONFIG.maxTerminatorGapMs + 1));

    // A scan that does nothing is the acceptable failure here. A barcode left
    // in the box as a quantity is not.
    expect(told).toEqual([]);
    expect(onScan).not.toHaveBeenCalled();
    expect(shown(tree, 'Quantity')).toBe('12');
  });
});

const RECEIVED = 'Units of QA widget received';
const MOVING = 'Quantity of QA widget';

// The motion every earlier verification pass missed: the cursor is in an item's
// own quantity box, with a real number in it, and THAT item is scanned.
describe('scanning an item while the cursor is in that same item’s quantity box', () => {
  it('Restock counts from the number in the box, not from the barcode', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });

    await press(tree, 'Add');

    // The row is seeded at 1; replace it the way a person does.
    act(() => field(tree, RECEIVED).props.onChangeText(''));
    act(() => jest.advanceTimersByTime(200));
    typeInto(tree, RECEIVED, '24');
    expect(shown(tree, RECEIVED)).toBe('24');

    scanInto(tree, RECEIVED, BARCODE);

    // 25, because one more unit physically arrived. Before the fix
    // `readTypedQuantity` was handed the barcode, refused it as too large, and
    // the delivery was recorded as 1.
    expect(shown(tree, RECEIVED)).toBe('25');
  });

  it('Move counts from the number in the box, not from the barcode', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockTransferModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });

    typeInto(tree, MOVING, '12');
    expect(shown(tree, MOVING)).toBe('12');

    scanInto(tree, MOVING, BARCODE);

    // 13. Before the fix this read 8809611860019-shaped: the barcode plus one.
    expect(shown(tree, MOVING)).toBe('13');
  });
});

// A PASTE is not a scan, and the difference is not something either field
// wrapper can see -- it is `stepFieldBurst`'s, which now requires a burst to
// grow exactly one character per change.
//
// A paste arrives as ONE `onChangeText` carrying the whole string. Counted by
// characters rather than by changes it reached code length instantly, so
// `ScanSafeField` armed the terminator wait, withheld the text from the screen,
// and a second later put the box silently back to what it held before --
// blurring did the same at once. On web this is Restock's Received and Unit
// cost boxes, its search box, and Move's quantity box: pasting 1500 into
// Received left 1, and since clicking Receive blurs first, 1 is what committed.
describe('a number pasted into a box a scanner can also type into', () => {
  it('survives the blur that pressing Receive performs', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });
    await press(tree, 'Add');

    // Cleared, then the whole string in ONE change. Clearing first is what a
    // person does and it is also what makes the paste four characters long
    // rather than three: `minLength` is 4, so pasting 1500 over the row's
    // seeded "1" happened to survive while pasting it into an empty box did
    // not -- which is exactly the kind of near-miss that kept this hidden.
    act(() => field(tree, RECEIVED).props.onChangeText(''));
    act(() => jest.advanceTimersByTime(200));
    act(() => field(tree, RECEIVED).props.onChangeText('1500'));
    act(() => field(tree, RECEIVED).props.onBlur?.({}));

    expect(shown(tree, RECEIVED)).toBe('1500');
    await press(tree, 'Receive 1500 units');
    expect(receiveStock.mock.calls[0][2]).toEqual([{ productId: 'p-1', quantity: 1500, unitCostCents: null }]);
  });

  it('is not handed to the basket as a scanned code when Enter follows it', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });
    await press(tree, 'Add');

    act(() => field(tree, RECEIVED).props.onChangeText(''));
    act(() => jest.advanceTimersByTime(200));
    act(() => field(tree, RECEIVED).props.onChangeText('1500'));
    act(() => field(tree, RECEIVED).props.onSubmitEditing());

    // Before the fix: the four digits were read as a barcode, looked up
    // against the catalogue, and the box was restored to "1" -- so the shop
    // got "No product matches 1500" and a delivery of one unit.
    expect(shown(tree, RECEIVED)).toBe('1500');
    expect(screenText(tree)).not.toContain('No product matches');
  });

  it('still lets a real scanner through, one character at a time', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });
    await press(tree, 'Add');
    act(() => field(tree, RECEIVED).props.onChangeText(''));
    act(() => jest.advanceTimersByTime(200));
    typeInto(tree, RECEIVED, '24');

    scanInto(tree, RECEIVED, BARCODE);
    expect(shown(tree, RECEIVED)).toBe('25');
  });
});
