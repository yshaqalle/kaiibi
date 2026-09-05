import type { CsvColumn } from '@/lib/csv';
import type { ReportSection } from '@/lib/report-pdf';

/**
 * A statement, turned into the sections a PDF can print.
 *
 * WHY THIS IS PDF-ONLY, AND NOT A CSV. A statement is a document rather than a
 * dataset: its meaning is in which lines roll into which subtotal, and a flat
 * grid either loses that hierarchy or fakes it with an indentation column
 * nothing can compute on. So the three statements export a PDF and deliberately
 * offer no CSV -- the one place in the app where a screen gives one format and
 * not the other. The five ledger TABLES next door give both, because they are
 * datasets and a row of one means the same thing out of context.
 *
 * The grouping is by CONSECUTIVE run, not by gathering every row of a section
 * together. `statement_lines()` returns rows already in reading order, with the
 * subtotal following the accounts it sums, and re-sorting them here would put a
 * total above its own lines. A section that legitimately appears twice stays
 * twice.
 */
export function statementSections<T>(
  rows: T[],
  read: {
    section: (row: T) => string;
    label: (row: T) => string;
    amount: (row: T) => string;
    /** True for a subtotal. It gets no heading of its own and closes a run. */
    isTotal: (row: T) => boolean;
  },
  /** Human headings by section key. A key with no entry keeps its own label. */
  headings: Record<string, string>
): ReportSection[] {
  const columns: CsvColumn<T>[] = [
    { header: 'Line', value: read.label },
    { header: 'Amount', value: read.amount },
  ];

  const out: ReportSection[] = [];
  let current: { key: string; rows: T[] } | null = null;

  for (const row of rows) {
    const key = read.section(row);
    if (!current || current.key !== key) {
      current = { key, rows: [] };
      out.push({ title: headings[key] ?? '', columns: columns as CsvColumn<any>[], rows: current.rows });
    }
    current.rows.push(row);
  }

  // A run holding nothing but its own subtotal -- gross profit, net profit --
  // is a single line, and a heading above one line is noise. It keeps the empty
  // title so the PDF prints the row without a header over it.
  return out.filter((section) => section.rows.length > 0);
}
