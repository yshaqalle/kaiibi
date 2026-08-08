import { rowsToCsv } from '@/lib/csv';
import { shareCsv } from '@/lib/export-file';

// `row` is the 1-based line number in the uploaded file (header row is 1, so
// the first data row is 2) -- shown to the user so they can find it in their
// spreadsheet without re-counting.
export type RejectedRow = { row: number; reason: string; data: Record<string, string> };
export type ImportReport<T> = { accepted: T[]; rejected: RejectedRow[] };

export type TemplateColumn = { header: string; required: boolean };

// The exact bytes the "Download example CSV" button hands over -- the app's own
// statement of the format it expects. Lives here rather than inside the modal
// so the round-trip test can generate a template the same way a user gets one,
// instead of a lookalike that can drift from it.
export function templateCsvText(templateColumns: TemplateColumn[], exampleRows: Record<string, string>[]): string {
  return rowsToCsv(
    exampleRows,
    templateColumns.map((c) => ({ header: c.header, value: (row: Record<string, string>) => row[c.header] ?? '' }))
  );
}

// The gate a picked file has to clear before any row is looked at. Optional
// columns may be absent entirely; a required one missing means the file is the
// wrong shape and no import is attempted.
export function missingRequiredColumns(templateColumns: TemplateColumn[], headers: string[]): TemplateColumn[] {
  return templateColumns.filter((c) => c.required && !headers.includes(c.header));
}

// Lets a failed import be fixed and re-uploaded without retyping everything
// that already passed -- only the rejected rows, in their original columns
// plus a trailing Reason column explaining what to fix.
export async function downloadRejectedRowsCsv(rejected: RejectedRow[], originalHeaders: string[], filename: string): Promise<void> {
  const columns = [
    ...originalHeaders.map((header) => ({ header, value: (r: RejectedRow) => r.data[header] ?? '' })),
    { header: 'Reason', value: (r: RejectedRow) => r.reason },
  ];
  await shareCsv(rowsToCsv(rejected, columns), filename, 'Rows that need fixing');
}
