import { buildDashboardReportHtml } from '@/lib/report-pdf';
import { statementSections } from '@/lib/statement-sections';

type Line = { section: string; label: string; amount: string; isTotal: boolean };
const L = (section: string, label: string, amount: string, isTotal = false): Line => ({ section, label, amount, isTotal });

const read = {
  section: (r: Line) => r.section,
  label: (r: Line) => r.label,
  amount: (r: Line) => r.amount,
  isTotal: (r: Line) => r.isTotal,
};
const HEADINGS = { revenue: 'Revenue', cost_of_sales: 'Cost of sales' };

const STATEMENT: Line[] = [
  L('revenue', 'Sales', '$247.85'),
  L('revenue', 'Total revenue', '$247.85', true),
  L('cost_of_sales', 'Stock sold', '$149.96'),
  L('cost_of_sales', 'Total cost of sales', '$149.96', true),
  L('gross_profit', 'Gross profit', '$97.89', true),
];

describe('a statement as printable sections', () => {
  it('gives each section its heading', () => {
    const s = statementSections(STATEMENT, read, HEADINGS);
    expect(s.map((x) => x.title)).toEqual(['Revenue', 'Cost of sales', '']);
  });

  it('keeps every line, and keeps them in reading order', () => {
    // The order IS the document: a subtotal follows the accounts it sums, and
    // re-sorting would put a total above its own lines.
    const s = statementSections(STATEMENT, read, HEADINGS);
    expect(s.flatMap((x) => x.rows.map((r: Line) => r.label))).toEqual([
      'Sales', 'Total revenue', 'Stock sold', 'Total cost of sales', 'Gross profit',
    ]);
  });

  it('leaves a lone subtotal without a heading over it', () => {
    // Gross profit is one line and no accounts. A header above a single row is
    // noise in a printed statement.
    const s = statementSections(STATEMENT, read, HEADINGS);
    const last = s[s.length - 1];
    expect(last.title).toBe('');
    expect(last.rows).toHaveLength(1);
  });

  it('groups by consecutive run, so a section appearing twice stays twice', () => {
    const twice = [L('a', 'one', '1'), L('b', 'two', '2'), L('a', 'three', '3')];
    expect(statementSections(twice, read, { a: 'A', b: 'B' }).map((s) => s.title)).toEqual(['A', 'B', 'A']);
  });

  it('carries two columns — the line and its amount', () => {
    const [first] = statementSections(STATEMENT, read, HEADINGS);
    expect(first.columns.map((c) => c.header)).toEqual(['Line', 'Amount']);
    expect(first.columns[1].value(STATEMENT[0])).toBe('$247.85');
  });

  it('returns nothing for a statement with no lines', () => {
    expect(statementSections([], read, HEADINGS)).toEqual([]);
  });
});

describe('the document those sections become', () => {
  // The end of the chain: sections in, printable HTML out. Asserted here rather
  // than in the browser because `sharePdf` PRINTS on web (export-file.ts) --
  // there is no download to catch, so the document itself is the thing to check.
  it('prints every line under its heading, in order', () => {
    const html = buildDashboardReportHtml({
      title: 'yusefshop — Income Statement',
      subtitle: '1–14 Aug 2026 · All stores',
      stats: [],
      sections: statementSections(STATEMENT, read, HEADINGS),
    });
    expect(html).toContain('yusefshop — Income Statement');
    expect(html).toContain('1–14 Aug 2026 · All stores');
    for (const line of ['Sales', 'Total revenue', 'Stock sold', 'Gross profit']) {
      expect(html).toContain(line);
    }
    // Headings precede the lines they head.
    expect(html.indexOf('Revenue')).toBeLessThan(html.indexOf('Stock sold'));
    expect(html.indexOf('Cost of sales')).toBeLessThan(html.indexOf('Gross profit'));
  });

  it('keeps the amounts as the screen formatted them', () => {
    const html = buildDashboardReportHtml({
      title: 'x', subtitle: 'y', stats: [], sections: statementSections(STATEMENT, read, HEADINGS),
    });
    expect(html).toContain('$247.85');
    expect(html).toContain('$97.89');
  });
});
