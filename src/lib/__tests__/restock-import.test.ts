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
import { readTypedCost } from '@/lib/restock-typed-input';
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
    // Both the zero and the negative rejection mention "Count", so asserting
    // only that would pass even with the two messages swapped. Pin the words
    // only the zero message says.
    expect(plan.rejected[0].reason).toMatch(/which would change nothing/);
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

describe('note', () => {
  // Same rule as Unit cost: a half-finished row (something filled in besides
  // Quantity received) is a mistake to flag, not a silent skip.
  it('rejects a note with no quantity received', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', Note: '2 arrived broken' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toMatch(/Note is filled in but Quantity received is empty/);
  });

  it('lands a note alongside a quantity on the store\'s receipt', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', Note: '2 arrived broken' }]),
      CONTEXT
    );
    expect(plan.receipts[0].note).toBe('2 arrived broken');
  });

  // Pins the behaviour the corrected comment in planRestock now describes:
  // one stock_receipts row per store means one note column, so a second note
  // for the same store is dropped -- silently, not rejected.
  it('drops a second note for the same store, keeping the first', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6', Note: '2 arrived broken' },
        { Product: 'SKIN1004 Madagascar Centella', 'Quantity received': '4', Note: 'short shipped' },
      ]),
      CONTEXT
    );
    expect(plan.receipts).toHaveLength(1);
    expect(plan.receipts[0].note).toBe('2 arrived broken');
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

  // The cost reader strips everything outside the digits and separators before
  // parsing, and Number('') is 0 -- so a cell with no digits at all must not
  // fall through to the free-sample value. null means "the shop didn't say"; a
  // cell that says nothing sayable must produce null, not a silent $0.00 that
  // overwrites whatever cost the product already has.
  it('rejects a unit cost cell with no digits at all, rather than reading it as zero', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': 'n/a' }]),
      CONTEXT
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/Unit cost must be an amount of money/);
  });

  // The fix above must not over-correct: a genuine zero -- a free sample --
  // is a real answer and has to keep being accepted.
  it('accepts a genuine zero cost, since a free sample really does cost nothing', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': '0' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.receipts[0].items[0].unitCostCents).toBe(0);
  });
});

// One string, one reading, whichever door it came in by.
//
// Both routes write products.cost_cents, and until the sheet started reading
// its Unit cost column with readTypedCost they disagreed: "1,50" was $1.50 by
// hand and $150.00 by sheet, and "1.234,56" was $1,234.56 by hand and silently
// $1.23 by sheet. Nothing on either screen said which reading it had taken.
//
// The by-hand reading is asserted alongside each case rather than left implied,
// so a change to one route that quietly parts from the other goes red here
// rather than in a shop's cost of goods.
describe('a cost read the same way by both routes', () => {
  // The whole cell, as the plan reads it: cents, or the rejection it produced.
  const bySheet = (cell: string): number | null | string => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': cell }]),
      CONTEXT
    );
    if (plan.rejected.length > 0) return `rejected: ${plan.rejected[0].reason}`;
    return plan.receipts[0].items[0].unitCostCents;
  };
  const byHand = (cell: string): number | string => {
    const reading = readTypedCost(cell);
    return reading.kind === 'cents' ? reading.cents : `${reading.kind}:${reading.kind === 'unreadable' ? reading.reason : ''}`;
  };

  it('reads a comma-locale decimal point the same way the by-hand field does', () => {
    // A comma-locale Excel writes this into the cell exactly as a comma-locale
    // phone keyboard writes it into the field. It was a hundred times too much.
    expect(bySheet('1,50')).toBe(150);
    expect(byHand('1,50')).toBe(150);
    expect(bySheet('1,5')).toBe(150);
    expect(byHand('1,5')).toBe(150);
  });

  it('still reads a comma-grouped thousand as a thousand', () => {
    expect(bySheet('1,500')).toBe(150000);
    expect(byHand('1,500')).toBe(150000);
    expect(bySheet('1,234,567')).toBe(123456700);
    expect(byHand('1,234,567')).toBe(123456700);
  });

  it('reads both groupings of the same money as the same money', () => {
    // "1.234,56" used to strip to "1.23456" -- and Number("1.23456") is
    // 1.23456, not NaN, so the old parser did NOT reject this cell. It
    // silently wrote 123c ($1.23) into products.cost_cents for a perfectly
    // ordinary European price of $1,234.56, with nothing on screen to say a
    // cost had been read wrong by three orders of magnitude.
    expect(bySheet('1.234,56')).toBe(123456);
    expect(byHand('1.234,56')).toBe(123456);
    expect(bySheet('1,234.56')).toBe(123456);
    expect(byHand('1,234.56')).toBe(123456);
  });

  it('is still lenient about a currency symbol a spreadsheet formatted in', () => {
    expect(bySheet('$4.80')).toBe(480);
    expect(byHand('$4.80')).toBe(480);
  });

  // A credit note typed into a cost box. Stripping the minus turned it into a
  // positive 450c, which then failed the column's own `unit_cost_cents >= 0`
  // check on the server -- a raw Postgres string on a screen that had been
  // explaining itself in sentences.
  it('refuses a negative cost by name rather than letting the server refuse it', () => {
    expect(bySheet('-4.50')).toMatch(/rejected: Unit cost must be an amount of money/);
    expect(byHand('-4.50')).toBe('unreadable:not-an-amount');
  });

  // Finite, and far past what a Postgres integer holds. This used to travel
  // all the way to the RPC and come back as "integer out of range".
  it('tells an amount too large for the column apart from an unreadable one', () => {
    expect(bySheet('999999999999,99')).toMatch(/rejected: Unit cost is larger than a cost can be/);
    expect(byHand('999999999999,99')).toBe('unreadable:too-large');
  });

  it('still has no reading at all for a string of dots', () => {
    expect(bySheet('12.3.4.5')).toMatch(/rejected: Unit cost must be an amount of money/);
    expect(byHand('12.3.4.5')).toBe('unreadable:not-an-amount');
  });

  // A different mess from the one above, and NOT the same outcome: once both
  // a comma and a dot are present, readTypedCost lets repeats of either
  // through (see restock-typed-input.ts's comment on this), so this one has a
  // reading -- 123450c -- rather than being refused like the dots-only case.
  // The old sheet parser rejected this shape outright (`Number('123.4.5')` is
  // NaN); the widened reading is pinned here rather than left implicit,
  // because on a sheet this is a garbled cell silently becoming a cost with
  // nothing typed to catch it, not a keypad slip someone can see happen.
  it('pins the widened reading of a mixed-separator mess the dots-only case does not cover', () => {
    expect(bySheet('12,3.4.5')).toBe(123450);
    expect(byHand('12,3.4.5')).toBe(123450);
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
