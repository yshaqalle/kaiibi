import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { StockRestockModal } from '@/components/stock-restock-modal';
import { formatCents } from '@/lib/currency';

// The half of the restock input handling that restock-typed-input.test.ts
// cannot reach.
//
// That suite tests a pure function against finished strings. Both wrong costs
// that shipped from this screen were finished-string-correct: they lived HERE,
// in setCost/setQuantity, where a normalising .replace() rewrote the field
// between keystrokes so that the next character landed on text the person never
// typed. A test that feeds whole strings to the classifier stays green through
// both of them.
//
// So every case below is driven the way a controlled TextInput actually drives
// it: read the field's current value, append ONE character, hand that back to
// the component's own onChangeText, then read the field again. If anything in
// this component ever rewrites the text on its way into state, the recorded
// state after some keystroke stops equalling what was typed and these go red.
//
// The cost field is the one that matters most: committing this sheet overwrites
// products.cost_cents, so a misread cost silently corrupts stock-at-cost and
// gross profit app-wide.

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

jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(async () => [
    {
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
    },
  ]),
  receiveStock: jest.fn(async () => {}),
}));

const { receiveStock } = jest.requireMock('@/lib/products') as { receiveStock: jest.Mock };

jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
const { pickCsvFile } = jest.requireMock('@/lib/pick-csv-file') as { pickCsvFile: jest.Mock };

const COST = 'Unit cost of QA widget';
const QUANTITY = 'Units of QA widget received';

// Reassembles an interpolated <Text>, whose children React splits into several
// nodes ("Receive ", 24, " unit", "s").
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
//
// Awaited, always: the Receive button's handler is async, and an act() whose
// callback returns an unawaited promise leaks its scope into the next test --
// which surfaces as the NEXT renderer reporting itself unmounted.
async function press(tree: ReactTestRenderer, label: string) {
  const target = tree.root
    .findAll((node) => typeof node.props?.onPress === 'function')
    .find((node) => textOf(node).includes(label));
  if (!target) throw new Error(`no pressable saying ${label}`);
  await act(async () => {
    await target.props.onPress();
  });
}

// The outermost node carrying both props IS the element this component
// rendered, so `.props.value` is the string the component put in the field.
function field(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const found = tree.root.findAll(
    (node) => node.props?.['aria-label'] === label && typeof node.props?.onChangeText === 'function'
  );
  if (found.length === 0) throw new Error(`no field labelled ${label}`);
  return found[0];
}

// One keystroke: whatever is in the field now, plus the character. This is the
// controlled-input loop the component is wired into, and the only way a
// rewrite-on-change is visible.
function keystroke(tree: ReactTestRenderer, label: string, character: string): string {
  const input = field(tree, label);
  const next = `${input.props.value ?? ''}${character}`;
  act(() => input.props.onChangeText(next));
  return field(tree, label).props.value;
}

// Every intermediate state, in order.
function typeInto(tree: ReactTestRenderer, label: string, typed: string): string[] {
  return [...typed].map((character) => keystroke(tree, label, character));
}

function clear(tree: ReactTestRenderer, label: string) {
  const input = field(tree, label);
  act(() => input.props.onChangeText(''));
}

async function openWithALine(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
  });
  await press(tree, 'Add');
  return tree;
}

beforeEach(() => receiveStock.mockClear());

describe('StockRestockModal typed input', () => {
  it('holds every keystroke of a grouped cost exactly as typed', async () => {
    const tree = await openWithALine();
    // The regression that shipped: a comma consumed as it was typed turned the
    // way to $1,500.00 into $1.50.
    expect(typeInto(tree, COST, '1,500')).toEqual(['1', '1,', '1,5', '1,50', '1,500']);
    expect(screenText(tree)).toContain(`Delivery value ${formatCents(150000)}`);
  });

  it('holds a doubly-grouped cost, which used to read as fifteen million', async () => {
    const tree = await openWithALine();
    // "1,500,00" from a shop that groups out of habit. The reading is the
    // subject of the classifier's own test; what is asserted here is that the
    // eight characters in the box are the eight that were typed.
    expect(typeInto(tree, COST, '1,500,00')).toEqual([
      '1',
      '1,',
      '1,5',
      '1,50',
      '1,500',
      '1,500,',
      '1,500,0',
      '1,500,00',
    ]);
    expect(screenText(tree)).toContain(`Delivery value ${formatCents(150000)}`);
  });

  it('holds a dot-grouped cost as typed, and reads it as the dot rule says', async () => {
    const tree = await openWithALine();
    expect(typeInto(tree, COST, '1.234.567,89')).toEqual([
      '1',
      '1.',
      '1.2',
      '1.23',
      '1.234',
      '1.234.',
      '1.234.5',
      '1.234.56',
      '1.234.567',
      '1.234.567,',
      '1.234.567,8',
      '1.234.567,89',
    ]);
    expect(screenText(tree)).toContain(`Delivery value ${formatCents(123456789)}`);
  });

  it('records the cost that was typed, not a rewrite of it', async () => {
    const tree = await openWithALine();
    typeInto(tree, COST, '1,500,00');
    clear(tree, QUANTITY);
    typeInto(tree, QUANTITY, '24');
    await press(tree, 'Receive 24 units');
    expect(receiveStock).toHaveBeenCalledTimes(1);
    expect(receiveStock.mock.calls[0][2]).toEqual([{ productId: 'p-1', quantity: 24, unitCostCents: 150000 }]);
  });

  it('says which way a cost is unusable, and holds the commit either way', async () => {
    const tree = await openWithALine();
    typeInto(tree, COST, '12.3.4.5');
    expect(screenText(tree)).toContain('One unit cost is not an amount of money');
    clear(tree, COST);
    typeInto(tree, COST, '-4.50');
    expect(field(tree, COST).props.value).toBe('-4.50');
    expect(screenText(tree)).toContain('One unit cost is not an amount of money');
    clear(tree, COST);
    typeInto(tree, COST, '999999999999,99');
    expect(screenText(tree)).toContain('One unit cost is larger than a cost can be');
    await press(tree, 'Receive');
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it('keeps the row and its typed cost when the quantity is emptied', async () => {
    const tree = await openWithALine();
    typeInto(tree, COST, '2,50');
    clear(tree, QUANTITY);
    expect(field(tree, QUANTITY).props.value).toBe('');
    expect(field(tree, COST).props.value).toBe('2,50');
    expect(screenText(tree)).toContain('QA widget');
    expect(screenText(tree)).toContain('Type how many arrived on every line');
    expect(typeInto(tree, QUANTITY, '24')).toEqual(['2', '24']);
    expect(screenText(tree)).toContain(`Delivery value ${formatCents(6000)}`);
  });

  it('does not advertise a quantity the sheet would refuse', async () => {
    const tree = await openWithALine();
    // A greyed "0" in the empty box would be the field suggesting the one
    // value that keeps the button down.
    clear(tree, QUANTITY);
    expect(field(tree, QUANTITY).props.placeholder).not.toBe('0');
  });
});

// The sheet tab's footer promises "nothing has changed yet" -- the whole
// design of this screen is that nothing writes before the commit button. That
// promise has to hold, and stop holding honestly, across the one commit that
// changes it partway: commitPlan sends one receive_stock call per store, and
// a store that fails does not undo the stores that already succeeded.
describe('StockRestockModal sheet-tab footer', () => {
  it('reads "nothing has changed yet" before any commit, and stops claiming that once a partial commit already changed something', async () => {
    pickCsvFile.mockResolvedValueOnce({
      status: 'ok',
      fileName: 'restock.csv',
      parsed: {
        headers: ['Product', 'SKU', 'Barcode', 'Store', 'Quantity now', 'Quantity received', 'Unit cost', 'Note'],
        rows: [
          { Product: 'QA widget', SKU: 'QA-1', Barcode: '', Store: 'Main', 'Quantity now': '10', 'Quantity received': '3', 'Unit cost': '', Note: '' },
          { Product: 'QA widget', SKU: 'QA-1', Barcode: '', Store: 'Second', 'Quantity now': '10', 'Quantity received': '5', 'Unit cost': '', Note: '' },
        ],
      },
    });
    // Main goes through; Second fails. plan.receipts is keyed by insertion
    // order, which is row order, so this is the Main call then the Second
    // call -- matching the two mockImplementationOnce calls below in order.
    receiveStock.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockRestockModal visible shopId="shop-1" onClose={jest.fn()} onDone={jest.fn(async () => {})} />);
    });

    await press(tree, 'By sheet');
    await press(tree, 'Upload a filled sheet');

    // Before any commit: the preview is a reading of the file, honestly
    // labelled -- nothing has been written yet.
    expect(screenText(tree)).toContain('8 units in');
    expect(screenText(tree)).toContain('across 2 stores · nothing has changed yet');

    await press(tree, 'Receive 8 units');

    // After the partial failure: Main's 3 units are already in the database
    // (receiveStock's first call resolved), Second's are not (its call
    // threw). The footer must say so instead of repeating a line that is now
    // false directly beneath the error naming the store that failed.
    expect(screenText(tree)).toContain('Second: boom');
    expect(screenText(tree)).not.toContain('nothing has changed yet');
    expect(screenText(tree)).toContain('3 units already in');
    expect(screenText(tree)).toContain('to 1 store before the failure above');
  });
});
