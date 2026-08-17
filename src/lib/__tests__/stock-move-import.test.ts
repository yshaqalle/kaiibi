// The move sheet's rules, at the boundary a person actually meets them: a CSV
// generated the way the download button generates it, read back the way the
// picker reads it. Nothing here touches Supabase -- planStockMoves is pure, and
// that is what makes every rule below cheap enough to state as its own case.

import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import { missingRequiredColumns } from '@/lib/import-shared';
import {
  planStockMoves,
  plannedUnits,
  STOCK_MOVE_SHEET_COLUMNS,
  STOCK_MOVE_TEMPLATE_COLUMNS,
  stockMoveSheetRows,
} from '@/lib/stock-move-import';
import type { Product, ShopLocation } from '@/types/models';

const MAIN = { id: 'loc-main', name: 'Jaalala Skincare', code: 'JL1', active: true } as ShopLocation;
const SECOND = { id: 'loc-2', name: 'Jaalala 2', code: 'JL2', active: true } as ShopLocation;
const CLOSED = { id: 'loc-closed', name: 'Jaalala Kiosk', code: 'JLK', active: false } as ShopLocation;
const LOCATIONS = [MAIN, SECOND, CLOSED];

const serum = { id: 'p-serum', name: 'Torriden Balanceful Serum', sku: 'TOR-BAL-50', barcode: '8809611860018' } as Product;
const centella = { id: 'p-centella', name: 'SKIN1004 Madagascar Centella', sku: 'SK1-MAD-100', barcode: null } as Product;
const PRODUCTS = [serum, centella];

// What each store holds, for the cases that don't care to be specific.
const STOCK: Record<string, number> = {
  'p-serum|loc-main': 8,
  'p-centella|loc-main': 24,
  'p-serum|loc-2': 1,
};
const stockAt = (productId: string, locationId: string) => STOCK[`${productId}|${locationId}`] ?? 0;

const CONTEXT = { products: PRODUCTS, locations: LOCATIONS, stockAt };

// A filled-in sheet, written and read back through the same csv helpers the
// download and the picker use -- so a quoting bug in either shows up here
// rather than on someone's laptop.
function sheet(rows: Partial<Record<string, string>>[]): ParsedCsv {
  const full = rows.map((row) => ({
    Product: '',
    SKU: '',
    Barcode: '',
    'From store': 'Jaalala Skincare',
    'Quantity now': '',
    'To store': '',
    'Quantity to move': '',
    Note: '',
    ...row,
  }));
  return parseCsvText(
    rowsToCsv(
      full,
      STOCK_MOVE_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
    )
  );
}

describe('the sheet the shop downloads', () => {
  it('clears the picker its own template has to pass', () => {
    const csv = parseCsvText(rowsToCsv([], STOCK_MOVE_SHEET_COLUMNS));
    expect(missingRequiredColumns(STOCK_MOVE_TEMPLATE_COLUMNS, csv.headers)).toEqual([]);
  });

  it('gives a product held at two stores one row per store, with each count', () => {
    const rows = stockMoveSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.map((r) => [r.product.name, r.location.name, r.stock])).toEqual([
      ['Torriden Balanceful Serum', 'Jaalala Skincare', 8],
      ['Torriden Balanceful Serum', 'Jaalala 2', 1],
      ['SKIN1004 Madagascar Centella', 'Jaalala Skincare', 24],
    ]);
  });

  it('leaves out what a store does not hold, and stores that are closed', () => {
    const rows = stockMoveSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.some((r) => r.product.id === 'p-centella' && r.location.id === 'loc-2')).toBe(false);
    expect(rows.some((r) => r.location.id === CLOSED.id)).toBe(false);
  });

  it('leaves the cells the shop fills in empty, and identifies the store by code', () => {
    const csv = parseCsvText(rowsToCsv(stockMoveSheetRows(PRODUCTS, LOCATIONS, stockAt), STOCK_MOVE_SHEET_COLUMNS));
    expect(csv.rows[0]).toMatchObject({
      Product: 'Torriden Balanceful Serum',
      SKU: 'TOR-BAL-50',
      'From store': 'JL1',
      'Quantity now': '8',
      'To store': '',
      'Quantity to move': '',
    });
  });

  // The round trip that matters: download it, fill two cells, upload it.
  it('is a file its own planner accepts once the two cells are filled', () => {
    const downloaded = stockMoveSheetRows(PRODUCTS, LOCATIONS, stockAt);
    const csv = parseCsvText(rowsToCsv(downloaded, STOCK_MOVE_SHEET_COLUMNS));
    csv.rows[0]['To store'] = 'JL2';
    csv.rows[0]['Quantity to move'] = '5';

    const plan = planStockMoves(csv, CONTEXT);
    expect(plan.rejected).toEqual([]);
    expect(plan.skipped).toBe(2);
    expect(plan.pairs).toHaveLength(1);
    expect(plan.pairs[0]).toMatchObject({ fromLocationId: MAIN.id, toLocationId: SECOND.id });
    expect(plan.pairs[0].items).toEqual([{ productId: serum.id, productName: serum.name, quantity: 5 }]);
  });
});

describe('planning a move', () => {
  it('groups rows into one transfer per store pair, keeping each direction its own', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '5' },
        { Product: 'SKIN1004 Madagascar Centella', 'To store': 'Jaalala 2', 'Quantity to move': '10' },
        { Product: 'Torriden Balanceful Serum', 'From store': 'Jaalala 2', 'To store': 'Jaalala Skincare', 'Quantity to move': '1' },
      ]),
      CONTEXT
    );

    expect(plan.rejected).toEqual([]);
    expect(plan.pairs).toHaveLength(2);
    expect(plan.pairs.map((p) => [p.fromName, p.toName, p.items.length, plannedUnits(p)])).toEqual([
      ['Jaalala Skincare', 'Jaalala 2', 2, 15],
      ['Jaalala 2', 'Jaalala Skincare', 1, 1],
    ]);
  });

  it('skips the untouched rows silently rather than rejecting them', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum' },
        { Product: 'SKIN1004 Madagascar Centella' },
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '2' },
      ]),
      CONTEXT
    );

    expect(plan.skipped).toBe(2);
    expect(plan.rejected).toEqual([]);
    expect(plan.pairs).toHaveLength(1);
  });

  it('matches on SKU ahead of the name, so a tidied-up name still finds its product', () => {
    const plan = planStockMoves(
      sheet([{ Product: 'Torriden Balanceful Serum 50ml (new box)', SKU: 'TOR-BAL-50', 'To store': 'Jaalala 2', 'Quantity to move': '3' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.pairs[0].items[0].productId).toBe(serum.id);
  });

  it('matches a store by code or by name, ignoring case and padding', () => {
    const plan = planStockMoves(
      sheet([{ Product: 'Torriden Balanceful Serum', 'From store': ' jl1 ', 'To store': '  JAALALA 2 ', 'Quantity to move': '2' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.pairs[0]).toMatchObject({ fromLocationId: MAIN.id, toLocationId: SECOND.id });
  });

  it('takes the first note it is given as the note for that pair', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '2', Note: 'restock' },
        { Product: 'SKIN1004 Madagascar Centella', 'To store': 'Jaalala 2', 'Quantity to move': '2', Note: 'also restock' },
      ]),
      CONTEXT
    );
    expect(plan.pairs[0].note).toBe('restock');
  });

  it('reports the row number as the line of the file, counting the header', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '2' },
        { Product: 'Nothing At All', 'To store': 'Jaalala 2', 'Quantity to move': '2' },
      ]),
      CONTEXT
    );
    expect(plan.rejected[0].row).toBe(3);
  });
});

describe('rows the planner refuses', () => {
  const rejectionFor = (row: Partial<Record<string, string>>): string => {
    const plan = planStockMoves(sheet([row]), CONTEXT);
    expect(plan.pairs).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    return plan.rejected[0].reason;
  };

  it('refuses a product it cannot find, and says to use the SKU', () => {
    expect(rejectionFor({ Product: 'Torriden Blanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '2' })).toBe(
      'No product matches "Torriden Blanceful Serum" — check the spelling, or fill in the SKU column.'
    );
  });

  it('refuses a name two products share rather than guessing between them', () => {
    const twins = [
      { id: 'a', name: 'Serum', sku: 'A', barcode: null },
      { id: 'b', name: 'serum', sku: 'B', barcode: null },
    ] as Product[];
    const plan = planStockMoves(sheet([{ Product: 'Serum', 'To store': 'Jaalala 2', 'Quantity to move': '1' }]), {
      ...CONTEXT,
      products: twins,
    });
    expect(plan.rejected[0].reason).toBe('More than one product matches "Serum" — fill in the SKU column to say which.');
  });

  it('refuses a store it does not have, and lists the ones it does', () => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 3', 'Quantity to move': '2' })).toBe(
      'No active store called "Jaalala 3". Your stores are Jaalala Skincare, Jaalala 2.'
    );
  });

  // A closed store is not offered anywhere else in the app, so it must not
  // become reachable through a file.
  it('refuses a store that is closed, the same as one that does not exist', () => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala Kiosk', 'Quantity to move': '2' })).toMatch(
      /No active store called "Jaalala Kiosk"/
    );
  });

  it('refuses a move to the store it is already in', () => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala Skincare', 'Quantity to move': '2' })).toBe(
      'From and To are both Jaalala Skincare — nothing would move.'
    );
  });

  it.each([
    ['two and a half', '2.5'],
    ['not a number', 'five'],
    ['zero', '0'],
    ['negative', '-3'],
  ])('refuses a quantity that is %s', (_label, quantity) => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': quantity })).toBe(
      'Quantity to move must be a whole number above zero.'
    );
  });

  // The answer settled in the design: stock cannot go negative -- the column is
  // `check (stock >= 0)` -- so the row says the count is the thing to fix.
  it('refuses more than the store holds, and points at the count', () => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '9' })).toBe(
      'Only 8 at Jaalala Skincare — the sheet asks for 9. If you really have 9, correct the count first.'
    );
  });

  it('says plainly when the source holds none of it at all', () => {
    expect(
      rejectionFor({ Product: 'SKIN1004 Madagascar Centella', 'From store': 'Jaalala 2', 'To store': 'Jaalala Skincare', 'Quantity to move': '1' })
    ).toBe('SKIN1004 Madagascar Centella has none left at Jaalala 2 to move.');
  });

  it('refuses a half-filled row rather than skipping it', () => {
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'Quantity to move': '2' })).toMatch(/To store is empty/);
    expect(rejectionFor({ Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2' })).toMatch(/Quantity to move is empty/);
  });

  it('refuses a second row for the same product and route, naming the first', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '2' },
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '3' },
      ]),
      CONTEXT
    );
    expect(plan.pairs[0].items).toHaveLength(1);
    expect(plan.rejected[0].reason).toBe(
      'Row 2 already moves Torriden Balanceful Serum from Jaalala Skincare to Jaalala 2 — combine them into one row.'
    );
  });

  // Two routes out of one store are both legitimate, so neither row is a
  // duplicate -- but together they can still overdraw it, and the second one
  // has to be measured against what the first one leaves behind.
  it('counts what earlier rows already took out of the same store', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'SKIN1004 Madagascar Centella', 'To store': 'Jaalala 2', 'Quantity to move': '20' },
        { Product: 'SKIN1004 Madagascar Centella', 'To store': 'Jaalala Kiosk', 'Quantity to move': '10' },
      ]),
      { ...CONTEXT, locations: [MAIN, SECOND, { ...CLOSED, active: true }] }
    );
    expect(plan.pairs).toHaveLength(1);
    expect(plan.rejected[0].reason).toBe(
      'Only 4 at Jaalala Skincare — the sheet asks for 10. If you really have 10, correct the count first.'
    );
  });

  it('keeps the good rows when others are refused', () => {
    const plan = planStockMoves(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'To store': 'Jaalala 2', 'Quantity to move': '5' },
        { Product: 'Nothing At All', 'To store': 'Jaalala 2', 'Quantity to move': '2' },
        { Product: 'SKIN1004 Madagascar Centella', 'To store': 'Jaalala 2', 'Quantity to move': '10' },
      ]),
      CONTEXT
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.pairs).toHaveLength(1);
    expect(plannedUnits(plan.pairs[0])).toBe(15);
  });
});
