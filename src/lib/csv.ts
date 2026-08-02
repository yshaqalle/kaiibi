import Papa from 'papaparse';

// A column knows how to pull its own display string out of a row, so export
// call sites just list columns once instead of building parallel header/value
// arrays that can drift out of sync.
export type CsvColumn<T> = { header: string; value: (row: T) => string };

export function rowsToCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  return Papa.unparse({
    fields: columns.map((c) => c.header),
    data: rows.map((row) => columns.map((c) => c.value(row))),
  });
}

export type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

// `header: true` gives each row as an object keyed by the file's own header
// row rather than a positional array, so a template column reorder by the
// user in a spreadsheet app doesn't break parsing. `skipEmptyLines` drops
// trailing blank rows spreadsheet exports commonly leave at EOF.
export function parseCsvText(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const headers = result.meta.fields ?? [];
  const rows = result.data.map((row) => {
    const trimmed: Record<string, string> = {};
    for (const key of headers) trimmed[key] = (row[key] ?? '').trim();
    return trimmed;
  });
  return { headers, rows };
}
