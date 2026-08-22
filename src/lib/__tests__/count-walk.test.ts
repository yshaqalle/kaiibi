import {
  COUNT_PAGE_SIZE,
  filterProducts,
  pageSlice,
  plannedLines,
  typedRows,
  walkRow,
  walkRows,
  type CountEntries,
} from '@/lib/count-walk';
import type { Product } from '@/types/models';

const product = (over: Partial<Product> & { id: string }): Product =>
  ({
    shopId: 'shop-1',
    name: 'QA widget',
    description: null,
    sku: null,
    barcode: null,
    brand: null,
    category: null,
    tags: [],
    supplierName: null,
    costCents: 461,
    priceCents: 500,
    stock: 11,
    reorderLevel: null,
    shelfNumber: null,
    expiryDate: null,
    batchNumber: null,
    imageUrl: null,
    isListedOnline: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as Product;

describe('what a field means', () => {
  // MUTATION: make an absent entry produce `{ state: 'counted', counted: 0 }`.
  // Blank and zero are different claims -- "I did not count this" against "the
  // shelf was bare" -- and only one of them may overwrite a shelf.
  it('reads a product with no entry as blank, never as zero', () => {
    const row = walkRow(product({ id: 'p-1' }), {});
    expect(row.state).toBe('blank');
    expect(row.counted).toBeNull();
    expect(row.variance).toBeNull();
    expect(row.typed).toBe('');
  });

  // MUTATION: drop the `.trim()` from the blank test, so a field holding a
  // single space classifies as 'unreadable' and blocks a Save nobody can fix.
  it('reads an entry holding only whitespace as blank', () => {
    const entries: CountEntries = { 'p-1': { counted: '  ', reason: null } };
    expect(walkRow(product({ id: 'p-1' }), entries).state).toBe('blank');
  });

  // MUTATION: classify zero as blank. The Count door would then be able to
  // record every loss except a total one.
  it('reads a typed zero as counted, with the whole shelf as the variance', () => {
    const entries: CountEntries = { 'p-1': { counted: '0', reason: null } };
    const row = walkRow(product({ id: 'p-1', stock: 11 }), entries);
    expect(row.state).toBe('counted');
    expect(row.counted).toBe(0);
    expect(row.variance).toBe(-11);
  });

  // MUTATION: classify an unreadable entry as blank. `abc` would then be
  // silently skipped instead of blocking the commit.
  it('reads a non-number as unreadable, not as blank', () => {
    const entries: CountEntries = { 'p-1': { counted: 'abc', reason: null } };
    const row = walkRow(product({ id: 'p-1' }), entries);
    expect(row.state).toBe('unreadable');
    expect(row.counted).toBeNull();
    expect(row.typed).toBe('abc');
  });

  // MUTATION: compute variance as `product.stock - counted`. Every sign on the
  // screen inverts, and a shortfall reads as a surplus.
  it('signs the variance as counted minus what the app believes', () => {
    const entries: CountEntries = { 'p-1': { counted: '14', reason: null } };
    expect(walkRow(product({ id: 'p-1', stock: 11 }), entries).variance).toBe(3);
  });

  // MUTATION: have walkRows iterate `Object.keys(entries)` instead of the
  // catalogue. HAZARD 1's opposite failure -- an entry left behind for a
  // product this store no longer carries would reach the RPC.
  it('walks the catalogue, so an entry for a product the store does not carry is dropped', () => {
    const rows = walkRows([product({ id: 'p-1' })], {
      'p-1': { counted: '8', reason: null },
      'p-gone': { counted: '99', reason: null },
    });
    expect(rows.map((row) => row.product.id)).toEqual(['p-1']);
  });
});

describe('what gets sent', () => {
  // MUTATION: drop the `state === 'counted'` filter so blank rows are planned
  // too. A 240-product catalogue with two counts would zero 238 shelves.
  it('plans only the rows that were counted', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, { 'p-2': { counted: '8', reason: 'damaged' } });
    expect(plannedLines(rows).map((line) => line.productId)).toEqual(['p-2']);
  });

  // MUTATION: send `variance` as `countedQuantity`. This is the ADD-instead-of-
  // SET bug the whole Count door exists to prevent.
  it('plans the counted TOTAL, never the change', () => {
    const rows = walkRows([product({ id: 'p-1', stock: 11, name: 'QA widget' })], {
      'p-1': { counted: '8', reason: 'damaged' },
    });
    expect(plannedLines(rows)).toEqual([
      {
        productId: 'p-1',
        productName: 'QA widget',
        previousQuantity: 11,
        countedQuantity: 8,
        variance: -3,
        reason: 'damaged',
        unitCostCents: 461,
      },
    ]);
  });

  // MUTATION: delete the `some(state === 'unreadable')` guard. The footer would
  // then show a total computed over half a walk, presented as the whole thing,
  // and Save would go live on it.
  it('plans nothing at all while any row is unreadable', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, {
      'p-1': { counted: '8', reason: null },
      'p-2': { counted: '9', reason: null },
      'p-3': { counted: 'abc', reason: null },
    });
    expect(plannedLines(rows)).toEqual([]);
  });

  // MUTATION: report `unitCostCents: product.costCents` without the isUncosted
  // check, so an uncosted product contributes 0 and the shortfall figure
  // understates the loss instead of withholding it.
  it('withholds a unit cost rather than quoting zero for an uncosted product', () => {
    const rows = walkRows([product({ id: 'p-1', costCents: null })], {
      'p-1': { counted: '8', reason: null },
    });
    expect(plannedLines(rows)[0].unitCostCents).toBeNull();
  });

  // MUTATION: have typedRows return every row. The pager's "N counted so far"
  // would read as the whole catalogue.
  it('counts a row as typed when it is counted or unreadable, never when blank', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, {
      'p-1': { counted: '8', reason: null },
      'p-3': { counted: 'abc', reason: null },
    });
    expect(typedRows(rows).map((row) => row.product.id)).toEqual(['p-1', 'p-3']);
  });
});

describe('narrowing the list', () => {
  const catalogue = [
    product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', category: 'Skincare' }),
    product({ id: 'p-2', name: 'clay mask sachet', sku: 'SK-2', barcode: '5012345', category: 'Skincare' }),
    product({ id: 'p-3', name: 'dish soap', sku: 'HH-1', category: 'Household' }),
  ];

  // MUTATION: drop the category clause. The chips would render and do nothing.
  it('narrows by category', () => {
    expect(filterProducts(catalogue, '', 'Household').map((p) => p.id)).toEqual(['p-3']);
  });

  // MUTATION: match on name only. A shop that searches by SKU or scans a
  // barcode into the box would be told it sells nothing.
  it('matches name, SKU and barcode, case-insensitively', () => {
    expect(filterProducts(catalogue, 'ALTHEA', null).map((p) => p.id)).toEqual(['p-1']);
    expect(filterProducts(catalogue, 'hh-1', null).map((p) => p.id)).toEqual(['p-3']);
    expect(filterProducts(catalogue, '5012345', null).map((p) => p.id)).toEqual(['p-2']);
  });

  // MUTATION: reinstate the old `.slice(0, 12)` the two-step picker carried.
  // With every product a row, a cap is a silent refusal to show the shelf.
  it('caps nothing', () => {
    const many = Array.from({ length: 40 }, (_, i) => product({ id: `p-${i}`, name: `QA ${i}` }));
    expect(filterProducts(many, '', null)).toHaveLength(40);
  });

  // MUTATION: return `[]` for an empty query instead of everything. An
  // untouched search box is the ordinary state of this screen.
  it('returns the whole catalogue for an empty query', () => {
    expect(filterProducts(catalogue, '   ', null)).toHaveLength(3);
  });
});

describe('paging', () => {
  const items = Array.from({ length: 240 }, (_, i) => i);

  // MUTATION: change COUNT_PAGE_SIZE to 12. The threshold below which the
  // pager is absent moves with it, and most shops on the platform grow a
  // control the design says they should never see.
  it('pages a hundred at a time', () => {
    expect(COUNT_PAGE_SIZE).toBe(100);
  });

  // MUTATION: off-by-one either `from` or `to`. "Showing 1-100 of 240" is the
  // only thing on screen that says how much of the shop is not visible.
  it('reports the window it is showing, one-based and inclusive', () => {
    expect(pageSlice(items, 1, 100)).toMatchObject({ page: 1, pageCount: 3, from: 1, to: 100 });
    expect(pageSlice(items, 2, 100)).toMatchObject({ page: 2, pageCount: 3, from: 101, to: 200 });
    expect(pageSlice(items, 3, 100)).toMatchObject({ page: 3, pageCount: 3, from: 201, to: 240 });
    expect(pageSlice(items, 3, 100).items).toEqual(items.slice(200));
  });

  // MUTATION: delete the clamp. A catalogue that shrinks under a filter while
  // the page number stays put renders an empty list with no explanation.
  it('clamps a page past the end onto the last page rather than showing nothing', () => {
    expect(pageSlice(items, 9, 100)).toMatchObject({ page: 3, from: 201, to: 240 });
    expect(pageSlice(items, 0, 100)).toMatchObject({ page: 1, from: 1, to: 100 });
  });

  // MUTATION: drop the `Math.max(1, ...)` from pageCount, so an empty list
  // reports 0 pages and `Next` goes live over nothing.
  it('reports one page for an empty list, showing nothing', () => {
    expect(pageSlice([], 1, 100)).toEqual({ page: 1, pageCount: 1, items: [], from: 0, to: 0 });
  });
});
