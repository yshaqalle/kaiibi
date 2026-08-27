import {
  categoryLabel,
  groupBy,
  grossProfitCents,
  lowStockReading,
  marginPercent,
  movementTotals,
  reorderShortfall,
  reorderUrgency,
  sequenceMovements,
  shareOfTotal,
  stockValueCents,
  UNCATEGORISED,
  type MovementRow,
} from '@/lib/report-math';

describe('gross profit', () => {
  it('excludes uncosted lines from cost but not from revenue, and says how many', () => {
    // 3 lines, one uncosted. Revenue counts all three; cost counts two. Numbers
    // picked so a wrong implementation cannot coincide: 1000+2000+4000 = 7000
    // revenue against 1200 cost, and no pairing of these gives 7000 or 1200 by
    // accident.
    const r = grossProfitCents([
      { lineTotalCents: 1000, unitCostCents: 400, quantity: 1 },
      { lineTotalCents: 2000, unitCostCents: 800, quantity: 1 },
      { lineTotalCents: 4000, unitCostCents: null, quantity: 1 },
    ]);
    expect(r).toEqual({ revenueCents: 7000, costCents: 1200, uncostedLines: 1 });
  });

  it('multiplies unit cost by quantity, not by line count', () => {
    // The bug this catches: cost read as unitCostCents alone. 3 x 500 = 1500,
    // which is visibly not 500.
    expect(grossProfitCents([{ lineTotalCents: 3000, unitCostCents: 500, quantity: 3 }]).costCents).toBe(1500);
  });

  it('counts a zero cost as a cost, rather than as a missing one', () => {
    // A product genuinely costing nothing (a sample, a giveaway) is not the same
    // fact as a product nobody has costed, and the caveat on the screen names
    // only the second. Zero is falsy, so an implementation testing truthiness
    // rather than null reports this line as uncosted.
    const r = grossProfitCents([{ lineTotalCents: 900, unitCostCents: 0, quantity: 4 }]);
    expect(r).toEqual({ revenueCents: 900, costCents: 0, uncostedLines: 0 });
  });

  it('reports nothing at all as zeroes rather than throwing', () => {
    expect(grossProfitCents([])).toEqual({ revenueCents: 0, costCents: 0, uncostedLines: 0 });
  });
});

describe('margin', () => {
  it('has no margin when there is no revenue, rather than reporting zero', () => {
    // 0% reads as "sold at cost". Null reads as "nothing sold", which is true.
    expect(marginPercent(0, 0)).toBeNull();
    expect(marginPercent(1000, 600)).toBeCloseTo(40);
  });

  it('reports a negative margin rather than clamping it', () => {
    // Selling below cost is real and worth seeing.
    expect(marginPercent(1000, 1500)).toBeCloseTo(-50);
  });

  it('has no margin on a day that sold nothing but still had costs', () => {
    // Revenue 0 with a cost recorded is a real shape -- a write-off day -- and
    // dividing by it gives -Infinity, which renders as "-∞%".
    expect(marginPercent(0, 2500)).toBeNull();
  });
});

describe('share of a total', () => {
  it('has no share of nothing, rather than reporting zero', () => {
    expect(shareOfTotal(0, 0)).toBeNull();
  });

  it('is the part over the whole, not the other way round', () => {
    // 250 of 1000 is 25%, and 1000 of 250 would be 400% -- so an inverted
    // implementation cannot pass this by coincidence.
    expect(shareOfTotal(250, 1000)).toBeCloseTo(25);
  });
});

describe('grouping', () => {
  it('keeps rows in the order they arrived, both between groups and within one', () => {
    // A report reads down a column; a grouping that reorders rows silently
    // reorders the report.
    const rows = [
      { cat: 'b', n: 1 },
      { cat: 'a', n: 2 },
      { cat: 'b', n: 3 },
    ];
    const grouped = groupBy(rows, (row) => row.cat);
    expect(Object.keys(grouped)).toEqual(['b', 'a']);
    expect(grouped.b.map((r) => r.n)).toEqual([1, 3]);
    expect(grouped.a.map((r) => r.n)).toEqual([2]);
  });

  it('groups a category literally called __proto__ rather than losing it', () => {
    // The keys are user data -- a category, a cashier name, a store. Assigning
    // `__proto__` onto a plain object sets the prototype instead of a property,
    // and the whole group vanishes from the report with no error anywhere.
    const grouped = groupBy([{ cat: '__proto__' as const, n: 7 }], (row) => row.cat);
    expect(Object.keys(grouped)).toEqual(['__proto__']);
    expect(grouped.__proto__.map((r) => r.n)).toEqual([7]);
  });
});

describe('category labelling', () => {
  it('names the bucket rather than dropping the product', () => {
    // Uncategorised is a ROW, not a filter. 175 products have no category, and
    // hiding them makes the percentages add to less than the shop took.
    expect(categoryLabel(null)).toBe(UNCATEGORISED);
    expect(categoryLabel(undefined)).toBe(UNCATEGORISED);
    expect(categoryLabel('')).toBe(UNCATEGORISED);
  });

  it('treats whitespace as blank, so a CSV import cannot open a second bucket', () => {
    expect(categoryLabel('   ')).toBe(UNCATEGORISED);
    expect(categoryLabel(' Drinks ')).toBe('Drinks');
  });

  it('leaves a real category alone', () => {
    expect(categoryLabel('Staples')).toBe('Staples');
  });

  it('puts uncategorised products in the total, so the shares still add up', () => {
    // The whole point, asserted end to end: group by label, and the bucket's
    // revenue is part of the total the shares are taken of. 300 of 1200 is 25%,
    // and dropping the bucket would make it 300 of 900, which is 33.3%.
    const rows = [
      { category: 'Staples', revenueCents: 600 },
      { category: null, revenueCents: 300 },
      { category: 'Drinks', revenueCents: 300 },
    ];
    const grouped = groupBy(rows, (row) => categoryLabel(row.category));
    const total = rows.reduce((sum, row) => sum + row.revenueCents, 0);
    expect(Object.keys(grouped)).toContain(UNCATEGORISED);
    expect(shareOfTotal(grouped[UNCATEGORISED][0].revenueCents, total)).toBeCloseTo(25);
  });
});

describe('stock value', () => {
  it('counts unvalued stock separately from zero-valued stock', () => {
    // null cost is unknown; 0 is free. A shop with both must not see them merged.
    const r = stockValueCents([
      { stock: 10, costCents: 100 },
      { stock: 5, costCents: null },
      { stock: 4, costCents: 0 },
    ]);
    expect(r).toEqual({ valueCents: 1000, unvalued: 1 });
  });

  it('multiplies cost by units held, not by row count', () => {
    // 7 x 300 = 2100, which is visibly neither 300 nor 7.
    expect(stockValueCents([{ stock: 7, costCents: 300 }]).valueCents).toBe(2100);
  });
});

describe('reorder shortfall', () => {
  it('has no shortfall when no reorder level is set', () => {
    // reorder_level is nullable and most shops leave it blank. Treating null as
    // zero would report every product as adequately stocked, which is a silent
    // empty report rather than an honest one.
    expect(reorderShortfall({ stock: 3, reorderLevel: null })).toBeNull();
    expect(reorderShortfall({ stock: 3, reorderLevel: 20 })).toBe(17);
    expect(reorderShortfall({ stock: 30, reorderLevel: 20 })).toBe(0);
  });

  it('does not report a surplus as a negative shortfall', () => {
    // 30 against 20 is not "short by -10". The column is read as "order this
    // many".
    expect(reorderShortfall({ stock: 30, reorderLevel: 20 })).toBe(0);
  });
});

describe('reorder urgency', () => {
  it('calls an empty shelf Out, whatever the level is', () => {
    expect(reorderUrgency({ stock: 0, reorderLevel: 20 })).toBe('out');
  });

  it('calls at-or-under-half Critical and the rest Low', () => {
    // 4 of 25 is well under half; 18 of 20 is well over. The boundary itself --
    // 10 of 20 -- is Critical, because "half a delivery cycle left" is the
    // point the cycle stops covering it.
    expect(reorderUrgency({ stock: 4, reorderLevel: 25 })).toBe('critical');
    expect(reorderUrgency({ stock: 10, reorderLevel: 20 })).toBe('critical');
    expect(reorderUrgency({ stock: 11, reorderLevel: 20 })).toBe('low');
    expect(reorderUrgency({ stock: 18, reorderLevel: 20 })).toBe('low');
  });

  it('has no urgency for a stocked product or an unconfigured one', () => {
    expect(reorderUrgency({ stock: 30, reorderLevel: 20 })).toBeNull();
    expect(reorderUrgency({ stock: 0, reorderLevel: null })).toBeNull();
  });
});

describe('the low-stock reading', () => {
  it('lists what is short, worst first', () => {
    // Shortfalls 20, 21 and 2, deliberately not in input order and deliberately
    // not ordered by stock or by level either -- so a sort on the wrong column
    // cannot pass.
    const reading = lowStockReading([
      { sku: 'detergent', stock: 18, reorderLevel: 20 },
      { sku: 'milk', stock: 0, reorderLevel: 20 },
      { sku: 'oil', stock: 4, reorderLevel: 25 },
      { sku: 'rice', stock: 90, reorderLevel: 20 },
      { sku: 'sugar', stock: 1, reorderLevel: null },
    ]);
    expect(reading.rows.map((row) => row.sku)).toEqual(['oil', 'milk', 'detergent']);
    expect(reading.rows.map((row) => row.shortfall)).toEqual([21, 20, 2]);
    expect(reading.rows.map((row) => row.urgency)).toEqual(['critical', 'out', 'low']);
    expect(reading.emptyReason).toBeNull();
  });

  it('says nothing is low when levels are set and everything is above them', () => {
    const reading = lowStockReading([
      { stock: 90, reorderLevel: 20 },
      { stock: 21, reorderLevel: 20 },
    ]);
    expect(reading.rows).toEqual([]);
    expect(reading.configured).toBe(2);
    expect(reading.emptyReason).toBe('nothing-low');
  });

  it('says nothing is configured when no reorder level is set anywhere', () => {
    // THE TWO EMPTY STATES ARE DIFFERENT FACTS. This shop has a product at zero
    // and one at one unit -- it is not in good shape -- and an empty report
    // reading "nothing is low" would tell it that it is.
    const reading = lowStockReading([
      { stock: 0, reorderLevel: null },
      { stock: 1, reorderLevel: null },
    ]);
    expect(reading.rows).toEqual([]);
    expect(reading.configured).toBe(0);
    expect(reading.emptyReason).toBe('none-configured');
  });

  it('says nothing is low, not nothing is configured, when only some are set', () => {
    // The mixed shop, which is the common one. One product has a level and is
    // fine; forty do not. The report is empty for the first reason, not the
    // second, and a `configured === rows.length` test would get it backwards.
    const reading = lowStockReading([
      { stock: 90, reorderLevel: 20 },
      { stock: 0, reorderLevel: null },
    ]);
    expect(reading.configured).toBe(1);
    expect(reading.emptyReason).toBe('nothing-low');
  });
});

describe('stock movement', () => {
  const row = (over: Partial<MovementRow> & { id: string }): MovementRow => ({
    kind: 'received',
    at: '2026-08-20',
    what: 'Juba Traders',
    detail: null,
    where: 'Hodan',
    by: 'Amina H',
    units: 1,
    ...over,
  });

  it('reads three sources as one sequence, newest first', () => {
    // Input order is deliberately neither chronological nor grouped by kind:
    // three queries resolve in whatever order they resolve in.
    const sequenced = sequenceMovements([
      row({ id: 'r1', kind: 'received', at: '2026-08-20' }),
      row({ id: 'c1', kind: 'count', at: '2026-08-21' }),
      row({ id: 't1', kind: 'transfer', at: '2026-08-18' }),
    ]);
    expect(sequenced.map((m) => m.id)).toEqual(['c1', 'r1', 't1']);
  });

  it('orders same-day movements stably rather than however the queries resolved', () => {
    // Two deliveries booked on one day would otherwise reshuffle between
    // refreshes, which reads as the list changing under the reader.
    const one = sequenceMovements([row({ id: 'b', at: '2026-08-20' }), row({ id: 'a', at: '2026-08-20' })]);
    const other = sequenceMovements([row({ id: 'a', at: '2026-08-20' }), row({ id: 'b', at: '2026-08-20' })]);
    expect(one.map((m) => m.id)).toEqual(['a', 'b']);
    expect(other.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    // It is handed the state array. Sorting in place mutates state without a
    // re-render, so the screen shows the old order until something else changes.
    const rows = [row({ id: 'b', at: '2026-08-18' }), row({ id: 'a', at: '2026-08-21' })];
    sequenceMovements(rows);
    expect(rows.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('totals each kind separately and keeps a write-off negative', () => {
    // Distinct figures per kind so a total attributed to the wrong bucket
    // cannot pass: 142 + 8062 received, 430 transferred, -284 counted.
    const totals = movementTotals([
      row({ id: 'r1', kind: 'received', units: 142 }),
      row({ id: 'r2', kind: 'received', units: 8062 }),
      row({ id: 't1', kind: 'transfer', units: 430 }),
      row({ id: 'c1', kind: 'count', units: -284 }),
    ]);
    expect(totals).toEqual({
      received: { units: 8204, count: 2 },
      transfer: { units: 430, count: 1 },
      count: { units: -284, count: 1 },
    });
  });

  it('reports every kind as zero when nothing moved, rather than omitting it', () => {
    // The KPI strip renders three tiles either way. A missing key renders
    // "undefined" where a figure belongs.
    expect(movementTotals([])).toEqual({
      received: { units: 0, count: 0 },
      transfer: { units: 0, count: 0 },
      count: { units: 0, count: 0 },
    });
  });
});
