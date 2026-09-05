import { useMemo } from 'react';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { useAuth } from '@/hooks/use-auth';
import { exportFileName, exportScopeLabel } from '@/lib/export-scope';
import { statementSections } from '@/lib/statement-sections';

/**
 * Export PDF on a financial statement's title row — and no Export CSV.
 *
 * The missing button is the point. The five ledger TABLES beside these give
 * both formats, because a row of a trial balance means the same thing out of
 * context. A statement does not: its meaning is in which lines roll into which
 * subtotal, so a flat grid either loses the hierarchy or fakes it with an
 * indentation column nothing can compute on. Offering a CSV here would produce
 * a file that looks like a balance sheet and cannot be used as one.
 *
 * Separate from `ReportExport` rather than a flag on it, because the two feed
 * the PDF from different shapes: that one takes `Column<T>[]` off a DataTable,
 * and a statement has no table to take them from.
 */
export function StatementExport<T>({
  setHeaderActions,
  rows,
  title,
  rangeLabel,
  headings,
  read,
  filenamePrefix,
}: {
  setHeaderActions: HeaderActionsSetter;
  rows: T[];
  title: string;
  /**
   * The window the statement covers, or null for one read at an instant. The
   * balance sheet is the null case: it is a position as at the range END, not
   * a period, and its own hub card says so.
   */
  rangeLabel: string | null;
  headings: Record<string, string>;
  read: {
    section: (row: T) => string;
    label: (row: T) => string;
    amount: (row: T) => string;
    isTotal: (row: T) => boolean;
  };
  filenamePrefix: string;
}) {
  const { shop } = useAuth();

  const scope = useMemo(
    () => exportScopeLabel({ rangeLabel, asOf: new Date(), storeName: null }),
    // Stable while the screen is mounted -- see ReportExport for why the
    // instant must not drift under the reader.
    [rangeLabel]
  );
  const sections = useMemo(() => statementSections(rows, read, headings), [rows, read, headings]);
  const fullTitle = shop ? `${shop.name} — ${title}` : title;

  useHeaderActions(
    setHeaderActions,
    <ExportMenu
      variant="bento"
      formats={['pdf']}
      // The CSV path is never reached, so these are the empty shapes rather
      // than a duplicate of the sections above.
      rows={[]}
      columns={[]}
      title={fullTitle}
      subtitle={scope}
      filenamePrefix={exportFileName(filenamePrefix, scope)}
      pdfSections={sections}
    />,
    [sections, fullTitle, scope, filenamePrefix]
  );

  return null;
}
