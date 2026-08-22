import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { StockCountModal } from '@/components/stock-count-modal';

// The half of the count screen that a pure test cannot reach.
//
// count-import.test.ts tests planCount and summariseCount against finished
// values. Every input bug that shipped from the RESTOCK screen was
// finished-string-correct and lived here instead, in the component's own
// setter, where a normalising .replace() rewrote a controlled field between
// keystrokes so the next character landed on text the person never typed. A
// test that feeds whole strings to the classifier stays green through all of
// them.
//
// So every case below is driven the way a controlled TextInput actually drives
// it: read the field's current value, append or remove ONE character, hand that
// back to the component's own onChangeText, then read the field again. A helper
// that did `state + character` would never touch the component and could not
// catch the class it was written for.

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [{ id: 'loc-1', name: 'Main', active: true }],
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
  costCents: 461,
  priceCents: 500,
  stock: 11,
  reorderLevel: null,
  shelfNumber: 'A3',
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
  saveStockCount: jest.fn(async () => 'count-1'),
}));
const { listProducts, saveStockCount } = jest.requireMock('@/lib/products') as {
  listProducts: jest.Mock;
  saveStockCount: jest.Mock;
};

jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
jest.mock('@/lib/expenses', () => ({ createExpense: jest.fn(async () => ({})) }));

const COUNTED = 'Counted units of QA widget';

// Reassembles an interpolated <Text>, whose children React splits into several
// nodes ("Save ", 3, " counts").
function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : '')).join('');
}

function fieldNamed(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props['aria-label'] === label)[0];
}

function pressableLabelled(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label)[0];
}

// `node.children` is the TEST-INSTANCE tree, not the `children` prop: React
// Native's `Text` wraps its content in a host-level `Text` primitive, so a
// found node's immediate `.children` is that ONE nested instance, never the
// raw string, even for the plainest `<Text>{name}</Text>`. Recursing until a
// string turns up is what actually reaches it, one level deeper than a literal
// reading of "map children, keep the strings" would stop at.
function textFrom(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map((child) => textFrom(child)).join('');
}

function allText(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map((node) => textFrom(node))
    .join(' | ');
}

// One character at a time, through the component's own handler.
async function type(tree: ReactTestRenderer, label: string, characters: string) {
  for (const character of characters) {
    const field = fieldNamed(tree, label);
    const next = String(field.props.value ?? '') + character;
    await act(async () => field.props.onChangeText(next));
  }
}

async function backspace(tree: ReactTestRenderer, label: string, times = 1) {
  for (let i = 0; i < times; i += 1) {
    const field = fieldNamed(tree, label);
    const current = String(field.props.value ?? '');
    await act(async () => field.props.onChangeText(current.slice(0, -1)));
  }
}

async function open(products = [product({})]): Promise<ReactTestRenderer> {
  listProducts.mockResolvedValue(products);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />
    );
  });
  // The results list renders the whole (short) catalogue with no search term.
  await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
  return tree;
}

beforeEach(() => {
  saveStockCount.mockClear();
  saveStockCount.mockResolvedValue('count-1');
});

describe('a line added to a count', () => {
  // Difference 1 from Restock, and the reason the footer can say "3 counted"
  // while only 2 change anything: a stock-take mostly CONFIRMS, so the field
  // starts at the current figure and a row left untouched means "I looked, it
  // matched" -- which is real information.
  it('starts at what the app believes, not at zero or empty', async () => {
    const tree = await open();
    expect(fieldNamed(tree, COUNTED).props.value).toBe('11');
    expect(allText(tree)).toContain('App says 11');
  });

  it('counts an untouched row and reports that it changes nothing', async () => {
    const tree = await open();
    expect(allText(tree)).toContain('Save 1 count');
    expect(allText(tree)).toContain('0 will change a number');
  });

  // The regression class three separate 100x cost bugs came from on the restock
  // branch. If anything rewrites the text on its way into state, the recorded
  // value after some keystroke stops equalling what was typed.
  it('never rewrites the text between keystrokes', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    await type(tree, COUNTED, '108');
    expect(fieldNamed(tree, COUNTED).props.value).toBe('108');
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('10');
  });

  // An empty field is just an empty field. Dropping the row at 0 -- the restock
  // screen's first attempt -- unmounted the focused input on the first
  // backspace, closed the keyboard, and took the reason chosen beside it.
  it('keeps the row and its reason when the field is emptied', async () => {
    const tree = await open();
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Damaged');
    expect(allText(tree)).toContain('Type what you found on every line');
  });

  // Zero is a finding, not a blank. Refusing it would leave the door able to
  // record every loss except a total one.
  it('accepts a counted zero and reads it as an empty shelf', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '0');
    expect(allText(tree)).toContain('−11');
    expect(allText(tree)).toContain('1 will change a number');
  });

  // The variance is the column, not a footnote: the person doing the
  // stock-take already knows the 8 -- what they will be asked about is how far
  // off the app was.
  it('shows the variance live and signed', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('−3');
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14');
    expect(allText(tree)).toContain('+3');
  });
});

describe('saving a count', () => {
  // THE distinction from Restock, at the only layer a component test can see
  // it: the RPC is handed the TOTAL that was found, never the difference.
  it('sends the counted total, not the change', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 8, reason: 'damaged' }],
      { note: null }
    );
  });

  it('sends a null reason rather than defaulting one', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 8, reason: null },
    ]);
  });

  // The CRITICAL from the restock branch, pinned here so it cannot be
  // reintroduced: `await onDone()` inside the try that had already committed
  // meant a reload failing on a network blip landed in the catch, showed an
  // error, cleared busy and LEFT THE BASKET FULL -- and pressing Save again
  // wrote the same count a second time.
  it('does not leave a live basket behind a failed reload', async () => {
    listProducts.mockResolvedValue([product({})]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <StockCountModal
          visible
          shopId="shop-1"
          onClose={() => {}}
          onDone={async () => {
            throw new Error('network');
          }}
        />
      );
    });
    await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });

  // A failure that wrote NOTHING is the opposite case, and the basket must
  // survive it -- this is the one failure a shop fixes by pressing again.
  it('keeps the basket when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });
});
