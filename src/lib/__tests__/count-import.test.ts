// The count sheet's rules, at the boundary a person actually meets them: a CSV
// generated the way the download button generates it, read back the way the
// picker reads it. Nothing here touches Supabase -- planCount is pure, which is
// what makes every rule below cheap enough to state as its own case.

import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import {
  COUNT_SHEET_COLUMNS,
  COUNT_TEMPLATE_COLUMNS,
  countSheetRows,
  planCount,
  planLines,
  summariseCount,
  type CountSheetRow,
} from '@/lib/count-import';
import { missingRequiredColumns } from '@/lib/import-shared';
import type { Product, ShopLocation } from '@/types/models';

const MAIN = { id: 'loc-main', name: 'Jaalala Skincare', code: 'JL1', active: true } as ShopLocation;
const SECOND = { id: 'loc-2', name: 'Jaalala 2', code: 'JL2', active: true } as ShopLocation;
const CLOSED = { id: 'loc-closed', name: 'Jaalala Kiosk', code: 'JLK', active: false } as ShopLocation;
const LOCATIONS = [MAIN, SECOND, CLOSED];

const serum = {
  id: 'p-serum', name: 'Torriden Balanceful Serum', sku: 'TOR-BAL-100',
  barcode: '8809611860018', costCents: 461, shelfNumber: 'A3',
} as Product;
const centella = {
  id: 'p-centella', name: 'SKIN1004 Madagascar Centella', sku: 'SKIN1004',
  barcode: null, costCents: 461, shelfNumber: 'A3',
} as Product;
const sun = {
  id: 'p-sun', name: 'Beauty of Joseon Relief Sun', sku: 'BOJ-SUN-50',
  barcode: '8809611860025', costCents: null, shelfNumber: 'B1',
} as Product;
const PRODUCTS = [serum, centella, sun];

const STOCK: Record<string, number> = {
  'p-serum|loc-main': 11,
  'p-centella|loc-main': 24,
  'p-sun|loc-main': 12,
  'p-serum|loc-2': 4,
};
const stockAt = (productId: string, locationId: string) => STOCK[`${productId}|${locationId}`] ?? 0;

const CONTEXT = { products: PRODUCTS, locations: LOCATIONS, stockAt };

function sheet(rows: Partial<Record<string, string>>[]): ParsedCsv {
  const full = rows.map((row) => ({
    Product: '',
    SKU: '',
    Barcode: '',
    Store: 'Jaalala Skincare',
    Shelf: '',
    'App says': '',
    Counted: '',
    Reason: '',
    ...row,
  }));
  return parseCsvText(
    rowsToCsv(
      full,
      COUNT_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
    )
  );
}

const entry = (product: Product, location: ShopLocation, stock: number, shelfNumber: string | null): CountSheetRow => ({
  product,
  location,
  stock,
  shelfNumber,
});

describe('the sheet the shop downloads', () => {
  it('clears the picker its own template has to pass', () => {
    const csv = parseCsvText(rowsToCsv([], COUNT_SHEET_COLUMNS));
    expect(missingRequiredColumns(COUNT_TEMPLATE_COLUMNS, csv.headers)).toEqual([]);
  });

  // THE difference from the restock sheet, and the reason the column exists on
  // this one. A delivery is unpacked from a box, so its sheet can come back in
  // whatever order the catalogue does. A stock-take is WALKED, shelf by shelf,
  // and a sheet in the order of the room is the difference between an hour and
  // an afternoon.
  it('sorts by shelf rather than by name', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(sun, MAIN, 12, 'B1'),
      entry(serum, MAIN, 11, 'A3'),
      entry(centella, MAIN, 24, 'A3'),
    ]);
    expect(rows.map((r) => [r.shelfNumber, r.product.name])).toEqual([
      ['A3', 'SKIN1004 Madagascar Centella'],
      ['A3', 'Torriden Balanceful Serum'],
      ['B1', 'Beauty of Joseon Relief Sun'],
    ]);
  });

  // A3, A10, A11 -- not A1, A10, A11, A2. A shelf label is a place in a room,
  // and plain string ordering sends the walker back down the aisle.
  it('reads a shelf number as a number, not as text', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, MAIN, 1, 'A10'),
      entry(centella, MAIN, 1, 'A2'),
      entry(sun, MAIN, 1, 'A1'),
    ]);
    expect(rows.map((r) => r.shelfNumber)).toEqual(['A1', 'A2', 'A10']);
  });

  // Last, not first: an unshelved product is the one hunted for at the end of
  // the walk, and putting it at the top would start every stock-take with the
  // items nobody can find.
  it('puts products with no shelf at the end', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, MAIN, 1, null),
      entry(centella, MAIN, 1, 'B1'),
    ]);
    expect(rows.map((r) => r.product.name)).toEqual([
      'SKIN1004 Madagascar Centella',
      'Torriden Balanceful Serum',
    ]);
  });

  // Shelf order across two stores is meaningless -- A3 in Jaalala is not near
  // A3 in Jaalala 2 -- so the store is the outer sort and the walk happens
  // within it.
  it('groups by store before it sorts by shelf', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, SECOND, 4, 'A1'),
      entry(centella, MAIN, 24, 'B9'),
      entry(serum, MAIN, 11, 'A3'),
    ]);
    expect(rows.map((r) => [r.location.name, r.shelfNumber])).toEqual([
      ['Jaalala Skincare', 'A3'],
      ['Jaalala Skincare', 'B9'],
      ['Jaalala 2', 'A1'],
    ]);
  });

  it('leaves out closed stores', () => {
    const rows = countSheetRows(LOCATIONS, [entry(serum, CLOSED, 3, 'A1'), entry(serum, MAIN, 11, 'A3')]);
    expect(rows.some((r) => r.location.id === CLOSED.id)).toBe(false);
  });

  it('states what the app believes and leaves the two cells the shop fills empty', () => {
    const parsed = parseCsvText(rowsToCsv(countSheetRows(LOCATIONS, [entry(serum, MAIN, 11, 'A3')]), COUNT_SHEET_COLUMNS));
    expect(parsed.rows[0]).toMatchObject({
      Product: 'Torriden Balanceful Serum',
      SKU: 'TOR-BAL-100',
      Store: 'JL1',
      Shelf: 'A3',
      'App says': '11',
      Counted: '',
      Reason: '',
    });
  });
});

describe('planning a stock-take', () => {
  it('replaces the count rather than adding to it, and records the variance', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' }]), CONTEXT);
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0]).toEqual({
      productId: 'p-serum',
      productName: 'Torriden Balanceful Serum',
      previousQuantity: 11,
      countedQuantity: 8,
      variance: -3,
      reason: 'damaged',
      unitCostCents: 461,
    });
  });

  it('reads a count that found more as a positive variance', () => {
    const plan = planCount(sheet([{ Product: 'SKIN1004 Madagascar Centella', Counted: '26' }]), CONTEXT);
    expect(plan.counts[0].lines[0].variance).toBe(2);
    expect(plan.counts[0].lines[0].reason).toBeNull();
  });

  // The one that decides whether a shop can count one shelf. A row left blank
  // is a product NOT COUNTED, and a product not counted keeps its number -- it
  // never reaches the RPC at all.
  it('leaves blank rows out of the count entirely rather than zeroing them', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8' }, {}, {}, {}]),
      CONTEXT
    );
    expect(plan.skipped).toBe(3);
    expect(plan.rejected).toEqual([]);
    expect(planLines(plan)).toHaveLength(1);
    expect(planLines(plan).map((l) => l.productId)).toEqual(['p-serum']);
  });

  // A zero IS a count, and the distinction from a blank cell is the whole
  // safety of the rule above.
  it('treats a counted zero as an empty shelf, not as a blank row', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '0' }]), CONTEXT);
    expect(plan.skipped).toBe(0);
    expect(plan.counts[0].lines[0]).toMatchObject({ countedQuantity: 0, variance: -11 });
  });

  // Nothing is trusted from the file's own "App says" column: it was true when
  // the sheet was downloaded, and a week of trading may have passed since.
  it('ignores the App says column and reads the live figure', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', 'App says': '999', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.counts[0].lines[0].previousQuantity).toBe(11);
  });

  it('groups by store, and reads each store’s own holding', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Torriden Balanceful Serum', Store: 'JL2', Counted: '4' },
      ]),
      CONTEXT
    );
    expect(plan.counts).toHaveLength(2);
    expect(plan.counts[0].lines[0]).toMatchObject({ previousQuantity: 11, variance: -3 });
    expect(plan.counts[1]).toMatchObject({ locationName: 'Jaalala 2' });
    expect(plan.counts[1].lines[0]).toMatchObject({ previousQuantity: 4, variance: 0 });
  });

  it('matches by SKU before name, so a tidied name still finds its product', () => {
    const plan = planCount(
      sheet([{ Product: 'torriden balanceful serum (100ml)', SKU: 'TOR-BAL-100', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0].productId).toBe('p-serum');
  });

  it('records an uncosted product with a null cost rather than a zero', () => {
    const plan = planCount(sheet([{ Product: 'Beauty of Joseon Relief Sun', Counted: '9' }]), CONTEXT);
    expect(plan.counts[0].lines[0].unitCostCents).toBeNull();
  });
});

describe('what a count sheet refuses', () => {
  it('rejects a reason with nothing counted', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Reason: 'Damaged' }]), CONTEXT);
    expect(plan.rejected[0].reason).toBe('Reason is filled in but Counted is empty — write down what you found.');
    expect(plan.skipped).toBe(0);
  });

  it('names Import products when the row is a product the shop does not carry', () => {
    const plan = planCount(sheet([{ Product: 'Anua Heartleaf Toner', Counted: '6' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Import products');
    expect(plan.rejected[0].row).toBe(2);
  });

  it('rejects a negative count and says what to write instead', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '-3' }]), CONTEXT);
    expect(plan.rejected[0].reason).toBe(
      'Counted cannot be negative — write down how many you found, and 0 if the shelf was empty.'
    );
  });

  it('rejects a count larger than the column can hold, separately from gibberish', () => {
    const big = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '9999999999' }]), CONTEXT);
    expect(big.rejected[0].reason).toContain('larger than a count can be');
    const junk = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: 'about 8' }]), CONTEXT);
    expect(junk.rejected[0].reason).toContain('whole number');
  });

  it('refuses a store it does not recognise, and names the ones it has', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Store: 'Hargeisa', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toContain('Jaalala Skincare, Jaalala 2');
  });

  it('rejects two rows counting the same product at the same store', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Torriden Balanceful Serum', Counted: '9' },
      ]),
      CONTEXT
    );
    expect(planLines(plan)).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/^Row 2 already counts/);
  });

  // Five reasons, and only five. The preview REPORTS how many lines have none,
  // so a sixth spelling would quietly become a sixth category nobody chose.
  it('rejects a reason that is not one of the five, and names them', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'shrinkage' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toBe(
      '"shrinkage" is not one of the reasons. Use Damaged, Expired, Theft or loss, Miscount or Other, or leave it empty.'
    );
  });

  it('accepts a reason however it is capitalised, and its stored spelling too', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'THEFT OR LOSS' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '20', Reason: 'theft_or_loss' },
      ]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(planLines(plan).map((l) => l.reason)).toEqual(['theft_or_loss', 'theft_or_loss']);
  });

  // A reason on a line that matched is kept, not dropped and not rejected. It
  // is the shop's own word about a product they looked at, the column has room
  // for it, and rejecting the row would block a 300-line stock-take over a cell
  // that changes no number.
  it('keeps a reason on a line whose count matched', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '11', Reason: 'Miscount' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0]).toMatchObject({ variance: 0, reason: 'miscount' });
  });
});

describe('what the count adds up to', () => {
  const linesOf = (rows: Partial<Record<string, string>>[]) => planLines(planCount(sheet(rows), CONTEXT));

  // The mockup's own by-hand frame, number for number: three counted, one
  // matched, two differ, netting −1 unit and −$4.61.
  it('nets the variance rather than reporting losses and finds separately', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary).toMatchObject({ counted: 3, matched: 1, differ: 2, varianceUnits: -1, varianceCents: -461 });
  });

  // The other number in that same frame, and it uses a DIFFERENT rule: the
  // checkbox offers $13.83 while the footer nets to −$4.61. Two units found are
  // not a negative expense -- nobody gets money back for stock that turned up
  // -- so the shortfall counts only the lines that came up short.
  it('values the shortfall gross, never netting the units that were found', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
      ])
    );
    expect(summary.varianceCents).toBe(-461);
    expect(summary.shortfallCents).toBe(1383);
  });

  // Hide, don't lie. An uncosted product contributes nothing to the total, so a
  // count full of them would offer to log a shortfall far smaller than the real
  // one -- a wrong number wearing a right one's clothes.
  it('withholds the shortfall entirely when a line that came up short is uncosted', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '9' },
      ])
    );
    expect(summary.shortfallCents).toBeNull();
    expect(summary.varianceCents).toBeNull();
    expect(summary.uncostedShortfallLines).toBe(1);
  });

  // But an uncosted line that MATCHED lost nothing, so it withholds nothing.
  it('still values a shortfall when the only uncosted line matched', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary.shortfallCents).toBe(1383);
    expect(summary.uncostedShortfallLines).toBe(0);
  });

  // And an uncosted line that came up LONG withholds the net figure without
  // withholding the shortfall -- they are two questions with two answers.
  it('withholds the net value but not the shortfall when an uncosted line came up long', () => {
    const STOCK_LONG = { ...CONTEXT, stockAt: (p: string, l: string) => (p === 'p-sun' ? 8 : stockAt(p, l)) };
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '9' },
      ]),
      STOCK_LONG
    );
    const summary = summariseCount(planLines(plan));
    expect(summary.varianceCents).toBeNull();
    expect(summary.shortfallCents).toBe(1383);
  });

  // The gap is REPORTED, never filled. Defaulting a blank to Miscount would be
  // a precise-looking answer to a question nobody asked.
  it('counts the lines that differ with no reason given', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary.reasonlessLines).toBe(1);
  });

  // An empty count must report NOTHING, not a count worth 0.00 that Task 9's
  // checkbox would then offer to log as an expense. This is the same trap that
  // produced a delivery worth 0.00 on the restock sheet -- `[].every()` is
  // true, and `[].reduce((a, b) => a + b, 0)` is 0, so an empty list looks
  // exactly like a complete and worthless one unless it is asked about.
  it('reports an empty count as nothing rather than as nothing lost', () => {
    expect(summariseCount([])).toEqual({
      counted: 0,
      matched: 0,
      differ: 0,
      varianceUnits: 0,
      varianceCents: 0,
      shortfallCents: 0,
      uncostedDifferingLines: 0,
      uncostedShortfallLines: 0,
      reasonlessLines: 0,
    });
  });
});
