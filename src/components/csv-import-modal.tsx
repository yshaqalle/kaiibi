import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { type ParsedCsv } from '@/lib/csv';
import { shareCsv } from '@/lib/export-file';
import {
  downloadRejectedRowsCsv,
  templateCsvText,
  type ImportReport,
  type TemplateColumn,
} from '@/lib/import-shared';
import { pickCsvFile } from '@/lib/pick-csv-file';
import { AppModal } from '@/components/ui/app-modal';

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
  // A line under the title saying what this import is FOR. Products need it:
  // shops were using it to stock a second store, which re-imports the same
  // units and inflates the count. Saying so up front is cheaper than a
  // rejection they read afterwards.
  purpose?: string;
  // An escape hatch to whatever the right tool is, offered both up front and
  // again on the rejection list, since that is where someone actually meets the
  // problem. Products point at Restock.
  elsewhere?: { label: string; onPress: () => void };
};

type Step = 'idle' | 'parsed' | 'importing' | 'done';

export function CsvImportModal<T>({ visible, onClose, config, onImported, onDismissed }: {
  visible: boolean;
  onClose: () => void;
  config: ImportEntityConfig<T>;
  onImported: () => void;
  // Fires once this sheet is actually off the screen (iOS only -- RN's
  // `onDismiss`). `config.elsewhere` hands over to another sheet, and iOS
  // silently drops a modal presented while this one is still up, so the handover
  // has to wait for this. See use-staged-sheet.ts.
  onDismissed?: () => void;
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
    const picked = await pickCsvFile(config.templateColumns);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    setFileName(picked.fileName);
    setParsed(picked.parsed);
    setStep('parsed');
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
    <AppModal visible transparent animationType="fade" onRequestClose={close} onDismiss={onDismissed}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Import {config.title}</Text>
            <Pressable onPress={close} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.scroll}>
            {config.purpose ? <Text style={styles.purpose}>{config.purpose}</Text> : null}
            {config.elsewhere ? (
              <Pressable
                onPress={() => {
                  close();
                  config.elsewhere!.onPress();
                }}
                style={styles.elsewhere}
              >
                <Text style={styles.elsewhereText}>{config.elsewhere.label} →</Text>
              </Pressable>
            ) : null}

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
                    {/* Offered again here, because this is where someone
                        actually meets the problem -- reading the reason on
                        every row is the moment the right tool is worth
                        naming, not the screen they skimmed on the way in. */}
                    {config.elsewhere ? (
                      <Pressable
                        onPress={() => {
                          close();
                          config.elsewhere!.onPress();
                        }}
                        style={styles.primaryButton}
                      >
                        <Text style={styles.primaryButtonText}>{config.elsewhere.label} →</Text>
                      </Pressable>
                    ) : null}
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
  purpose: { fontSize: 13, color: '#5E5D65', lineHeight: 19, marginBottom: 10 },
  elsewhere: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#DCDCE4', alignSelf: 'flex-start', marginBottom: 16 },
  elsewhereText: { color: '#111111', fontWeight: '800', fontSize: 12.5 },
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
