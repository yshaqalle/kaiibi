import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { read as readWorkbook, utils as xlsxUtils } from 'xlsx';

import { parseCsvText, type ParsedCsv } from '@/lib/csv';
import { shareCsv } from '@/lib/export-file';
import {
  downloadRejectedRowsCsv,
  missingRequiredColumns,
  templateCsvText,
  type ImportReport,
  type TemplateColumn,
} from '@/lib/import-shared';
import { AppModal } from '@/components/ui/app-modal';

const EXCEL_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // legacy .xls (also sometimes used for CSV -- extension wins if both match)
];
const PICKER_MIME_TYPES = ['text/csv', 'text/comma-separated-values', ...EXCEL_MIME_TYPES];

// Each entity (products/customers/sales) supplies its own column legend,
// example rows for the downloadable template, and a `run` function that's
// already bound to the current shop -- this component only drives the
// pick-file → parse → import → report flow, it knows nothing about Supabase.
export type ImportEntityConfig<T> = {
  title: string;
  filenamePrefix: string;
  templateColumns: TemplateColumn[];
  exampleRows: Record<string, string>[];
  run: (parsed: ParsedCsv) => Promise<ImportReport<T>>;
  // What one accepted `T` represents -- 'row' for products/customers, where
  // each accepted item is exactly one CSV row, but 'sale' for sales import,
  // where several rows (one per line item) collapse into a single accepted
  // sale. Rejections are always reported per-row regardless, since that's
  // what the "download rejected rows" file needs to match the original.
  unitLabel?: string;
};

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

function isExcelFile(name: string, mimeType: string | undefined): boolean {
  return /\.xlsx?$/i.test(name) || (mimeType != null && EXCEL_MIME_TYPES.includes(mimeType));
}

// A user who edits the downloaded template in Excel often ends up re-saving
// it as .xlsx instead of .csv -- rather than reject that, read the workbook
// and convert its first sheet to CSV text, then feed it through the exact
// same parseCsvText/validation path a real .csv file would take.
async function readPickedFileAsCsvText(uri: string, name: string, mimeType: string | undefined): Promise<string> {
  if (!isExcelFile(name, mimeType)) return readPickedFileText(uri);
  const bytes = await readPickedFileBytes(uri);
  const workbook = readWorkbook(bytes, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('That workbook has no sheets.');
  return xlsxUtils.sheet_to_csv(workbook.Sheets[firstSheetName]);
}

type Step = 'idle' | 'parsed' | 'importing' | 'done';

export function CsvImportModal<T>({ visible, onClose, config, onImported }: {
  visible: boolean;
  onClose: () => void;
  config: ImportEntityConfig<T>;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport<T> | null>(null);

  const reset = () => {
    setStep('idle');
    setFileName('');
    setParsed(null);
    setError(null);
    setReport(null);
  };
  const close = () => { reset(); onClose(); };

  const downloadTemplate = async () => {
    const content = templateCsvText(config.templateColumns, config.exampleRows);
    await shareCsv(content, `${config.filenamePrefix}-template.csv`, `${config.title} template`);
  };

  const pickFile = async () => {
    setError(null);
    setReport(null);
    const result = await DocumentPicker.getDocumentAsync({ type: PICKER_MIME_TYPES });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    try {
      const text = await readPickedFileAsCsvText(asset.uri, asset.name, asset.mimeType);
      const csv = parseCsvText(text);
      const missing = missingRequiredColumns(config.templateColumns, csv.headers);
      if (missing.length > 0) {
        setError(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.map((c) => c.header).join(', ')}.`);
        return;
      }
      if (csv.rows.length === 0) {
        setError('No rows found in that file.');
        return;
      }
      setFileName(asset.name);
      setParsed(csv);
      setStep('parsed');
    } catch (err) {
      setError(err instanceof Error && isExcelFile(asset.name, asset.mimeType) ? err.message : 'Could not read that file — make sure it is a .csv, .xlsx, or .xls file.');
    }
  };

  const runImport = async () => {
    if (!parsed) return;
    setStep('importing');
    try {
      const result = await config.run(parsed);
      setReport(result);
      setStep('done');
      // Unconditional, not `if (accepted.length > 0)`: a staff row whose member
      // is provisioned but whose pay write then fails is reported as *rejected*
      // -- correctly, since they exist and need attention -- so an import where
      // every pay write failed would otherwise create members and refresh
      // nothing. A wasted refetch after a fully-rejected import is harmless.
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
      setStep('parsed');
    }
  };

  const downloadRejected = async () => {
    if (!report || !parsed) return;
    await downloadRejectedRowsCsv(report.rejected, parsed.headers, `${config.filenamePrefix}-rejected.csv`);
  };

  if (!visible) return null;

  return (
    <AppModal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Import {config.title}</Text>
            <Pressable onPress={close} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.scroll}>
            <Text style={styles.sectionLabel}>COLUMNS</Text>
            <View style={styles.legend}>
              {config.templateColumns.map((c) => (
                <View key={c.header} style={styles.legendRow}>
                  <Text style={styles.legendHeader}>{c.header}</Text>
                  <Text style={c.required ? styles.legendRequired : styles.legendOptional}>{c.required ? 'Required' : 'Optional'}</Text>
                </View>
              ))}
            </View>
            <Pressable onPress={downloadTemplate} style={styles.linkButton}>
              <Text style={styles.linkButtonText}>Download example CSV</Text>
            </Pressable>

            <View style={styles.divider} />

            {step === 'idle' && (
              <Pressable onPress={pickFile} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>Choose CSV or Excel file</Text>
              </Pressable>
            )}

            {step === 'parsed' && parsed && (
              <>
                <Text style={styles.info}>{fileName}: {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} found.</Text>
                <Pressable onPress={runImport} style={styles.primaryButton}>
                  <Text style={styles.primaryButtonText}>Import {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'}</Text>
                </Pressable>
                <Pressable onPress={pickFile} style={styles.linkButton}>
                  <Text style={styles.linkButtonText}>Choose a different file</Text>
                </Pressable>
              </>
            )}

            {step === 'importing' && (
              <View style={styles.centered}>
                <ActivityIndicator />
                <Text style={styles.info}>Importing…</Text>
              </View>
            )}

            {step === 'done' && report && (
              <>
                <Text style={styles.resultSummary}>
                  Imported {report.accepted.length} {config.unitLabel ?? 'row'}{report.accepted.length === 1 ? '' : 's'}
                  {report.rejected.length > 0 ? `, ${report.rejected.length} row${report.rejected.length === 1 ? '' : 's'} rejected.` : '.'}
                </Text>
                {report.rejected.length > 0 && (
                  <>
                    <View style={styles.rejectedList}>
                      {report.rejected.map((r, i) => (
                        <View key={i} style={styles.rejectedRow}>
                          <Text style={styles.rejectedRowNumber}>Row {r.row}</Text>
                          <Text style={styles.rejectedReason}>{r.reason}</Text>
                        </View>
                      ))}
                    </View>
                    <Pressable onPress={downloadRejected} style={styles.linkButton}>
                      <Text style={styles.linkButtonText}>Download rejected rows</Text>
                    </Pressable>
                  </>
                )}
                <Pressable onPress={pickFile} style={styles.linkButton}>
                  <Text style={styles.linkButtonText}>Import another file</Text>
                </Pressable>
              </>
            )}

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, width: '100%', maxWidth: 460, height: '86%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  closeButton: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closeButtonText: { fontSize: 13, fontWeight: '700', color: '#111111' },

  scroll: { flex: 1 },
  sectionLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 8 },
  legend: { backgroundColor: '#F7F7F5', borderRadius: 10, padding: 12, gap: 6 },
  legendRow: { flexDirection: 'row', justifyContent: 'space-between' },
  legendHeader: { fontSize: 12, color: '#333333', fontWeight: '600' },
  legendRequired: { fontSize: 11, color: '#B3261E', fontWeight: '700' },
  legendOptional: { fontSize: 11, color: '#999999', fontWeight: '600' },

  divider: { borderTopWidth: 1, borderTopColor: '#EDEDED', marginVertical: 16 },

  primaryButton: { backgroundColor: '#111111', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  linkButton: { paddingVertical: 10, alignItems: 'center' },
  linkButtonText: { color: '#111111', fontWeight: '700', fontSize: 12, textDecorationLine: 'underline' },

  info: { fontSize: 13, color: '#333333', marginBottom: 10, textAlign: 'center' },
  centered: { alignItems: 'center', gap: 8, paddingVertical: 20 },

  resultSummary: { fontSize: 14, fontWeight: '800', color: '#111111', marginBottom: 12 },
  rejectedList: { gap: 8, marginBottom: 8 },
  rejectedRow: { backgroundColor: '#FBEAE9', borderRadius: 10, padding: 10 },
  rejectedRowNumber: { fontSize: 10, fontWeight: '800', color: '#B3261E', marginBottom: 2 },
  rejectedReason: { fontSize: 12, color: '#5C2A27' },

  error: { fontSize: 12, color: '#B3261E', marginTop: 10, textAlign: 'center' },
});
