import { useMemo } from 'react';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { csvColumnsOf, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { exportFileName, exportScopeLabel } from '@/lib/export-scope';
import type { ReportSection } from '@/lib/report-pdf';

/**
 * Puts Export CSV / Export PDF on a report's title row.
 *
 * A component rather than a hook call inside each screen for the reason
 * `ReportsHeaderActions` already is one: every report returns early while
 * loading, and its rows are only defined past that point, so a hook above the
 * early return would publish an empty file and a hook below it would break the
 * rules-of-hooks. Rendering this as a child sidesteps both -- it mounts only
 * once there is something to export.
 *
 * It takes the screen's OWN `columns`, not a second export list: the file and
 * the table are then the same declaration, and a renamed header cannot reach
 * one without the other. Columns with no `text` are dropped, which is how a
 * chevron or a share bar stays out of the spreadsheet.
 */
export function ReportExport<T>({
  setHeaderActions,
  rows,
  columns,
  title,
  /**
   * The shell's range label for a report that follows the range, and null for
   * one that does not. Null is not "unknown" -- it is the screen saying it
   * reports a position rather than a window, and it makes the subtitle read
   * "As at ..." instead. Getting this wrong is how a stock export ends up
   * claiming to be a fortnight.
   */
  rangeLabel,
  locationFilter,
  filenamePrefix,
  pdfSections,
}: {
  setHeaderActions: HeaderActionsSetter;
  rows: T[];
  columns: Column<T>[];
  title: string;
  rangeLabel: string | null;
  locationFilter: string | null;
  filenamePrefix: string;
  /** Extra tables the PDF carries and the CSV cannot. See ExportMenu. */
  pdfSections?: ReportSection[];
}) {
  const { shop, locations } = useAuth();

  // Resolved here rather than passed down, because the shell holds the store's
  // ID and only `useAuth` knows its name -- and an export headed by a UUID is
  // an export nobody can attribute.
  const storeName = useMemo(
    () => (locationFilter ? (locations?.find((l) => l.id === locationFilter)?.name ?? null) : null),
    [locationFilter, locations]
  );

  // `asOf` is read at render rather than at press, which is the honest instant:
  // it is when the figures on screen were fetched, and the press only writes
  // them out. Stamping the press time would date a position to a moment after
  // the one it describes.
  const scope = useMemo(
    () => exportScopeLabel({ rangeLabel, asOf: new Date(), storeName }),
    // `new Date()` is deliberately NOT a dependency and cannot be one: the
    // stamp is meant to be stable for as long as the screen is mounted. A
    // position report has no range to change, so recomputing this every render
    // would make the "As at" time drift while the reader looked at it.
    [rangeLabel, storeName]
  );

  const csvColumns = useMemo(() => csvColumnsOf(columns), [columns]);
  const fullTitle = shop ? `${shop.name} — ${title}` : title;

  useHeaderActions(
    setHeaderActions,
    <ExportMenu
      variant="bento"
      rows={rows}
      columns={csvColumns}
      title={fullTitle}
      subtitle={scope}
      filenamePrefix={exportFileName(filenamePrefix, scope)}
      pdfSections={pdfSections}
    />,
    [rows, csvColumns, fullTitle, scope, filenamePrefix, pdfSections]
  );

  return null;
}
