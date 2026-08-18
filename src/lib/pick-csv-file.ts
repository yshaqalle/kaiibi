import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { read as readWorkbook, utils as xlsxUtils } from 'xlsx';

import { parseCsvText, type ParsedCsv } from '@/lib/csv';
import { missingRequiredColumns, type TemplateColumn } from '@/lib/import-shared';

// Picking a spreadsheet and getting rows out of it, for every screen that takes
// one. Extracted from csv-import-modal so the move sheet reads a file exactly
// the way the product import does -- the .xlsx tolerance below is the sort of
// thing that gets rebuilt slightly differently the second time and then only
// half works.

const EXCEL_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // legacy .xls (also sometimes used for CSV -- extension wins if both match)
];
export const PICKER_MIME_TYPES = ['text/csv', 'text/comma-separated-values', ...EXCEL_MIME_TYPES];

// expo-file-system's `File` is a web no-op (see src/lib/storage.ts), so
// reading the picked file's text/bytes goes through fetch() on web instead,
// same split used there.
async function readPickedFileText(uri: string): Promise<string> {
  if (Platform.OS === 'web') return (await fetch(uri)).text();
  return new File(uri).text();
}

async function readPickedFileBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === 'web') return new Uint8Array(await (await fetch(uri)).arrayBuffer());
  return new File(uri).bytes();
}

export function isExcelFile(name: string, mimeType: string | undefined): boolean {
  return /\.xlsx?$/i.test(name) || (mimeType != null && EXCEL_MIME_TYPES.includes(mimeType));
}

// A user who edits the downloaded template in Excel often ends up re-saving
// it as .xlsx instead of .csv -- rather than reject that, read the workbook
// and convert its first sheet to CSV text, then feed it through the exact
// same parseCsvText/validation path a real .csv file would take.
export async function readPickedFileAsCsvText(uri: string, name: string, mimeType: string | undefined): Promise<string> {
  if (!isExcelFile(name, mimeType)) return readPickedFileText(uri);
  const bytes = await readPickedFileBytes(uri);
  const workbook = readWorkbook(bytes, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('That workbook has no sheets.');
  return xlsxUtils.sheet_to_csv(workbook.Sheets[firstSheetName]);
}

// Cancelled, refused, or read -- one result type, so a caller handles the three
// outcomes as a switch instead of as a null plus a thrown error plus a flag.
export type PickedCsv =
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
  | { status: 'ok'; fileName: string; parsed: ParsedCsv };

export async function pickCsvFile(templateColumns: TemplateColumn[]): Promise<PickedCsv> {
  const result = await DocumentPicker.getDocumentAsync({ type: PICKER_MIME_TYPES });
  if (result.canceled || !result.assets[0]) return { status: 'cancelled' };
  const asset = result.assets[0];
  try {
    const parsed = parseCsvText(await readPickedFileAsCsvText(asset.uri, asset.name, asset.mimeType));
    const missing = missingRequiredColumns(templateColumns, parsed.headers);
    if (missing.length > 0) {
      return {
        status: 'error',
        message: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.map((c) => c.header).join(', ')}.`,
      };
    }
    if (parsed.rows.length === 0) return { status: 'error', message: 'No rows found in that file.' };
    return { status: 'ok', fileName: asset.name, parsed };
  } catch (err) {
    return {
      status: 'error',
      // An .xlsx that failed to open says why (no sheets, corrupt); anything
      // else gets the generic line, since the underlying error is a parser
      // detail the shop cannot act on.
      message:
        err instanceof Error && isExcelFile(asset.name, asset.mimeType)
          ? err.message
          : 'Could not read that file — make sure it is a .csv, .xlsx, or .xls file.',
    };
  }
}
