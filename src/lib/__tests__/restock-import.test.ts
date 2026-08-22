// The restock sheet's rules, at the boundary a person actually meets them: a
// CSV generated the way the download button generates it, read back the way the
// picker reads it. Nothing here touches Supabase -- planRestock is pure, which
// is what makes every rule below cheap enough to state as its own case.

import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import { missingRequiredColumns } from '@/lib/import-shared';
import {
  costUpdates,
  planRestock,
  receivedUnits,
  RESTOCK_SHEET_COLUMNS,
  RESTOCK_TEMPLATE_COLUMNS,
  restockSheetRows,
} from '@/lib/restock-import';
import type { Product, ShopLocation } from '@/types/models';

const MAIN = { id: 'loc-main', name: 'Jaalala Skincare', code: 'JL1', active: true } as ShopLocation;
const SECOND = { id: 'loc-2', name: 'Jaalala 2', code: 'JL2', active: true } as ShopLocation;
const CLOSED = { id: 'loc-closed', name: 'Jaalala Kiosk', code: 'JLK', active: false } as ShopLocation;
const LOCATIONS = [MAIN, SECOND, CLOSED];

const serum = {
  id: 'p-serum', name: 'Torriden Balanceful Serum', sku: 'TOR-BAL-50',
  barcode: '8809611860018', costCents: 450,
} as Product;
const centella = {
  id: 'p-centella', name: 'SKIN1004 Madagascar Centella', sku: 'SK1-MAD-100',
  barcode: null, costCents: null,
} as Product;
const PRODUCTS = [serum, centella];

const STOCK: Record<string, number> = {
  'p-serum|loc-main': 8,
  'p-centella|loc-main': 24,
  'p-serum|loc-2': 1,
};
const stockAt = (productId: string, locationId: string) => STOCK[`${productId}|${locationId}`] ?? 0;

const CONTEXT = { products: PRODUCTS, locations: LOCATIONS, stockAt };

function sheet(rows: Partial<Record<string, string>>[]): ParsedCsv {
  const full = rows.map((row) => ({
    Product: '',
    SKU: '',
    Barcode: '',
    Store: 'Jaalala Skincare',
    'Quantity now': '',
    'Quantity received': '',
    'Unit cost': '',
    Note: '',
    ...row,
  }));
  return parseCsvText(
    rowsToCsv(
      full,
      RESTOCK_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
    )
  );
}

describe('the sheet the shop downloads', () => {
  it('clears the picker its own template has to pass', () => {
    const csv = parseCsvText(rowsToCsv([], RESTOCK_SHEET_COLUMNS));
    expect(missingRequiredColumns(RESTOCK_TEMPLATE_COLUMNS, csv.headers)).toEqual([]);
  });

  // The inverse of the move sheet, and deliberately so: you cannot move what
  // isn't there, but a product at zero is the MOST likely thing in the van.
  it('includes rows a store holds none of', () => {
    const rows = restockSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.map((r) => [r.product.name, r.location.name, r.stock])).toEqual([
      ['Torriden Balanceful Serum', 'Jaalala Skincare', 8],
      ['Torriden Balanceful Serum', 'Jaalala 2', 1],
      ['SKIN1004 Madagascar Centella', 'Jaalala Skincare', 24],
      ['SKIN1004 Madagascar Centella', 'Jaalala 2', 0],
    ]);
  });

  it('leaves out closed stores', () => {
    const rows = restockSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.some((r) => r.location.id === CLOSED.id)).toBe(false);
  });

  it('leaves the cells the shop fills in empty, and identifies the store by code', () => {
    const rows = restockSheetRows([serum], [MAIN], stockAt);
    const parsed = parseCsvText(rowsToCsv(rows, RESTOCK_SHEET_COLUMNS));
    expect(parsed.rows[0]).toMatchObject({
      Product: 'Torriden Balanceful Serum',
      Store: 'JL1',
      'Quantity now': '8',
      'Quantity received': '',
      'Unit cost': '',
    });
  });
});

describe('planning what arrived', () => {
  it('adds to what the store already holds, and groups by store', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6' },
        { Product: 'SKIN1004 Madagascar Centella', 'Quantity received': '24' },
        { Product: 'Torriden Balanceful Serum', Store: 'JL2', 'Quantity received': '4' },
      ]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.receipts).toHaveLength(2);
    expect(receivedUnits(plan.receipts[0])).toBe(30);
    expect(plan.receipts[0].locationName).toBe('Jaalala Skincare');
    expect(receivedUnits(plan.receipts[1])).toBe(4);
  });

  it('counts untouched rows as skipped rather than rejected', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6' }, {}, {}, {}]),
      CONTEXT
    );
    expect(plan.skipped).toBe(3);
    expect(plan.rejected).toEqual([]);
  });

  // A cost with no quantity is a half-finished row, not an untouched one.
  it('rejects a unit cost with nothing received', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Unit cost': '4.80' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toMatch(/Unit cost is filled in but Quantity received is empty/);
  });

  it('names Import products when the row is a product the shop does not carry', () => {
    const plan = planRestock(sheet([{ Product: 'Anua Heartleaf Toner', 'Quantity received': '6' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Import products');
    expect(plan.rejected[0].row).toBe(2);
  });

  it('names Count when the sheet asks to take stock away', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '-3' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Count');
  });

  it('rejects zero, which changes nothing and is always a mistake', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '0' }]), CONTEXT);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.skipped).toBe(0);
  });

  it('matches by SKU before name, so a tidied name still finds its product', () => {
    const plan = planRestock(
      sheet([{ Product: 'torriden balanceful serum (50ml)', SKU: 'TOR-BAL-50', 'Quantity received': '6' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.receipts[0].items[0].productId).toBe('p-serum');
  });

  it('rejects two rows receiving the same product into the same store rather than summing them', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6' },
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '4' },
      ]),
      CONTEXT
    );
    expect(plan.receipts[0].items).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/Row 2 already receives/);
  });

  it('refuses a store it does not recognise, and names the ones it has', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', Store: 'Hargeisa', 'Quantity received': '6' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toContain('Jaalala Skincare, Jaalala 2');
  });
});

describe('cost', () => {
  it('reads dollars and reports only the products whose cost actually changes', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': '4.80' },
        { Product: 'SKIN1004 Madagascar Centella', 'Quantity received': '2', 'Unit cost': '3.00' },
      ]),
      CONTEXT
    );
    expect(plan.receipts[0].items[0].unitCostCents).toBe(480);
    expect(plan.receipts[0].items[0].previousCostCents).toBe(450);
    expect(costUpdates(plan).map((i) => i.productName)).toEqual([
      'Torriden Balanceful Serum',
      'SKIN1004 Madagascar Centella',
    ]);
  });

  it('leaves cost alone when the cell is blank', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6' }]), CONTEXT);
    expect(plan.receipts[0].items[0].unitCostCents).toBeNull();
    expect(costUpdates(plan)).toEqual([]);
  });

  // Restating the cost the app already holds is not a change, and listing it
  // would bury the ones that are.
  it('does not report a cost that matches what is already recorded', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': '4.50' }]),
      CONTEXT
    );
    expect(costUpdates(plan)).toEqual([]);
  });
});

describe('a quantity that looks like a slip', () => {
  // Warned about, not rejected: sometimes the pallet really did arrive. The
  // move sheet's equivalent is a hard error because stock can run out; nothing
  // runs out when receiving, so the only honest signal is a warning.
  it('flags a receipt ten times what the store has ever held', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '800' }]), CONTEXT);
    expect(plan.rejected).toEqual([]);
    expect(plan.oversized).toEqual([
      { productName: 'Torriden Balanceful Serum', locationName: 'Jaalala Skincare', quantity: 800, held: 8 },
    ]);
  });

  it('says nothing about the first delivery of something the store holds none of', () => {
    const plan = planRestock(
      sheet([{ Product: 'SKIN1004 Madagascar Centella', Store: 'JL2', 'Quantity received': '500' }]),
      CONTEXT
    );
    expect(plan.oversized).toEqual([]);
  });
});
