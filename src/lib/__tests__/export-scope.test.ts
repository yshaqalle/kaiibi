import { exportFileName, exportScopeLabel } from '@/lib/export-scope';

describe('what an exported report says it covers', () => {
  it('names the window for a report that follows the range', () => {
    expect(exportScopeLabel({ rangeLabel: '1–14 Aug 2026', storeName: null })).toBe('1–14 Aug 2026 · All stores');
  });

  it('names the instant, with the time, for a position that ignores the range', () => {
    // Stock on hand is read at a moment. Two exports taken the same day are
    // different documents, so the minute has to be on the file.
    const label = exportScopeLabel({ rangeLabel: null, asOf: new Date('2026-08-14T16:32:00Z'), storeName: null });
    expect(label).toMatch(/^As at 14 Aug 2026, \d{2}:\d{2} · All stores$/);
  });

  it('never lets a position report claim a window', () => {
    // The failure this guards: a Low Stock export stamped "1-14 Aug" would be a
    // file claiming to be a fortnight's stock position, which does not exist.
    const label = exportScopeLabel({ rangeLabel: null, asOf: new Date('2026-08-14T16:32:00Z'), storeName: null });
    expect(label).not.toContain('–');
    expect(label).toContain('As at');
  });

  it('carries the chosen store, so one branch is not mistaken for the business', () => {
    expect(exportScopeLabel({ rangeLabel: '7 days', storeName: 'Jaalala Skincare' })).toBe('7 days · Jaalala Skincare');
  });

  it('says All stores rather than going silent on the combined view', () => {
    expect(exportScopeLabel({ rangeLabel: '7 days', storeName: null })).toContain('All stores');
  });
});

describe('the file name', () => {
  it('carries the scope, so a folder of exports can be told apart', () => {
    expect(exportFileName('sales-by-category', '1–14 Aug 2026 · All stores')).toBe(
      'sales-by-category-1-14-aug-2026-all-stores'
    );
  });

  it('flattens punctuation rather than emitting it into a filename', () => {
    const name = exportFileName('low stock', 'As at 14 Aug 2026, 16:32 · Jaalala Skincare');
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).not.toMatch(/--/);
    expect(name.startsWith('low-stock-')).toBe(true);
  });
});
