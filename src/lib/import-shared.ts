import { rowsToCsv } from '@/lib/csv';
import { shareCsv } from '@/lib/export-file';

// `row` is the 1-based line number in the uploaded file (header row is 1, so
// the first data row is 2) -- shown to the user so they can find it in their
// spreadsheet without re-counting.
export type RejectedRow = { row: number; reason: string; data: Record<string, string> };
export type ImportReport<T> = { accepted: T[]; rejected: RejectedRow[] };

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
