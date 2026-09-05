import { StyleSheet, type ViewStyle } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ExportMenu } from '@/components/export-menu';
import { csvColumnsOf, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { rowsToCsv } from '@/lib/csv';

const theme = Colors.light;

type Row = { name: string; units: number; revenueCents: number };

const ROWS: Row[] = [
  { name: 'Serum', units: 42, revenueCents: 90400 },
  { name: 'Cleanser, refill', units: 31, revenueCents: 55800 },
];

/**
 * The single list a report screen declares. `render` is what the table draws,
 * `text` is what the file carries -- one source, so a renamed header cannot
 * reach the CSV as the old one.
 */
const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Category', render: (r) => <NameCell title={r.name} />, text: (r) => r.name },
  { key: 'units', header: 'Units', numeric: true, render: (r) => <ValueCell value={String(r.units)} />, text: (r) => String(r.units) },
  {
    key: 'revenue',
    header: 'Revenue',
    numeric: true,
    render: (r) => <ValueCell value={`$${(r.revenueCents / 100).toFixed(2)}`} />,
    text: (r) => (r.revenueCents / 100).toFixed(2),
  },
  // No `text`, so it is not in the file. An on-screen-only column -- a chevron,
  // a share bar -- must not become an empty CSV column.
  { key: 'open', header: '', render: () => <ValueCell value="›" /> },
];

describe('exporting what a report table shows', () => {
  it('derives the CSV columns from the table columns', () => {
    expect(csvColumnsOf(COLUMNS).map((c) => c.header)).toEqual(['Category', 'Units', 'Revenue']);
  });

  it('drops columns that declare no text rather than exporting a blank one', () => {
    expect(csvColumnsOf(COLUMNS)).toHaveLength(COLUMNS.length - 1);
    expect(csvColumnsOf(COLUMNS).map((c) => c.header)).not.toContain('');
  });

  it('produces a file whose header row is the one on screen', () => {
    const csv = rowsToCsv(ROWS, csvColumnsOf(COLUMNS));
    const [header, first] = csv.split(/\r?\n/);
    expect(header).toBe('Category,Units,Revenue');
    expect(first).toBe('Serum,42,904.00');
  });

  it('quotes a value containing the delimiter, so a comma in a name cannot shift a column', () => {
    const csv = rowsToCsv(ROWS, csvColumnsOf(COLUMNS));
    expect(csv).toContain('"Cleanser, refill"');
  });

  it('renames in one place — the table header and the file header cannot disagree', () => {
    const renamed = COLUMNS.map((c) => (c.key === 'revenue' ? { ...c, header: 'Takings' } : c));
    expect(csvColumnsOf(renamed).map((c) => c.header)).toContain('Takings');
    expect(csvColumnsOf(renamed).map((c) => c.header)).not.toContain('Revenue');
  });
});

describe('the export control on a bento screen', () => {
  const flat = (node: { props: { style?: unknown } }): ViewStyle =>
    (StyleSheet.flatten(node.props.style as ViewStyle) ?? {}) as ViewStyle;

  const buttonsOf = (variant?: 'default' | 'bento') => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ExportMenu
          rows={ROWS}
          columns={csvColumnsOf(COLUMNS)}
          title="Sales by Category"
          filenamePrefix="sales-by-category"
          variant={variant}
        />,
      );
    });
    return tree.root
      .findAll((n) => typeof n.type === 'string' && typeof n.props.onClick === 'function')
      .map(flat);
  };

  it('still offers both formats', () => {
    expect(buttonsOf('bento')).toHaveLength(2);
  });

  it('wears the control-bar chip, not the cream block, so it sits beside the range pill', () => {
    for (const style of buttonsOf('bento')) {
      expect(style.backgroundColor).toBe(theme.bentoSurface);
      expect(style.borderColor).toBe(theme.bentoLine);
      expect(style.borderRadius).toBe(999);
    }
  });

  it('leaves the cream screens exactly as they were', () => {
    // Inventory, People and Schedule still render this and have not been
    // converted, so the default must not move under them.
    for (const style of buttonsOf()) {
      expect(style.backgroundColor).toBe('#111111');
      expect(style.borderRadius).toBe(10);
    }
  });
});
